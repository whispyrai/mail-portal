import type { Context } from "hono";
import { generateMcpToken, hashPassword, hashToken } from "../lib/auth.ts";
import { credentialRecoveryWorkflow } from "../lib/credential-recovery-runtime.ts";
import { recoveryRequestProcessor } from "../lib/recovery-request-runtime.ts";
import { escapeHtml } from "../lib/email-helpers.ts";
import type { Env } from "../types.ts";
import { pageShell, resolveBrand } from "./brand.ts";

type RecoveryContext = Context<{ Bindings: Env }>;

const GENERIC_RECOVERY_MESSAGE =
  "If the account is eligible, a secure recovery link will be sent to its configured external address.";

function recoveryPage(
  c: RecoveryContext,
  input: {
    token: string;
    error?: string;
    result?: { loginEmail: string; mcpToken?: string };
  },
) {
  const brand = resolveBrand(c.env.BRAND);
  if (input.result) {
    return pageShell(
      brand,
      `Access ready · ${brand.appName}`,
      `<div class="wrap--center">
		<div class="card card--auth"><h2>Credentials updated</h2>
		<p>Your sessions and previous MCP credential were revoked for ${escapeHtml(input.result.loginEmail)}.</p>
		${input.result.mcpToken ? `<p>Copy your new MCP token now. It will not be shown again.</p><p><code>${escapeHtml(input.result.mcpToken)}</code></p>` : ""}
		<a class="btn" href="/login">Sign in</a></div></div>`,
    );
  }
  return pageShell(
    brand,
    `Recover access · ${brand.appName}`,
    `<script>history.replaceState(null, "", "/account/recover");</script><div class="wrap--center">
		<div class="card card--auth"><h2>Set your credentials</h2>
		<p class="sub">This secure link is single-use and expires after 24 hours.</p>
		${input.error ? `<div class="err">${escapeHtml(input.error)}</div>` : ""}
		<form method="post" action="/account/recover">
		<input type="hidden" name="token" value="${escapeHtml(input.token)}">
		<label for="password">New password</label>
		<input id="password" name="password" type="password" minlength="12" required autocomplete="new-password">
		<label for="confirm">Confirm password</label>
		<input id="confirm" name="confirm" type="password" minlength="12" required autocomplete="new-password">
		<label><input name="createMcp" type="checkbox" value="yes"> Create a new MCP token for me</label>
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
		<div class="card card--auth"><h2>Recover your account</h2>
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

export async function handleCredentialRecovery(c: RecoveryContext) {
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
  const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
  const mcpToken = form.createMcp === "yes" ? generateMcpToken() : undefined;
  const consumed = await credentialRecoveryWorkflow(c.env).consume({
    token,
    passwordHash: hash,
    passwordSalt: salt,
    mcpTokenHash: mcpToken ? await hashToken(mcpToken) : null,
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
  return c.html(
    recoveryPage(c, {
      token: "",
      result: {
        loginEmail: consumed.loginEmail,
        ...(mcpToken ? { mcpToken } : {}),
      },
    }),
  );
}
