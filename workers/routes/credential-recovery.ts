import type { Context } from "hono";
import { generateMcpToken, hashPassword, hashToken } from "../lib/auth.ts";
import { credentialRecoveryWorkflow } from "../lib/credential-recovery-runtime.ts";
import { recoveryRequestProcessor } from "../lib/recovery-request-runtime.ts";
import { escapeHtml } from "../lib/email-helpers.ts";
import type { Env } from "../types.ts";
import { brandLogo, pageShell, resolveBrand } from "./brand.ts";
import { requireAgentConnectionReconciliation } from "../lib/agent-connection-revocation-outbox.ts";

type RecoveryContext = Context<{ Bindings: Env }>;

export type CredentialRecoveryHandlerDependencies = {
  hashPassword: typeof hashPassword;
  generateMcpToken: typeof generateMcpToken;
  hashToken: typeof hashToken;
  consume(
    env: Env,
    input: {
      token: string;
      passwordHash: string;
      passwordSalt: string;
      mcpTokenHash: string | null;
    },
  ): Promise<{
    userId: string;
    loginEmail: string;
    outcome: "claimed" | "recovered";
  } | null>;
  reconcileAgentConnections(env: Env, userId: string): Promise<void>;
  reportAgentReconciliation(input: {
    actorUserId: string;
    durationMs: number;
    status: "success" | "partial_success";
    httpStatus: 200 | 202;
    errorName?: string;
  }): void;
};

const productionDependencies: CredentialRecoveryHandlerDependencies = {
  hashPassword,
  generateMcpToken,
  hashToken,
  consume(env, input) {
    return credentialRecoveryWorkflow(env).consume(input);
  },
  reconcileAgentConnections(env, userId) {
    return requireAgentConnectionReconciliation(env, {
      userId,
      scope: "ACTOR",
    });
  },
  reportAgentReconciliation(input) {
    const event = {
      operation: "credential_recovery",
      route: "/account/recover",
      phase: "agent_connection_reconciliation",
      target: "email_agent",
      ...input,
    };
    if (input.status === "success") {
      console.info("[credential-recovery] connection cleanup complete", event);
    } else {
      console.error("[credential-recovery] connection cleanup pending", event);
    }
  },
};

const GENERIC_RECOVERY_MESSAGE =
  "If the account is eligible, a secure recovery link will be sent to its configured external address.";

function safeErrorName(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
    ? error.name
    : "UnknownError";
}

function recoveryPage(
  c: RecoveryContext,
  input: {
    token: string;
    error?: string;
    result?: {
      loginEmail: string;
      mcpToken?: string;
      connectionCleanup: "complete" | "pending";
    };
  },
) {
  const brand = resolveBrand(c.env.BRAND);
  if (input.result) {
    return pageShell(
      brand,
      `Access ready · ${brand.appName}`,
      `<div class="wrap--center">
			<div class="card card--auth">${brandLogo(brand, { href: "/login" })}<h2 class="auth-heading">Credentials updated</h2>
			<p>Your new credentials are active for ${escapeHtml(input.result.loginEmail)}. Existing sign-in sessions and the previous MCP credential are no longer valid.</p>
			${input.result.mcpToken ? `<p>Copy your new MCP token now. It will not be shown again.</p><code class="credential-token">${escapeHtml(input.result.mcpToken)}</code>` : ""}
			${input.result.connectionCleanup === "pending" ? `<div class="flash warn" role="status"><strong>Connection cleanup is still finishing.</strong><br>Existing mail-assistant connections are being closed. Cleanup will retry automatically. Close any other portal tabs now. Do not refresh or submit this recovery link again.</div>` : `<div class="flash ok" role="status">Existing mail-assistant connections were closed.</div>`}
			<a class="btn" href="/login">Sign in normally</a></div></div>`,
    );
  }
  return pageShell(
    brand,
    `Recover access · ${brand.appName}`,
    `<script>history.replaceState(null, "", "/account/recover");</script><div class="wrap--center">
			<div class="card card--auth">${brandLogo(brand, { href: "/login" })}<h2 class="auth-heading">Set your credentials</h2>
		<p class="sub">This secure link is single-use and expires after 24 hours.</p>
		${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
		<form method="post" action="/account/recover">
		<input type="hidden" name="token" value="${escapeHtml(input.token)}">
		<label for="password">New password</label>
		<input id="password" name="password" type="password" minlength="12" required autocomplete="new-password">
		<label for="confirm">Confirm password</label>
		<input id="confirm" name="confirm" type="password" minlength="12" required autocomplete="new-password">
		<label class="checkbox-label"><input name="createMcp" type="checkbox" value="yes"> <span>Create a new MCP token for me</span></label>
		<button type="submit" class="block">Set credentials</button>
		</form></div></div>`,
  );
}

export function credentialRecoveryPage(c: RecoveryContext) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  const token = c.req.query("token")?.trim() ?? "";
  return c.html(
    recoveryPage(c, {
      token,
      ...(token ? {} : { error: "This recovery link is incomplete." }),
    }),
  );
}

function recoveryRequestPage(c: RecoveryContext, submitted = false) {
  const brand = resolveBrand(c.env.BRAND);
  return pageShell(
    brand,
    `Request recovery · ${brand.appName}`,
    `<div class="wrap--center">
			<div class="card card--auth">${brandLogo(brand, { href: "/login" })}<h2 class="auth-heading">Recover your account</h2>
		${submitted ? `<div class="flash ok" role="status">${GENERIC_RECOVERY_MESSAGE}</div>` : `<p class="sub">Enter your portal sign-in email. We never reveal whether an account or recovery address exists.</p>`}
		<form method="post" action="/account/recover/request">
		<label for="email">Portal email</label>
		<input id="email" name="email" type="email" required autocomplete="username" autocapitalize="off">
		<button type="submit" class="block">Request secure link</button>
		</form><p class="note"><a href="/login">Back to sign in</a></p></div></div>`,
  );
}

export function credentialRecoveryRequestPage(c: RecoveryContext) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  return c.html(recoveryRequestPage(c));
}

export async function handleCredentialRecoveryRequest(c: RecoveryContext) {
  c.header("Referrer-Policy", "no-referrer");
  c.header("Cache-Control", "no-store");
  const form = await c.req.parseBody();
  const email = String(form.email ?? "");
  const ip = c.req.header("cf-connecting-ip") || "unknown";
  const origin = new URL(c.req.url).origin;
  // Keep the public response generic and timing-stable. All lookup, throttling,
  // directory resolution, and delivery happens after the response is ready.
  c.executionCtx.waitUntil(
    recoveryRequestProcessor(c.env)
      .process({ email, ip, origin })
      .catch(() => undefined),
  );
  return c.html(recoveryRequestPage(c, true));
}

export function createCredentialRecoveryHandler(
  dependencies: CredentialRecoveryHandlerDependencies = productionDependencies,
) {
  return async function handleCredentialRecovery(c: RecoveryContext) {
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    const form = await c.req.parseBody();
    const token = String(form.token ?? "").trim();
    const password = String(form.password ?? "");
    const confirm = String(form.confirm ?? "");
    if (!token || password.length < 12 || password !== confirm) {
      return c.html(
        recoveryPage(c, {
          token,
          error:
            password !== confirm
              ? "Passwords do not match."
              : "Use a password of at least 12 characters.",
        }),
        400,
      );
    }
    const { hash, salt } = await dependencies.hashPassword(
      password,
      c.env.JWT_SECRET,
    );
    const mcpToken =
      form.createMcp === "yes" ? dependencies.generateMcpToken() : undefined;
    const consumed = await dependencies.consume(c.env, {
      token,
      passwordHash: hash,
      passwordSalt: salt,
      mcpTokenHash: mcpToken
        ? await dependencies.hashToken(mcpToken)
        : null,
    });
    if (!consumed) {
      return c.html(
        recoveryPage(c, {
          token: "",
          error:
            "This recovery link is invalid, expired, or has already been used.",
        }),
        409,
      );
    }

    let reconciliationPending = false;
    let reconciliationErrorName: string | undefined;
    const reconciliationStartedAt = Date.now();
    try {
      await dependencies.reconcileAgentConnections(c.env, consumed.userId);
    } catch (error) {
      reconciliationPending = true;
      reconciliationErrorName = safeErrorName(error);
    }
    const reconciliationStatus: "success" | "partial_success" = reconciliationPending
      ? "partial_success"
      : "success";
    const reconciliationHttpStatus: 200 | 202 = reconciliationPending ? 202 : 200;
    const reconciliationReport = {
      actorUserId: consumed.userId,
      durationMs: Math.max(0, Date.now() - reconciliationStartedAt),
      status: reconciliationStatus,
      httpStatus: reconciliationHttpStatus,
      ...(reconciliationErrorName
        ? { errorName: reconciliationErrorName }
        : {}),
    };
    try {
      dependencies.reportAgentReconciliation(reconciliationReport);
    } catch {
      // Credentials are already committed. Observability must never hide the
      // single-display MCP token or turn the authoritative result into a 500.
    }

    return c.html(
      recoveryPage(c, {
        token: "",
        result: {
          loginEmail: consumed.loginEmail,
          ...(mcpToken ? { mcpToken } : {}),
          connectionCleanup: reconciliationPending ? "pending" : "complete",
        },
      }),
      reconciliationPending ? 202 : 200,
    );
  };
}

export const handleCredentialRecovery = createCredentialRecoveryHandler();
