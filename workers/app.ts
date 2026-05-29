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
import { app as apiApp, receiveEmail } from "./index";
import { EmailMCP } from "./mcp";
import { adminApp } from "./routes/admin";
import { bulkPage } from "./routes/bulk";
import {
	loginPage,
	handleLogin,
	handleLogout,
	landingPage,
} from "./routes/auth-pages";
import {
	verifySession,
	signSession,
	buildSessionCookie,
	readCookie,
	readBearerToken,
	hashToken,
	shouldRenewSession,
	cookieDomainFor,
	SESSION_COOKIE_NAME,
	type SessionClaims,
} from "./lib/auth";
import { getUserById, getUserByMcpTokenHash } from "./lib/users";
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

// ── MCP endpoint: per-user bearer-token auth, scoped via props (D-64) ──

const mcpHandler = EmailMCP.serve("/mcp", { binding: "EMAIL_MCP" });

async function handleMcp(c: Context<AppEnv>) {
	const token = readBearerToken(c.req.header("authorization"));
	if (!token) {
		return c.json({ error: "Missing bearer token" }, 401);
	}
	const user = await getUserByMcpTokenHash(c.env, await hashToken(token));
	if (!user || user.is_active !== 1) {
		return c.json({ error: "Invalid MCP token" }, 401);
	}
	// McpAgent.serve() reads ctx.props and exposes it to the DO as this.props.
	const ctx = c.executionCtx as ExecutionContext & { props?: unknown };
	ctx.props = {
		userId: user.id,
		role: user.role,
		mailbox: user.mailbox_address,
	};
	return mcpHandler.fetch(c.req.raw, c.env, ctx);
}

app.all("/mcp", handleMcp);
app.all("/mcp/*", handleMcp);

// ── Public auth pages (registered before the gate) ──

app.get("/login", loginPage);
app.post("/login", handleLogin);
app.post("/logout", handleLogout);
app.get("/landing", landingPage);

// ── Auth gate (cookie session) for everything else ──

app.use("*", async (c, next) => {
	const url = new URL(c.req.url);
	const path = url.pathname;
	const host = c.req.header("host") || url.host;

	if (path === "/mcp" || path.startsWith("/mcp/")) return next();
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

// ── Bulk send (mail merge) page — any authed rep, scoped to own mailbox ──
app.get("/bulk", bulkPage);

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

export default {
	fetch: app.fetch,
	async email(
		event: { raw: ReadableStream; rawSize: number },
		env: Env,
		ctx: ExecutionContext,
	) {
		try {
			await receiveEmail(event, env, ctx);
		} catch (e) {
			console.error(
				"Failed to process incoming email:",
				(e as Error).message,
				(e as Error).stack,
			);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce.
			throw e;
		}
	},
};
