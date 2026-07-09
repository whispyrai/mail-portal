// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Admin console (ADMIN role only): create reps with manually-set passwords and
// roles, activate/deactivate, reset passwords, and issue per-user MCP tokens.
// Worker-rendered HTML (no React) — locked-decisions D-23, D-62, D-64.

import { Hono } from "hono";
import { USER_ROLES, type UserRole } from "../db/users-schema";
import {
	listUsers,
	getUserById,
	getUserByEmail,
	createUser,
	setUserActive,
	updateUserPassword,
	setUserMcpTokenHash,
} from "../lib/users";
import {
	hashPassword,
	generateMcpToken,
	hashToken,
	type SessionClaims,
} from "../lib/auth";
import { provisionMailbox } from "../lib/mailbox";
import { systemPromptFor } from "../lib/prompts";
import { escapeHtml } from "../lib/email-helpers";
import { pageShell, brandLogo, resolveBrand, type BrandConfig } from "./brand";
import { adminQuizApp } from "../quiz/admin-routes";
import type { Env } from "../types";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

function shell(brand: BrandConfig, body: string): string {
	return pageShell(brand, `Admin · ${brand.appName}`, `<div class="wrap">${body}</div>`);
}

function mcpBaseUrl(c: { req: { url: string }; env: Env }): string {
	const root = (c.env.DOMAINS || "").split(",")[0]?.trim();
	if (root) return `https://mail.${root}/mcp`;
	return `${new URL(c.req.url).origin}/mcp`;
}

const adminApp = new Hono<AdminEnv>();

// Gate: ADMIN only (the app-level gate already guarantees a valid session).
adminApp.use("*", async (c, next) => {
	const session = c.get("session");
	if (!session) return c.redirect("/login", 302);
	if (session.role !== "ADMIN") return c.text("Forbidden", 403);
	return next();
});

// Quiz admin console (open/close, edit questions, grade, results, seed). Mounted
// inside adminApp so it inherits the ADMIN-only guard above.
adminApp.route("/quizzes", adminQuizApp);

adminApp.get("/users", async (c) => {
	const brand = resolveBrand(c.env.BRAND);
	const users = await listUsers(c.env);
	const flash = c.req.query("ok")
		? `<div class="flash ok">${escapeHtml(c.req.query("ok")!)}</div>`
		: c.req.query("err")
			? `<div class="flash err">${escapeHtml(c.req.query("err")!)}</div>`
			: "";

	const rows = users
		.sort((a, b) => a.email.localeCompare(b.email))
		.map((u) => {
			const roleBadge =
				u.role === "ADMIN"
					? `<span class="badge admin">ADMIN</span>`
					: `<span class="badge">AGENT</span>`;
			const status =
				u.is_active === 1
					? `<form class="inline" method="post" action="/admin/users/${u.id}/deactivate"><button class="sm" type="submit">Deactivate</button></form>`
					: `<span class="badge off">inactive</span> <form class="inline" method="post" action="/admin/users/${u.id}/activate"><button class="sm" type="submit">Activate</button></form>`;
			return `<tr>
        <td>${escapeHtml(u.email)} ${roleBadge}</td>
        <td>${escapeHtml(u.mailbox_address)}</td>
        <td>${u.mcp_token_hash ? "set" : "—"}</td>
        <td>${status}
          <form class="inline" method="post" action="/admin/users/${u.id}/mcp-token"><button class="sm" type="submit">Rotate MCP token</button></form>
        </td>
      </tr>
      <tr><td colspan="4">
        <form method="post" action="/admin/users/${u.id}/password" class="row" style="align-items:flex-end">
          <div><label>Reset password for ${escapeHtml(u.email)}</label>
            <input name="password" type="text" minlength="12" placeholder="new password (min 12 chars)" required></div>
          <div style="flex:0"><button class="sm" type="submit">Set password</button></div>
        </form>
      </td></tr>`;
		})
		.join("");

	return c.html(
		shell(brand, `
  <div class="brandbar">${brandLogo(brand, { href: "/" })}
    <form class="inline" method="post" action="/logout"><button class="sm secondary" type="submit">Sign out</button></form></div>
  <h1 style="margin-top:14px">User administration</h1>
  ${flash}
  <div class="card">
    <h2 style="font-size:16px;margin-top:0">Create a user</h2>
    <form method="post" action="/admin/users">
      <div class="row">
        <div><label>Email</label><input name="email" type="email" placeholder="kareem@${brand.mailDomain}" required></div>
        <div><label>Display name</label><input name="name" type="text" placeholder="Kareem Hatem"></div>
      </div>
      <div class="row">
        <div><label>Password (you set it; min 12 chars)</label><input name="password" type="text" minlength="12" required></div>
        <div><label>Role</label><select name="role">${USER_ROLES.map((r) => `<option value="${r}">${r}</option>`).join("")}</select></div>
      </div>
      <button type="submit">Create user &amp; mailbox</button>
    </form>
  </div>
  <div class="card">
    <h2 style="font-size:16px;margin-top:0">Users</h2>
    <div class="tablewrap"><table><thead><tr><th>User</th><th>Mailbox</th><th>MCP</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">No users yet.</td></tr>`}</tbody></table></div>
  </div>`),
	);
});

adminApp.post("/users", async (c) => {
	const form = await c.req.parseBody();
	const email = String(form.email || "").trim().toLowerCase();
	const name = String(form.name || "").trim() || email.split("@")[0];
	const password = String(form.password || "");
	const roleRaw = String(form.role || "AGENT");
	const role: UserRole = roleRaw === "ADMIN" ? "ADMIN" : "AGENT";

	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
		return c.redirect(`/admin/users?err=${encodeURIComponent("Invalid email address.")}`, 302);
	}
	if (password.length < 12) {
		return c.redirect(`/admin/users?err=${encodeURIComponent("Password must be at least 12 characters.")}`, 302);
	}
	if (await getUserByEmail(c.env, email)) {
		return c.redirect(`/admin/users?err=${encodeURIComponent("A user with that email already exists.")}`, 302);
	}

	const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
	await createUser(c.env, {
		email,
		passwordHash: hash,
		passwordSalt: salt,
		role,
		mailboxAddress: email,
	});
	// Provision the mailbox and seed the Whispyr AI context (D-43).
	await provisionMailbox(c.env, email, name, { agentSystemPrompt: systemPromptFor(resolveBrand(c.env.BRAND).id) });

	return c.redirect(`/admin/users?ok=${encodeURIComponent(`Created ${email} (${role}).`)}`, 302);
});

adminApp.post("/users/:id/deactivate", async (c) => {
	await setUserActive(c.env, c.req.param("id"), false);
	return c.redirect(`/admin/users?ok=${encodeURIComponent("User deactivated.")}`, 302);
});

adminApp.post("/users/:id/activate", async (c) => {
	await setUserActive(c.env, c.req.param("id"), true);
	return c.redirect(`/admin/users?ok=${encodeURIComponent("User activated.")}`, 302);
});

adminApp.post("/users/:id/password", async (c) => {
	const form = await c.req.parseBody();
	const password = String(form.password || "");
	if (password.length < 12) {
		return c.redirect(`/admin/users?err=${encodeURIComponent("Password must be at least 12 characters.")}`, 302);
	}
	const user = await getUserById(c.env, c.req.param("id"));
	if (!user) return c.redirect(`/admin/users?err=${encodeURIComponent("User not found.")}`, 302);
	const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
	await updateUserPassword(c.env, user.id, hash, salt);
	return c.redirect(`/admin/users?ok=${encodeURIComponent(`Password updated for ${user.email}.`)}`, 302);
});

adminApp.post("/users/:id/mcp-token", async (c) => {
	const user = await getUserById(c.env, c.req.param("id"));
	if (!user) return c.redirect(`/admin/users?err=${encodeURIComponent("User not found.")}`, 302);
	const token = generateMcpToken();
	await setUserMcpTokenHash(c.env, user.id, await hashToken(token));
	const base = mcpBaseUrl(c);
	const brand = resolveBrand(c.env.BRAND);
	return c.html(
		shell(brand, `
  <h1>MCP token issued</h1>
  <div class="flash ok">Copy this now — it is shown only once.</div>
  <div class="card">
    <p>User: <strong>${escapeHtml(user.email)}</strong> (${user.role})</p>
    <p>Token:</p><p><code>${escapeHtml(token)}</code></p>
    <p>Endpoint:</p><p><code>${escapeHtml(base)}</code></p>
    <p style="color:var(--muted);font-size:13px">Connect an MCP client with header
      <code>Authorization: Bearer &lt;token&gt;</code>. ${user.role === "ADMIN"
				? "As ADMIN it can read all mailboxes; it sends only from this user's address."
				: "It can read and send only from this user's mailbox."}</p>
    <a href="/admin/users">← Back to users</a>
  </div>`),
	);
});

export { adminApp };
