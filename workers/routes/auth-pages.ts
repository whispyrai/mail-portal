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
import { systemPromptFor } from "../lib/prompts";
import { escapeHtml } from "../lib/email-helpers";
import { safeAuthorizeReturnTo } from "../lib/auth";
import { pageShell, brandLogo, resolveBrand, type BrandConfig } from "./brand";
import type { Env } from "../types";

type Ctx = Context<{ Bindings: Env; Variables: { session?: SessionClaims } }>;

function renderLogin(
	brand: BrandConfig,
	opts: { error?: string; bootstrap?: boolean; returnTo?: string | null } = {},
): string {
	const errorBlock = opts.error ? `<div class="err">${opts.error}</div>` : "";
	const heading = opts.bootstrap ? "Create the first admin" : "Sign in";
	const sub = opts.bootstrap
		? "No users exist yet. Sign in with the bootstrap email to create the admin account."
		: brand.loginTagline;
	// Carried through login so an OAuth connect flow resumes at /authorize afterward.
	const returnToField = opts.returnTo
		? `<input type="hidden" name="returnTo" value="${escapeHtml(opts.returnTo)}">`
		: "";
	return pageShell(
		brand,
		`Sign in · ${brand.appName}`,
		`<div class="wrap--center">
  <div class="card card--auth">
    ${brandLogo(brand, { href: "/login" })}
    <p class="sub" style="margin-top:18px">${sub}</p>
    <h2>${heading}</h2>
    ${errorBlock}
    <form method="post" action="/login" autocomplete="off">
      ${returnToField}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required autocapitalize="off" spellcheck="false" placeholder="you@${brand.mailDomain}">
      <label for="password">Password</label>
      <input id="password" name="password" type="password" required placeholder="••••••••••••">
      <button type="submit" class="block">${opts.bootstrap ? "Create admin & sign in" : "Sign in"}</button>
    </form>
    <p class="note">${brand.loginNote}</p>
  </div>
</div>`,
	);
}

export async function loginPage(c: Ctx) {
	const bootstrap =
		(await countUsers(c.env)) === 0 && Boolean(c.env.ADMIN_BOOTSTRAP_EMAIL);
	const returnTo = safeAuthorizeReturnTo(c.req.query("returnTo"));
	return c.html(renderLogin(resolveBrand(c.env.BRAND), { bootstrap, returnTo }));
}

export async function handleLogin(c: Ctx) {
	const brand = resolveBrand(c.env.BRAND);
	const form = await c.req.parseBody();
	const email = String(form.email || "").trim().toLowerCase();
	const password = String(form.password || "");
	const returnTo = safeAuthorizeReturnTo(String(form.returnTo || ""));
	const url = new URL(c.req.url);
	const host = c.req.header("host") || url.host;
	const secure = url.protocol === "https:";
	const domain = cookieDomainFor(host, c.env.DOMAINS);

	if (!email || !password) {
		return c.html(
			renderLogin(brand, { error: "Email and password are required.", returnTo }),
			400,
		);
	}

	let user = await getUserByEmail(c.env, email);

	// Bootstrap: with zero users, the configured bootstrap email self-provisions
	// the first ADMIN account (and its mailbox) on first login.
	if (!user && c.env.ADMIN_BOOTSTRAP_EMAIL) {
		const total = await countUsers(c.env);
		if (total === 0 && email === c.env.ADMIN_BOOTSTRAP_EMAIL.toLowerCase()) {
			if (password.length < 12) {
				return c.html(
					renderLogin(brand, {
						error: "Choose a password of at least 12 characters.",
						bootstrap: true,
						returnTo,
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
				agentSystemPrompt: systemPromptFor(brand.id),
			});
		}
	}

	if (!user || user.is_active !== 1) {
		return c.html(
			renderLogin(brand, { error: "Invalid email or password.", returnTo }),
			401,
		);
	}
	const ok = await verifyPassword(password, user.password_salt, user.password_hash, c.env.JWT_SECRET);
	if (!ok) {
		return c.html(
			renderLogin(brand, { error: "Invalid email or password.", returnTo }),
			401,
		);
	}

	const jwt = await signSession(
		{ sub: user.id, email: user.email, role: user.role, mailbox: user.mailbox_address },
		c.env.JWT_SECRET,
	);
	c.header("Set-Cookie", buildSessionCookie(jwt, { secure, domain }));
	// Resume an OAuth connect flow if we came from /authorize; otherwise the inbox.
	return c.redirect(returnTo ?? "/", 302);
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
	const brand = resolveBrand(c.env.BRAND);
	const websiteLabel = brand.websiteUrl.replace(/^https?:\/\//, "");
	return c.html(
		pageShell(
			brand,
			brand.appName,
			`<div class="wrap--center" style="text-align:center">
  ${brandLogo(brand, { href: brand.websiteUrl })}
  <p class="sub" style="max-width:520px;font-size:17px;line-height:1.6;margin-top:22px">
    ${brand.landingBlurb}
  </p>
  <div class="row" style="margin-top:28px;justify-content:center">
    <a class="btn" href="${brand.websiteUrl}">Visit ${websiteLabel}</a>
    <a class="btn secondary" href="/login">Team sign in</a>
  </div>
  <p class="note" style="margin-top:40px">© ${brand.name}</p>
</div>`,
		),
	);
}
