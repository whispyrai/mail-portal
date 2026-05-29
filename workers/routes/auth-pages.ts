// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Public, Worker-rendered pages: the apex landing page and the login flow.
// Kept out of the React SPA so they sit cleanly in front of the auth gate.

import type { Context } from "hono";
import {
	hashPassword,
	verifyPassword,
	signSession,
	buildSessionCookie,
	clearSessionCookie,
	cookieDomainFor,
	type SessionClaims,
} from "../lib/auth";
import { getUserByEmail, countUsers, createUser } from "../lib/users";
import { provisionMailbox } from "../lib/mailbox";
import { WHISPYR_SYSTEM_PROMPT } from "../lib/whispyr-prompt";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

const PAGE_CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: #0b1020; color: #e7ecf5; -webkit-font-smoothing: antialiased; }
a { color: #6ea8fe; }
.wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
.card { width: 100%; max-width: 400px; background: #141b2e; border: 1px solid #243049; border-radius: 16px;
  padding: 32px; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
.brand { font-size: 22px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 4px; }
.brand span { color: #6ea8fe; }
.sub { margin: 0 0 24px; color: #9aa7c2; font-size: 14px; }
label { display: block; font-size: 13px; color: #c4cfe6; margin: 14px 0 6px; }
input { width: 100%; padding: 11px 13px; border-radius: 10px; border: 1px solid #2c3958; background: #0e1626;
  color: #e7ecf5; font-size: 15px; }
input:focus { outline: none; border-color: #6ea8fe; }
button { width: 100%; margin-top: 22px; padding: 12px; border: 0; border-radius: 10px; background: #3b82f6;
  color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
button:hover { background: #2f6fe0; }
.err { background: #3a1620; border: 1px solid #6b2235; color: #ffb3c1; padding: 10px 12px; border-radius: 10px;
  font-size: 13px; margin-bottom: 8px; }
.note { color: #8595b5; font-size: 12px; margin-top: 16px; text-align: center; }
`;

function htmlShell(title: string, body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
}

function renderLogin(opts: { error?: string; bootstrap?: boolean } = {}): string {
	const errorBlock = opts.error ? `<div class="err">${opts.error}</div>` : "";
	const heading = opts.bootstrap ? "Create the first admin" : "Sign in";
	const sub = opts.bootstrap
		? "No users exist yet. Sign in with the bootstrap email to create the admin account."
		: "Whispyr sales mail portal";
	return htmlShell(
		"Sign in · Whispyr Mail",
		`<div class="wrap"><div class="card">
  <h1 class="brand">Whispyr<span>·</span>Mail</h1>
  <p class="sub">${sub}</p>
  <h2 style="font-size:16px;margin:0 0 12px">${heading}</h2>
  ${errorBlock}
  <form method="post" action="/login" autocomplete="off">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocapitalize="off" spellcheck="false" placeholder="you@whispyrcrm.com">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required placeholder="••••••••••••">
    <button type="submit">${opts.bootstrap ? "Create admin & sign in" : "Sign in"}</button>
  </form>
  <p class="note">Whispyr sales team only.</p>
</div></div>`,
	);
}

export async function loginPage(c: Ctx) {
	const bootstrap =
		(await countUsers(c.env)) === 0 && Boolean(c.env.ADMIN_BOOTSTRAP_EMAIL);
	return c.html(renderLogin({ bootstrap }));
}

export async function handleLogin(c: Ctx) {
	const form = await c.req.parseBody();
	const email = String(form.email || "").trim().toLowerCase();
	const password = String(form.password || "");
	const url = new URL(c.req.url);
	const host = c.req.header("host") || url.host;
	const secure = url.protocol === "https:";
	const domain = cookieDomainFor(host, c.env.DOMAINS);

	if (!email || !password) {
		return c.html(renderLogin({ error: "Email and password are required." }), 400);
	}

	let user = await getUserByEmail(c.env, email);

	// Bootstrap: with zero users, the configured bootstrap email self-provisions
	// the first ADMIN account (and its mailbox) on first login.
	if (!user && c.env.ADMIN_BOOTSTRAP_EMAIL) {
		const total = await countUsers(c.env);
		if (total === 0 && email === c.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()) {
			if (password.length < 12) {
				return c.html(
					renderLogin({
						error: "Choose a password of at least 12 characters.",
						bootstrap: true,
					}),
					400,
				);
			}
			const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
			user = await createUser(c.env, {
				email,
				passwordHash: hash,
				passwordSalt: salt,
				role: "ADMIN",
				mailboxAddress: email,
			});
			await provisionMailbox(c.env, email, email.split("@")[0], {
				agentSystemPrompt: WHISPYR_SYSTEM_PROMPT,
			});
		}
	}

	if (!user || user.is_active !== 1) {
		return c.html(renderLogin({ error: "Invalid email or password." }), 401);
	}
	const ok = await verifyPassword(password, user.password_salt, user.password_hash, c.env.JWT_SECRET);
	if (!ok) {
		return c.html(renderLogin({ error: "Invalid email or password." }), 401);
	}

	const jwt = await signSession(
		{ sub: user.id, email: user.email, role: user.role, mailbox: user.mailbox_address },
		c.env.JWT_SECRET,
	);
	c.header("Set-Cookie", buildSessionCookie(jwt, { secure, domain }));
	return c.redirect("/", 302);
}

export async function handleLogout(c: Ctx) {
	const url = new URL(c.req.url);
	const host = c.req.header("host") || url.host;
	c.header(
		"Set-Cookie",
		clearSessionCookie({
			secure: url.protocol === "https:",
			domain: cookieDomainFor(host, c.env.DOMAINS),
		}),
	);
	return c.redirect("/login", 302);
}

// ── Landing page (apex, public) ────────────────────────────────────

export function landingPage(c: Ctx) {
	const body = `<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px">
  <h1 class="brand" style="font-size:40px">Whispyr<span>·</span>Mail</h1>
  <p class="sub" style="max-width:520px;font-size:17px;line-height:1.6">
    This is the outreach mail domain for the <strong>Whispyr</strong> sales team. Whispyr is an
    AI-powered sales platform that helps real estate teams close more deals with WhatsApp,
    AI lead scoring, and automated outreach.
  </p>
  <div style="margin-top:28px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center">
    <a href="https://whispyrai.com" style="background:#3b82f6;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Visit whispyrai.com</a>
    <a href="/login" style="border:1px solid #2c3958;color:#e7ecf5;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Team sign in</a>
  </div>
  <p class="note" style="margin-top:40px">© Whispyr</p>
</div>`;
	return c.html(htmlShell("Whispyr Mail", `<style>${PAGE_CSS}</style>${body}`));
}
