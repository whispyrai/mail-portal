// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Top-level Worker: routing + auth. Replaces upstream Agentic Inbox's Cloudflare
// Access gate with hand-rolled email+password sessions and per-mailbox / role
// authorization (locked-decisions D-20..25, D-62..64).

import { routeAgentRequest } from "agents";
import { Hono, type Context } from "hono";
import { createRequestHandler } from "react-router";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { app as apiApp } from "./index";
import { receiveEmail } from "./inbound-email";
import {
  processInboundBatch,
  processInboundDeadLetterBatch,
} from "./inbound-queue";
import { reconcileInboundArchives } from "./inbound-reconciliation";
import { EmailMCP } from "./mcp";
import { adminApp } from "./routes/admin";
import { bulkPage } from "./routes/bulk";
import { resolveBrand } from "./routes/brand";
import { quizApp } from "./quiz/rep-routes";
import {
  loginPage,
  handleLogin,
  handleLogout,
  landingPage,
} from "./routes/auth-pages";
import {
  authorizeGet,
  authorizePost,
  resolveLegacyBearer,
  MCP_SCOPES,
} from "./oauth/consent";
import {
  verifySession,
  signSession,
  buildSessionCookie,
  readCookie,
  shouldRenewSession,
  cookieDomainFor,
  SESSION_COOKIE_NAME,
  type SessionClaims,
} from "./lib/auth";
import { getUserById } from "./lib/users";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp";

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

type AppEnv = { Bindings: Env; Variables: { session?: SessionClaims } };
const app = new Hono<AppEnv>();

/** The mail app is served on the `mail.` subdomain (and localhost in dev). */
function isAppHost(host: string): boolean {
  const h = host.split(":")[0];
  return (
    h.startsWith("mail.") ||
    h.endsWith(".workers.dev") || // the deploy URL serves the app, not the landing
    h === "localhost" ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h)
  );
}

/** Paths that never require a session: auth pages and static assets. */
function isPublicPath(path: string): boolean {
  // API and agent routes are ALWAYS session-gated. Never treat them as public:
  // a mailbox id in the path is an email address ending in ".com", which would
  // otherwise match the static-asset extension heuristic below and silently skip
  // auth — leaving requireMailbox with no session and returning 401.
  if (path.startsWith("/api/") || path.startsWith("/agents/")) return false;
  return (
    path === "/login" ||
    path === "/logout" ||
    path === "/landing" ||
    path === "/favicon.ico" ||
    path === "/favicon.svg" ||
    path.startsWith("/assets/") ||
    /\.[a-z0-9]+$/i.test(path)
  );
}

// ── OAuth authorize endpoint + public auth pages (before the gate) ──
//
// /mcp is no longer handled here. It is wrapped by OAuthProvider (see the export at
// the bottom), which validates the access token, sets ctx.props from the grant, and
// forwards to EmailMCP.serve(). The legacy static bearer token still works via the
// provider's resolveExternalToken hook (resolveLegacyBearer in ./oauth/consent).
//
// /authorize is the one OAuth surface the provider delegates back to us — the
// consent UI. It sits in front of the session gate so it can run its own login
// bounce (D-20..25 session reused for OAuth consent).

app.get("/authorize", authorizeGet);
app.post("/authorize", authorizePost);

app.get("/login", loginPage);
app.post("/login", handleLogin);
app.post("/logout", handleLogout);
app.get("/landing", landingPage);

// ── Auth gate (cookie session) for everything else ──

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  const path = url.pathname;
  const host = c.req.header("host") || url.host;

  if (isPublicPath(path)) return next();
  if (path === "/" && !isAppHost(host)) return next(); // apex landing

  const respondUnauthorized = () =>
    path.startsWith("/api/") || path.startsWith("/agents/")
      ? c.json({ error: "Unauthorized" }, 401)
      : c.redirect("/login", 302);

  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE_NAME);
  const claims = token ? await verifySession(token, c.env.JWT_SECRET) : null;
  if (!claims) return respondUnauthorized();

  // Safety belt: confirm the user still exists and is active (enables
  // force-logout by deactivating the user). One cheap D1 read per request.
  const user = await getUserById(c.env, claims.sub);
  if (!user || user.is_active !== 1) return respondUnauthorized();

  c.set("session", claims);

  // Sliding renewal: refresh the cookie when it's within a day of expiry.
  const nowSec = Math.floor(Date.now() / 1000);
  if (shouldRenewSession(claims.exp, nowSec)) {
    const fresh = await signSession(
      {
        sub: claims.sub,
        email: claims.email,
        role: claims.role,
        mailbox: claims.mailbox,
      },
      c.env.JWT_SECRET,
    );
    c.header(
      "Set-Cookie",
      buildSessionCookie(fresh, {
        secure: url.protocol === "https:",
        domain: cookieDomainFor(host, c.env.DOMAINS),
      }),
    );
  }
  return next();
});

// ── Bulk send (mail merge) page — any authed user, scoped to own mailbox ──
app.get("/bulk", bulkPage);

// ── Quiz tool (any authed rep; role-gating for admin routes lives in adminApp) ──
app.route("/quizzes", quizApp);

// ── Admin console (ADMIN only; role enforced inside adminApp) ──
app.route("/admin", adminApp);

// ── API routes (per-mailbox authz enforced in requireMailbox) ──
app.route("/", apiApp);

// ── Agent WebSocket routing, scoped to the caller's mailbox ──
app.all("/agents/*", async (c) => {
  const session = c.get("session");
  // Agent instances are named by mailbox address: /agents/<class>/<name>/...
  const segs = new URL(c.req.url).pathname.split("/").filter(Boolean);
  const agentName = segs[2] ? decodeURIComponent(segs[2]) : "";
  if (
    session &&
    session.role !== "ADMIN" &&
    agentName &&
    agentName.toLowerCase() !== session.mailbox.toLowerCase()
  ) {
    return c.json({ error: "Forbidden" }, 403);
  }
  const response = await routeAgentRequest(c.req.raw, c.env);
  if (response) return response;
  return c.text("Agent not found", 404);
});

// ── Catch-all: apex landing page, otherwise the React SPA ──
app.all("*", (c) => {
  const host = c.req.header("host") || "";
  const path = new URL(c.req.url).pathname;
  if (path === "/" && !isAppHost(host)) return landingPage(c);
  return requestHandler(c.req.raw, {
    cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
  });
});

// ── OAuth-wrapped entrypoint ─────────────────────────────────────────
//
// OAuthProvider owns the OAuth surface: it serves the RFC 9728 / RFC 8414 discovery
// metadata, RFC 7591 dynamic client registration (/register), the /token endpoint,
// PKCE, and the 401 WWW-Authenticate challenge on /mcp. A /mcp request with a valid
// token is forwarded to EmailMCP.serve() with ctx.props set from the grant; every
// other request falls through to the Hono `app` (defaultHandler).

const oauthProvider = new OAuthProvider<Env>({
  apiHandlers: {
    "/mcp": EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" }),
  },
  defaultHandler: {
    fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
      app.fetch(request, env, ctx),
  },
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: MCP_SCOPES,
  // OAuth 2.1: S256-only PKCE (reject the legacy `plain` method).
  allowPlainPKCE: false,
  // Claude sends a path-aware resource (…/mcp) at token exchange while the metadata
  // advertises the origin; origin-only matching keeps the audiences consistent.
  resourceMatchOriginOnly: true,
  // Runtime discovery responses are rewritten per brand below. Keep the static
  // fallback neutral so a failed rewrite cannot leak one brand into another.
  resourceMetadata: { resource_name: "Mail Portal" },
  // Keep the admin-issued static bearer token working for CLI / non-OAuth clients.
  resolveExternalToken: resolveLegacyBearer,
});

/**
 * Best-effort connector branding. The OAuth discovery metadata is the most reliable
 * place a client may read a server logo from today, but the library exposes no
 * logo_uri option — so inject one into the well-known documents on the way out.
 * Harmless to spec-compliant clients (unknown fields are ignored).
 */
async function fetchWithBranding(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const res = await oauthProvider.fetch(request, env, ctx);
  const path = new URL(request.url).pathname;
  // Match both the bare docs and the RFC-9728 path-aware variant Claude actually
  // fetches (/.well-known/oauth-protected-resource/mcp).
  if (
    res.ok &&
    (path.startsWith("/.well-known/oauth-authorization-server") ||
      path.startsWith("/.well-known/oauth-protected-resource"))
  ) {
    try {
      const metadata: unknown = await res.clone().json();
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        return res;
      // The static resourceMetadata below is set at module load (no env); rewrite
      // the resource_name per brand so a Wiser deploy doesn't advertise "Whispyr Mail".
      const brand = resolveBrand(env.BRAND);
      const brandedMetadata = {
        ...metadata,
        logo_uri: `${new URL(request.url).origin}${brand.pwaIcon512}`,
        resource_name: brand.appName,
      };
      const headers = new Headers(res.headers);
      headers.delete("content-length");
      return new Response(JSON.stringify(brandedMetadata), {
        status: res.status,
        headers,
      });
    } catch {
      return res;
    }
  }
  return res;
}

export default {
  fetch: fetchWithBranding,
  async email(event: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    try {
      await receiveEmail(event, env, ctx);
    } catch (error) {
      console.error("[mail-ingress] handler failed", {
        errorCode: "INGRESS_HANDLER_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        operation: "email_handler",
        status: "failed",
      });
      throw error;
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    if (
      batch.queue === env.INBOUND_DLQ_NAME ||
      batch.queue === env.INBOUND_PARKING_NAME
    ) {
      if (batch.queue === env.INBOUND_PARKING_NAME) {
        console.error("[mail-projection] parking Queue delivery received", {
          batchSize: batch.messages.length,
          errorCode: "INBOUND_PARKING_DELIVERY",
          operation: "parking_queue_consume",
          queue: batch.queue,
          status: "recovering",
        });
      }
      await processInboundDeadLetterBatch(batch, env);
      return;
    }
    await processInboundBatch(batch, env);
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    const startedAt = Date.now();
    try {
      const result = await reconcileInboundArchives(env);
      console.log("[mail-reconciliation] run completed", {
        ...result,
        durationMs: Date.now() - startedAt,
        operation: "archive_reconcile_run",
        status:
          result.failed > 0 ||
          result.invalid > 0 ||
          result.pendingReview > 0 ||
          result.projectionMissing > 0
            ? "degraded"
            : "succeeded",
      });
    } catch (error) {
      console.error("[mail-reconciliation] run failed", {
        durationMs: Date.now() - startedAt,
        errorCode: "RECONCILIATION_RUN_FAILED",
        errorMessage: error instanceof Error ? error.message : String(error),
        operation: "archive_reconcile_run",
        status: "failed",
      });
      throw error;
    }
  },
};
