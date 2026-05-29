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
import { pageShell, brandLogo } from "./brand";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

function renderLogin(opts: { error?: string; bootstrap?: boolean } = {}): string {
	const errorBlock = opts.error ? `<div class="err">${opts.error}</div>` : "";
	const heading = opts.bootstrap ? "Create the first admin" : "Sign in";
	const sub = opts.bootstrap
		? "No users exist yet. Sign in with the bootstrap email to create the admin account."
		: "Whispyr sales mail portal";
	return pageShell(
		"Sign in · Whispyr Mail",
		`<div class="wrap--center">
  <div class="card card--auth">
    ${brandLogo({ href: "/login" })}
    <p class="sub" style="margin-top:18px">${sub}</p>
    <h2>${heading}</h2>
    ${errorBlock}
    <form method="post" action="/login" autocomplete="off">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocapitalize="off" spellcheck="false" placeholder="you@whispyrcrm.com">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required placeholder="••••••••••••">
      <button type="submit" class="block">${opts.bootstrap ? "Create admin & sign in" : "Sign in"}</button>
    </form>
    <p class="note">Whispyr sales team only.</p>
  </div>
</div>`,
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
	return c.html(
		pageShell(
			"Whispyr Mail",
			`<div class="wrap--center" style="text-align:center">
  ${brandLogo({ href: "https://whispyrai.com" })}
  <p class="sub" style="max-width:520px;font-size:17px;line-height:1.6;margin-top:22px">
    This is the outreach mail domain for the <strong>Whispyr</strong> sales team. Whispyr is an
    AI-powered sales platform that helps real estate teams close more deals with WhatsApp,
    AI lead scoring, and automated outreach.
  </p>
  <div class="row" style="margin-top:28px;justify-content:center">
    <a class="btn" href="https://whispyrai.com">Visit whispyrai.com</a>
    <a class="btn secondary" href="/login">Team sign in</a>
  </div>
  <p class="note" style="margin-top:40px">© Whispyr</p>
</div>`,
		),
	);
}
