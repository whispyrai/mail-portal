import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleSaveDraft } from "./drafts.ts";

function fixture(result: Record<string, unknown>) {
	const writes: Array<Record<string, unknown>> = [];
	const stub = {
		async getAttachment() { return null; },
		async upsertDraft(input: Record<string, unknown>) {
			writes.push(input);
			return result;
		},
		async getEmail(id: string) {
			return {
				id,
				folder_id: "draft",
				draft_version: result.draftVersion,
				attachments: [],
			};
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", handleSaveDraft);
	return { app, writes };
}

test("draft overwrite passes the expected version to the atomic upsert", async () => {
	const { app, writes } = fixture({ status: "saved", draftVersion: 8, replacedAttachments: [] });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Revised",
				draft_id: "draft-1",
				draft_version: 7,
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 201);
	assert.equal(writes[0]!.id, "draft-1");
	assert.equal(writes[0]!.expectedVersion, 7);
	assert.equal((await response.json() as { draft_version: number }).draft_version, 8);
});

test("stale draft overwrite returns conflict and never replaces newer content", async () => {
	const { app } = fixture({ status: "version_conflict", currentVersion: 9 });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				body: "Stale edit",
				draft_id: "draft-1",
				draft_version: 7,
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Draft changed in another session. Reload it before saving.",
		currentVersion: 9,
	});
});

test("draft ID without a version is rejected before storage", async () => {
	const { app, writes } = fixture({ status: "saved", draftVersion: 2, replacedAttachments: [] });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/drafts",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body: "Missing version", draft_id: "draft-1" }),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.equal(writes.length, 0);
});
