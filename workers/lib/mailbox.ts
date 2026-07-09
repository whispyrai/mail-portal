// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Mailbox middleware + provisioning helpers.
 *
 * `requireMailbox` resolves the MailboxDO stub for a `:mailboxId` route param,
 * AND enforces per-mailbox authorization: a rep (AGENT) may only act on their
 * own mailbox; an ADMIN may act on any. (Upstream Agentic Inbox had no such
 * authorization — see locked-decisions D-63.)
 */
import { createMiddleware } from "hono/factory";
import type { MailboxDO } from "../durableObject";
import type { Env } from "../types";
import type { SessionClaims } from "./auth";
import { systemPromptFor } from "./prompts";
import { resolveBrand } from "../routes/brand";

export type MailboxContext = {
	Bindings: Env;
	Variables: {
		mailboxStub: DurableObjectStub<MailboxDO>;
		session?: SessionClaims;
	};
};

export const requireMailbox = createMiddleware<MailboxContext>(async (c, next) => {
	const rawId = c.req.param("mailboxId");
	if (!rawId) return c.json({ error: "Mailbox ID required" }, 400);
	const mailboxId = decodeURIComponent(rawId);

	// Authorization: reps are confined to their own mailbox; admins see all.
	const session = c.get("session");
	if (!session) return c.json({ error: "Unauthorized" }, 401);
	if (
		session.role !== "ADMIN" &&
		session.mailbox.toLowerCase() !== mailboxId.toLowerCase()
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
 * `agentSystemPrompt` here to seed the AI's Whispyr context (D-43).
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
		const defaultSettings = {
			fromName: name,
			forwarding: { enabled: false, email: "" },
			signature: { enabled: false, text: "" },
			autoReply: { enabled: false, subject: "", message: "" },
			agentSystemPrompt: systemPromptFor(resolveBrand(env.BRAND).id),
		};
		await env.BUCKET.put(key, JSON.stringify({ ...defaultSettings, ...settings }));
	}
	// Touching the DO initialises it (creates the default folders).
	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(addr));
	await stub.getFolders();
}
