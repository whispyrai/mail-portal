// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox middleware + provisioning helpers.
 *
 * `requireMailbox` resolves the MailboxDO stub for a `:mailboxId` route param,
 * and enforces live Personal ownership or Shared membership before resolving
 * the mailbox Durable Object. Administrator role alone never grants content
 * access.
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import type { SessionClaims } from "./auth";
import { systemPromptFor } from "./prompts.ts";
import { resolveBrand } from "../routes/brand.ts";
import { mailboxAccess } from "./mailbox-access.ts";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		session?: SessionClaims;
	};
};

/** Settings-only routes authorize themselves and must never resolve a mailbox DO. */
export function bypassMailboxContentAuthorization(method: string, pathname: string): boolean {
	const parts = pathname.split("/").filter(Boolean);
	return (
		method === "GET" &&
		parts.length === 5 &&
		parts[0] === "api" && parts[1] === "v1" && parts[2] === "mailboxes" &&
		parts[4] === "settings"
	) || (
		method === "PATCH" &&
		parts.length === 6 &&
		parts[0] === "api" && parts[1] === "v1" && parts[2] === "mailboxes" &&
		parts[4] === "settings" && parts[5] === "signature"
	);
}

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	if (bypassMailboxContentAuthorization(c.req.method, new URL(c.req.url).pathname)) {
		await next();
		return;
	}
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	const pathParts = new URL(c.req.url).pathname.split("/").filter(Boolean);
	const isMailboxManagementRequest =
		pathParts.length === 4 &&
		pathParts[0] === "api" &&
		pathParts[1] === "v1" &&
		pathParts[2] === "mailboxes";
	const access = mailboxAccess(c.env);
	if (isMailboxManagementRequest && c.req.method === "DELETE") {
		try {
			await access.requireMailboxAdministrator(session.sub);
		} catch {
			return c.json({ error: "Forbidden" }, 403);
		}
	} else if (
		isMailboxManagementRequest &&
		c.req.method === "PUT" &&
		!(await access.canManageMailboxSettings(session.sub, mailboxId))
	) {
		return c.json({ error: "Forbidden" }, 403);
	} else if (
		!(await access.canAccessMailbox(session.sub, mailboxId.toLowerCase()))
	) {
		return c.json({ error: "Forbidden" }, 403);
	}

	// Verify mailbox exists
	const key = `mailboxes/${mailboxId}.json`;
	const obj = await c.env.BUCKET.head(key);
	if (!obj) {
		return c.json({ error: "Not found" }, 404);
	}

	// Instantiate DO stub
	const ns = c.env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	const stub = ns.get(id);

	c.set("mailboxStub", stub);

	await next();
});

/**
 * Provision a mailbox: create its R2 settings doc (if missing) and initialise
 * the MailboxDO (default folders). Idempotent. Used by admin user creation and
 * the first-admin bootstrap. `settings` is merged over defaults — pass
 * `agentSystemPrompt` here to seed the active brand's AI context (D-43).
 */
export async function provisionMailbox(
	env: Env,
	email: string,
	name: string,
	settings?: Record<string, unknown>,
): Promise<void> {
	const addr = email.toLowerCase();
	const key = `mailboxes/${addr}.json`;
	if (!(await env.BUCKET.head(key))) {
		// Initialise the Durable Object before publishing the R2 settings document
		// that makes the mailbox routable to inbound catch-all delivery. If the DO
		// init fails, inbound must still reject the address as unprovisioned.
		const stub = env.MAILBOX.get(env.MAILBOX.idFromName(addr));
		await stub.getFolders();
		const defaultSettings = {
			fromName: name,
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
			agentSystemPrompt: systemPromptFor(resolveBrand(env.BRAND).id),
		};
		await env.BUCKET.put(key, JSON.stringify({ ...defaultSettings, ...settings }));
		return;
	}
	// Existing settings already make the mailbox routable; still touch the DO so a
	// partially initialised mailbox can self-heal when provisioning is retried.
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(addr));
	await stub.getFolders();
}
