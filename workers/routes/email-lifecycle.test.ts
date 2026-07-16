import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	handleDeleteEmail,
	handleDiscardDraft,
	handleMoveEmail,
	handleRestoreEmail,
} from "./email-lifecycle.ts";

const mailboxId = "hello@wiserchat.ai";

function testApp(
	trashResult:
		| { status: "trashed" | "already_trashed" }
		| { status: "outbound_delivery_active"; deliveryId: string }
		| null,
	restoreResult:
		| { status: "restored"; folderId: string }
		| { status: "not_trashed" }
		| null = null,
	discardResult:
			| { status: "discarded" }
			| { status: "not_draft" }
			| { status: "version_conflict"; currentVersion: number }
			| null = null,
	moveResult:
		| boolean
		| { status: "outbound_delivery_active"; deliveryId: string }
			| { status: "snoozed_state_requires_unsnooze" }
			| { status: "snoozed_state_requires_explicit_action" } = true,
) {
	const stub = {
		async trashEmail(id: string, actor: unknown) {
			assert.equal(id, "email-1");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return trashResult;
		},
		async restoreEmail(id: string, actor: unknown) {
			assert.equal(id, "email-1");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return restoreResult;
		},
		async discardDraft(id: string, expectedVersion: number, actor: unknown) {
			assert.equal(id, "email-1");
			assert.equal(expectedVersion, 7);
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return discardResult;
		},
		async moveEmail(id: string, folderId: string, actor: unknown) {
			assert.equal(id, "email-1");
			assert.equal(folderId, "trash");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return moveResult;
		},
	};
	const env = {};

	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "hesham@wiserchat.ai",
			role: "ADMIN",
			mailbox: "hesham@wiserchat.ai",
		});
		await next();
	});
	app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", handleDeleteEmail);
	app.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/restore",
		handleRestoreEmail,
	);
	app.delete(
		"/api/v1/mailboxes/:mailboxId/drafts/:id",
		handleDiscardDraft,
	);
	app.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/move",
		handleMoveEmail,
	);

	return { app, env };
}

test("deleting an email outside Trash moves it to Trash without deleting attachments", async () => {
	const { app, env } = testApp({
		status: "trashed",
	});

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "trashed" });
});

test("deleting an email already in Trash is idempotent and never purges it", async () => {
	const { app, env } = testApp({ status: "already_trashed" });

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "already_trashed" });
});

test("deleting an unknown email returns not found", async () => {
	const { app, env } = testApp(null);

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Not found" });
});

test("generic delete cannot mutate an email linked to an active Outbox delivery", async () => {
	const { app, env } = testApp({
		status: "outbound_delivery_active",
		deliveryId: "delivery-1",
	});

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Cancel the queued send before moving its Outbox message.",
		code: "active_outbound_delivery_requires_cancel",
		deliveryId: "delivery-1",
	});
});

test("restoring a trashed email returns it to its recorded folder", async () => {
	const { app, env } = testApp(
		{ status: "already_trashed" },
		{ status: "restored", folderId: "archive" },
	);

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1/restore`,
		{ method: "POST" },
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "restored",
		folderId: "archive",
	});
});

test("restoring an email outside Trash is rejected", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		{ status: "not_trashed" },
	);

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1/restore`,
		{ method: "POST" },
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "Email is not in Trash" });
});

test("discarding a draft trusts the Durable Object's atomic cleanup ownership", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		{
			status: "discarded",
		},
	);

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/drafts/email-1`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ draft_version: 7 }),
		},
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "discarded" });
});

test("discarding a non-draft is rejected without deleting attachment objects", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		{ status: "not_draft" },
	);

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/drafts/email-1`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ draft_version: 7 }),
		},
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), { error: "Email is not a draft" });
});

test("discarding a stale shared draft revision preserves the newer draft", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		{ status: "version_conflict", currentVersion: 8 },
	);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/drafts/email-1`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ draft_version: 7 }),
		},
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Draft changed in another session. Reload it before discarding.",
		code: "draft_version_conflict",
		currentVersion: 8,
	});
});

test("discard route requires no R2 binding or route-level cleanup", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		{
			status: "discarded",
		},
		true,
	);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/drafts/email-1`,
		{
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ draft_version: 7 }),
		},
		env as never,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "discarded" });
});

test("moving mail carries the signed-in actor into the authoritative lifecycle", async () => {
	const { app, env } = testApp({ status: "trashed" });
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1/move`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "trash" }),
		},
		env as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "moved" });
});

test("generic move cannot bypass explicit cancellation of an active Outbox delivery", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		null,
		{ status: "outbound_delivery_active", deliveryId: "delivery-2" },
	);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1/move`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "trash" }),
		},
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Cancel the queued send before moving its Outbox message.",
		code: "active_outbound_delivery_requires_cancel",
		deliveryId: "delivery-2",
	});
});

test("generic move cannot target the protected Snoozed folder", async () => {
	const { app, env } = testApp(
		{ status: "trashed" },
		null,
		null,
		{ status: "snoozed_state_requires_explicit_action" },
	);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/email-1/move`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ folderId: "trash" }),
		},
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Use Snooze to move mail into the Snoozed folder.",
		code: "snoozed_state_requires_explicit_action",
	});
});
