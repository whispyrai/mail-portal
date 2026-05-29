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
import { WHISPYR_SYSTEM_PROMPT } from "../lib/whispyr-prompt";
import { escapeHtml } from "../lib/email-helpers";
import type { Env } from "../types";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

const CSS = `
* { box-sizing: border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0b1020; color:#e7ecf5; }
.wrap { max-width:920px; margin:0 auto; padding:32px 20px 64px; }
h1 { font-size:22px; letter-spacing:-.02em; }
a { color:#6ea8fe; }
.card { background:#141b2e; border:1px solid #243049; border-radius:14px; padding:20px; margin:18px 0; }
table { width:100%; border-collapse:collapse; font-size:14px; }
th,td { text-align:left; padding:9px 8px; border-bottom:1px solid #233049; }
th { color:#9aa7c2; font-weight:600; }
.badge { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid #2c3958; }
.badge.admin { color:#ffd479; border-color:#5b4a1f; }
.badge.off { color:#ff9aa8; border-color:#5b2230; }
label { display:block; font-size:13px; color:#c4cfe6; margin:12px 0 5px; }
input,select { width:100%; padding:10px 12px; border-radius:9px; border:1px solid #2c3958; background:#0e1626; color:#e7ecf5; font-size:14px; }
.row { display:flex; gap:14px; flex-wrap:wrap; }
.row > div { flex:1; min-width:200px; }
button { margin-top:16px; padding:10px 16px; border:0; border-radius:9px; background:#3b82f6; color:#fff; font-weight:600; cursor:pointer; }
button.sm { margin:0; padding:6px 10px; font-size:12px; background:#22304d; }
button.danger { background:#7a2230; }
.flash { padding:11px 14px; border-radius:10px; margin-bottom:8px; font-size:13px; }
.flash.ok { background:#10261b; border:1px solid #1f5b3a; color:#9bf0c4; }
.flash.err { background:#3a1620; border:1px solid #6b2235; color:#ffb3c1; }
code { background:#0e1626; border:1px solid #2c3958; padding:3px 7px; border-radius:7px; word-break:break-all; }
.topbar { display:flex; justify-content:space-between; align-items:center; }
form.inline { display:inline; margin:0; }
`;

function shell(body: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Admin · Whispyr Mail</title><style>${CSS}</style></head><body><div class="wrap">${body}</div></body></html>`;
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

adminApp.get("/users", async (c) => {
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
		shell(`
  <div class="topbar"><h1>User administration</h1>
    <form class="inline" method="post" action="/logout"><button class="sm" type="submit">Sign out</button></form></div>
  ${flash}
  <div class="card">
    <h2 style="font-size:16px;margin-top:0">Create a user</h2>
    <form method="post" action="/admin/users">
      <div class="row">
        <div><label>Email</label><input name="email" type="email" placeholder="kareem@whispyrcrm.com" required></div>
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
    <table><thead><tr><th>User</th><th>Mailbox</th><th>MCP</th><th>Actions</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="4">No users yet.</td></tr>`}</tbody></table>
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
	await provisionMailbox(c.env, email, name, { agentSystemPrompt: WHISPYR_SYSTEM_PROMPT });

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
	return c.html(
		shell(`
  <h1>MCP token issued</h1>
  <div class="flash ok">Copy this now — it is shown only once.</div>
  <div class="card">
    <p>User: <strong>${escapeHtml(user.email)}</strong> (${user.role})</p>
    <p>Token:</p><p><code>${escapeHtml(token)}</code></p>
    <p>Endpoint:</p><p><code>${escapeHtml(base)}</code></p>
    <p style="color:#8595b5;font-size:13px">Connect an MCP client with header
      <code>Authorization: Bearer &lt;token&gt;</code>. ${user.role === "ADMIN"
				? "As ADMIN it can read all mailboxes; it sends only from this user's address."
				: "It can read and send only from this user's mailbox."}</p>
    <a href="/admin/users">← Back to users</a>
  </div>`),
	);
});

export { adminApp };
