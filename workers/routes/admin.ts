// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Admin console (ADMIN role only): create reps with manually-set passwords and
// roles, activate/deactivate, reset passwords, and issue per-user MCP tokens.
// Worker-rendered HTML (no React) — locked-decisions D-23, D-62, D-64.

import { Hono } from "hono";
import PostalMime, { type Email } from "postal-mime";
import { z } from "zod";
import { USER_ROLES, type UserRole } from "../db/users-schema";
import { importParsedEmail } from "../lib/import/import-email";
import {
  AuditedInboundRecoveryError,
  recoverInboundEmailWithAudit,
} from "../lib/import/audited-inbound-recovery";
import { mapZohoFolder } from "../lib/import/parse";
import { MAX_EMAIL_SIZE } from "../lib/store-email";
import type { InboundArchivePointer } from "../inbound-email";
import { isInboundArchivePointer } from "../inbound-queue";
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
import { provisionAccount } from "../lib/account-provisioning";
import { systemPromptFor } from "../lib/prompts";
import { escapeHtml } from "../lib/email-helpers";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "../lib/mail-address";
import { pageShell, brandLogo, resolveBrand, type BrandConfig } from "./brand";
import { adminQuizApp } from "../quiz/admin-routes";
import type { Env } from "../types";

type AdminEnv = { Bindings: Env; Variables: { session?: SessionClaims } };

function shell(brand: BrandConfig, body: string): string {
  return pageShell(
    brand,
    `Admin · ${brand.appName}`,
    `<div class="wrap">${body}</div>`,
  );
}

function mcpBaseUrl(c: { req: { url: string }; env: Env }): string {
  const root = (c.env.DOMAINS || "").split(",")[0]?.trim();
  if (root) return `https://mail.${root}/mcp`;
  return `${new URL(c.req.url).origin}/mcp`;
}

const adminApp = new Hono<AdminEnv>();

const InboundRecoveryQuery = z.object({
  ingressId: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(128),
});

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
    shell(
      brand,
      `
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
  </div>`,
    ),
  );
});

adminApp.post("/users", async (c) => {
  const form = await c.req.parseBody();
  const email = normalizeMailAddress(String(form.email || ""));
  const password = String(form.password || "");
  const roleRaw = String(form.role || "AGENT");
  const role: UserRole = roleRaw === "ADMIN" ? "ADMIN" : "AGENT";

  if (!email) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Invalid email address.")}`,
      302,
    );
  }
  if (!isAddressInConfiguredMailDomains(email, c.env.DOMAINS)) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Email address must use a configured mail domain.")}`,
      302,
    );
  }
  if (password.length < 12) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Password must be at least 12 characters.")}`,
      302,
    );
  }
  if (await getUserByEmail(c.env, email)) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("A user with that email already exists.")}`,
      302,
    );
  }
  const name = String(form.name || "").trim() || email.split("@")[0];

  const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
  try {
    await provisionAccount(c.env, {
      email,
      passwordHash: hash,
      passwordSalt: salt,
      role,
      mailboxAddress: email,
      displayName: name,
      mailboxSettings: {
        agentSystemPrompt: systemPromptFor(resolveBrand(c.env.BRAND).id),
      },
    });
  } catch (error) {
    console.error("[admin] failed to create user and mailbox", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User and mailbox could not be created. Please retry or inspect logs.")}`,
      302,
    );
  }

  return c.redirect(
    `/admin/users?ok=${encodeURIComponent(`Created ${email} (${role}).`)}`,
    302,
  );
});

adminApp.post("/users/:id/deactivate", async (c) => {
  await setUserActive(c.env, c.req.param("id"), false);
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent("User deactivated.")}`,
    302,
  );
});

adminApp.post("/users/:id/activate", async (c) => {
  await setUserActive(c.env, c.req.param("id"), true);
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent("User activated.")}`,
    302,
  );
});

adminApp.post("/users/:id/password", async (c) => {
  const form = await c.req.parseBody();
  const password = String(form.password || "");
  if (password.length < 12) {
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("Password must be at least 12 characters.")}`,
      302,
    );
  }
  const user = await getUserById(c.env, c.req.param("id"));
  if (!user)
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User not found.")}`,
      302,
    );
  const { hash, salt } = await hashPassword(password, c.env.JWT_SECRET);
  await updateUserPassword(c.env, user.id, hash, salt);
  return c.redirect(
    `/admin/users?ok=${encodeURIComponent(`Password updated for ${user.email}.`)}`,
    302,
  );
});

adminApp.post("/users/:id/mcp-token", async (c) => {
  const user = await getUserById(c.env, c.req.param("id"));
  if (!user)
    return c.redirect(
      `/admin/users?err=${encodeURIComponent("User not found.")}`,
      302,
    );
  const token = generateMcpToken();
  await setUserMcpTokenHash(c.env, user.id, await hashToken(token));
  const base = mcpBaseUrl(c);
  const brand = resolveBrand(c.env.BRAND);
  return c.html(
    shell(
      brand,
      `
  <h1>MCP token issued</h1>
  <div class="flash ok">Copy this now — it is shown only once.</div>
  <div class="card">
    <p>User: <strong>${escapeHtml(user.email)}</strong> (${user.role})</p>
    <p>Token:</p><p><code>${escapeHtml(token)}</code></p>
    <p>Endpoint:</p><p><code>${escapeHtml(base)}</code></p>
    <p style="color:var(--muted);font-size:13px">Connect an MCP client with header
      <code>Authorization: Bearer &lt;token&gt;</code>. ${
        user.role === "ADMIN"
          ? "As ADMIN it can read all mailboxes; it sends only from this user's address."
          : "It can read and send only from this user's mailbox."
      }</p>
    <a href="/admin/users">← Back to users</a>
  </div>`,
    ),
  );
});

// ── One-time Zoho mail importer (WISER-241) ─────────────────────────
//
// POST /admin/import/:mailboxId?folder=<zohoFolder> with a raw RFC822 .eml body.
// ADMIN-only (inherited guard). Feeds historical mail through the shared store path,
// preserves the original date, routes the
// original folder (Trash/Spam dropped), and marks history read — and never fires
// push. Idempotent: the internal id is derived from the message, so re-running
// skips anything already imported (R2 keys are keyed on that id too). Removable
// after the migration.
adminApp.post("/import/:mailboxId", async (c) => {
  const mailboxId = decodeURIComponent(c.req.param("mailboxId")).toLowerCase();
  const sourceFolder = c.req.query("folder")?.trim();
  if (!sourceFolder)
    return c.json({ error: "folder query param is required" }, 400);

  // Require a pre-provisioned mailbox — the importer never creates one (role
  // inboxes are admin-provisioned via /admin/users before import).
  if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const folder = mapZohoFolder(sourceFolder);
  if (!folder) {
    return c.json(
      { status: "skipped", reason: "excluded-folder", folder: sourceFolder },
      200,
    );
  }

  const raw = await c.req.arrayBuffer();
  if (raw.byteLength === 0) return c.json({ error: "empty message body" }, 400);
  if (raw.byteLength > MAX_EMAIL_SIZE)
    return c.json({ error: "message exceeds size limit" }, 413);

  let parsed: Email;
  try {
    parsed = await new PostalMime().parse(raw);
  } catch {
    return c.json({ error: "invalid RFC822 message" }, 400);
  }
  const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
  const result = await importParsedEmail(
    { bucket: c.env.BUCKET, mailbox: stub },
    parsed,
    folder,
  );
  return result.status === "imported"
    ? c.json(result, 201)
    : c.json(result, 200);
});

// Recover one raw-archive projection with its original ingress identity. This
// is deliberately separate from the historical importer, whose derived IDs are
// correct for Zoho history but would duplicate a partially projected live email.
adminApp.post("/recover-inbound/:mailboxId", async (c) => {
  const mailboxId = normalizeMailAddress(
    decodeURIComponent(c.req.param("mailboxId")),
  );
  if (
    !mailboxId ||
    !isAddressInConfiguredMailDomains(mailboxId, c.env.DOMAINS)
  ) {
    return c.json({ error: "invalid mailbox" }, 400);
  }
  const query = InboundRecoveryQuery.safeParse({
    ingressId: c.req.query("ingressId"),
  });
  if (!query.success) return c.json({ error: "invalid recovery query" }, 400);
  if (!(await c.env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
    return c.json({ error: "Mailbox not found" }, 404);
  }

  const receiptObject = await c.env.RAW_MAIL_BUCKET.get(
    `receipts/${query.data.ingressId}.json`,
  );
  if (!receiptObject)
    return c.json({ error: "Inbound receipt not found" }, 404);
  let receipt: unknown;
  try {
    receipt = JSON.parse(await receiptObject.text());
  } catch {
    return c.json({ error: "Inbound receipt is malformed" }, 409);
  }
  if (!isInboundArchivePointer(receipt) || receipt.mailboxId !== mailboxId) {
    return c.json(
      { error: "Inbound receipt does not match the requested mailbox" },
      409,
    );
  }
  const receiptRecord = receipt as InboundArchivePointer &
    Record<string, unknown>;
  if (typeof receiptRecord.state !== "string") {
    return c.json({ error: "Inbound receipt has no durable state" }, 409);
  }

  const rawObject = await c.env.RAW_MAIL_BUCKET.get(receipt.rawKey);
  if (!rawObject)
    return c.json({ error: "Archived inbound message not found" }, 404);
  if (
    rawObject.key !== receipt.rawKey ||
    rawObject.size !== receipt.rawSize ||
    rawObject.etag !== receipt.etag ||
    rawObject.version !== receipt.version
  ) {
    return c.json(
      { error: "Archived inbound message failed integrity verification" },
      409,
    );
  }
  const raw = await rawObject.arrayBuffer();
  if (raw.byteLength === 0 || raw.byteLength > MAX_EMAIL_SIZE) {
    return c.json(
      { error: "Archived inbound message has an invalid size" },
      409,
    );
  }

  let parsed: Email;
  try {
    parsed = await PostalMime.parse(raw);
  } catch {
    return c.json({ error: "invalid RFC822 message" }, 400);
  }

  const session = c.get("session");
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const startedAt = Date.now();
  const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
  let auditedRecovery: Awaited<ReturnType<typeof recoverInboundEmailWithAudit>>;
  try {
    auditedRecovery = await recoverInboundEmailWithAudit({
      auditBucket: c.env.RAW_MAIL_BUCKET,
      dependencies: { bucket: c.env.BUCKET, mailbox },
      parsed,
      pointer: receipt,
      operator: { id: session.sub, email: session.email },
    });
  } catch (error) {
    const stage =
      error instanceof AuditedInboundRecoveryError ? error.stage : "projection";
    const auditId =
      error instanceof AuditedInboundRecoveryError
        ? error.auditId
        : "unavailable";
    const errorCode =
      stage === "request_audit"
        ? "MANUAL_RECOVERY_REQUEST_AUDIT_FAILED"
        : stage === "completion_audit"
          ? "MANUAL_RECOVERY_COMPLETION_AUDIT_FAILED"
          : "MANUAL_INBOUND_RECOVERY_FAILED";
    console.error("[mail-recovery] inbound recovery failed", {
      auditId,
      durationMs: Date.now() - startedAt,
      errorCode,
      errorMessage: error instanceof Error ? error.message : String(error),
      ingressId: query.data.ingressId,
      mailboxId,
      operation:
        stage === "projection"
          ? "manual_inbound_recovery"
          : "manual_inbound_recovery_audit",
      stage,
      status: "failed",
    });
    if (stage === "request_audit") {
      return c.json({ error: "recovery audit unavailable" }, 503);
    }
    if (stage === "completion_audit") {
      return c.json(
        { error: "projection completed but recovery audit is incomplete" },
        503,
      );
    }
    return c.json({ error: "recovery failed" }, 500);
  }

  const { auditId, recoveredAt, result } = auditedRecovery;

  try {
    const auditedReceipt = await c.env.RAW_MAIL_BUCKET.put(
      `receipts/${query.data.ingressId}.json`,
      JSON.stringify({
        ...receiptRecord,
        recovery: {
          auditId,
          recoveredAt,
          result,
          operator: { id: session.sub, email: session.email },
        },
      }),
      {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { state: receiptRecord.state },
        onlyIf: { etagMatches: receiptObject.etag },
      },
    );
    if (!auditedReceipt) {
      console.warn("[mail-recovery] receipt summary superseded", {
        auditId,
        errorCode: "MANUAL_RECOVERY_RECEIPT_SUMMARY_SUPERSEDED",
        ingressId: query.data.ingressId,
        mailboxId,
        operation: "manual_inbound_recovery_audit",
        status: "superseded",
      });
    }
  } catch (error) {
    console.warn("[mail-recovery] receipt summary degraded", {
      auditId,
      errorCode: "MANUAL_RECOVERY_RECEIPT_SUMMARY_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      ingressId: query.data.ingressId,
      mailboxId,
      operation: "manual_inbound_recovery_audit",
      status: "degraded",
    });
  }

  console.log("[mail-recovery] inbound projection completed", {
    auditId,
    durationMs: Date.now() - startedAt,
    ingressId: query.data.ingressId,
    mailboxId,
    operation: "manual_inbound_recovery",
    status: result.status,
  });
  const response = { ...result, auditId };
  return result.status === "recovered"
    ? c.json(response, 201)
    : c.json(response, 200);
});

export { adminApp };
