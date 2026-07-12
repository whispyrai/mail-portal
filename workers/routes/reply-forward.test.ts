import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { EnqueueOutboundCommand } from "../lib/outbound-delivery-contract.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleForwardEmail, handleReplyEmail } from "./reply-forward.ts";

const mailboxId = "team@wiserchat.ai";

function testApp(options: {
	draftVersion?: number;
	enqueueError?: Error;
	authoritativeAfterError?: {
		id: string;
		emailId: string;
		status: string;
		undoUntil: string;
	};
} = {}) {
	const enqueued: EnqueueOutboundCommand[] = [];
	const markedThreads: string[] = [];
	let idempotencyLookups = 0;
	const stub = {
		async getAttachment() { return null; },
		async getEmail(id: string) {
			if (id === "original-1") {
				return {
					id,
					subject: "Original",
					sender: "customer@example.com",
					recipient: mailboxId,
					date: "2026-07-11T09:00:00.000Z",
					read: false,
					starred: false,
					folder_id: "inbox",
					message_id: "customer-message@example.com",
					email_references: JSON.stringify(["root@example.com"]),
					thread_id: "thread-1",
				};
			}
			if (id === "draft-1") {
				return {
					id,
					folder_id: "draft",
					draft_version: options.draftVersion ?? 7,
				};
			}
			return null;
		},
		async checkSendRateLimit() {
			return null;
		},
		async getOutboundDeliveryByIdempotencyKey() {
			idempotencyLookups += 1;
			return idempotencyLookups > 1
				? options.authoritativeAfterError ?? null
				: null;
		},
		async enqueueOutbound(command: EnqueueOutboundCommand) {
			if (options.enqueueError) throw options.enqueueError;
			enqueued.push(command);
			return {
				delivery: {
					id: `delivery-${enqueued.length}`,
					emailId: `outbox-${enqueued.length}`,
					status: "queued",
					undoUntil: command.undoUntil,
					scheduledFor: command.scheduledFor,
				},
				replayed: false,
			};
		},
		async markThreadRead(threadId: string) {
			markedThreads.push(threadId);
		},
		async queueAttachmentCleanup() {},
	};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "person@wiserchat.ai",
			role: "AGENT",
			mailbox: mailboxId,
		});
		await next();
	});
	app.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/reply",
		handleReplyEmail,
	);
	app.post(
		"/api/v1/mailboxes/:mailboxId/emails/:id/forward",
		handleForwardEmail,
	);

	return { app, enqueued, markedThreads };
}

test("reply snapshots the message and source draft into the truthful outbox", async () => {
	const { app, enqueued, markedThreads } = testApp();
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/reply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: ["Customer@Example.com"],
				cc: "Observer@Example.com",
				from: mailboxId,
				subject: "Re: Original",
				html: "<p>Reply</p>",
				text: "Reply",
				source_draft_id: "draft-1",
				source_draft_version: 7,
				idempotency_key: "reply-action-1",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		deliveryId: "delivery-1",
		id: "outbox-1",
		emailId: "outbox-1",
		status: "queued",
		undoUntil: enqueued[0]!.undoUntil,
		scheduledFor: null,
		replayed: false,
		outcome: "enqueued",
	});
	assert.deepEqual(enqueued[0]!.actor, { kind: "user", id: "user-1" });
	assert.equal(enqueued[0]!.source, "ui");
	assert.equal(enqueued[0]!.idempotencyKey, "reply-action-1");
	assert.equal(
		Date.parse(enqueued[0]!.undoUntil) - Date.parse(enqueued[0]!.requestedAt),
		10_000,
	);
	assert.deepEqual(enqueued[0]!.snapshot, {
		mailboxId,
		draftId: "draft-1",
		draftVersion: 7,
		kind: "reply",
		to: ["customer@example.com"],
		cc: ["observer@example.com"],
		bcc: [],
		from: mailboxId,
		subject: "Re: Original",
		html: "<p>Reply</p>",
		text: "Reply",
		inReplyTo: "customer-message@example.com",
		references: ["root@example.com", "customer-message@example.com"],
		threadId: "thread-1",
		attachmentIds: [],
		sourceDraftAttachmentIds: [],
	});
	assert.deepEqual(markedThreads, ["thread-1"]);
});

test("scheduled forward is queued without an extra undo delay", async () => {
	const { app, enqueued, markedThreads } = testApp();
	const scheduledFor = new Date(Date.now() + 120_000).toISOString();
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/forward`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "another@example.com",
				from: mailboxId,
				subject: "Fwd: Original",
				text: "Forward",
				idempotency_key: "forward-action-1",
				scheduled_for: scheduledFor,
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 202);
	assert.equal(enqueued[0]!.undoUntil, enqueued[0]!.requestedAt);
	assert.equal(enqueued[0]!.scheduledFor, scheduledFor);
	assert.equal(enqueued[0]!.snapshot.kind, "forward");
	assert.deepEqual(enqueued[0]!.snapshot.to, ["another@example.com"]);
	assert.equal(enqueued[0]!.snapshot.threadId.length > 0, true);
	assert.deepEqual(markedThreads, []);
});

test("reply and forward reject delayed or distant schedules before enqueue", async () => {
	const cases = [
		{
			path: "reply",
			scheduledFor: new Date(Date.now() + 30_000).toISOString(),
			expected: /at least one minute/i,
		},
		{
			path: "forward",
			scheduledFor: new Date(Date.now() + 367 * 24 * 60 * 60_000).toISOString(),
			expected: /within one year/i,
		},
	] as const;

	for (const item of cases) {
		const { app, enqueued } = testApp();
		const response = await app.request(
			`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/${item.path}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "customer@example.com",
					from: mailboxId,
					subject: "Scheduled",
					text: "Body",
					idempotency_key: `invalid-${item.path}`,
					scheduled_for: item.scheduledFor,
				}),
			},
			{ BUCKET: {} } as never,
		);

		assert.equal(response.status, 400);
		assert.match((await response.json() as { error: string }).error, item.expected);
		assert.equal(enqueued.length, 0);
	}
});

test("a stale draft revision cannot be queued or consumed", async () => {
	const { app, enqueued } = testApp({
		enqueueError: Object.assign(
			new Error("Source draft draft-1 version_conflict (current 8)"),
			{ name: "SourceDraftConflictError" },
		),
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/reply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Re: Original",
				text: "Stale reply",
				source_draft_id: "draft-1",
				source_draft_version: 7,
				idempotency_key: "reply-stale-1",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.equal(enqueued.length, 0);
	assert.deepEqual(await response.json(), {
		error: "Source draft changed. Review it before sending.",
	});
});

test("a draft changed during attachment preparation is rejected by the atomic enqueue", async () => {
	const { app, enqueued } = testApp({
		draftVersion: 7,
		enqueueError: Object.assign(
			new Error("Source draft draft-1 version_conflict (current 8)"),
			{ name: "SourceDraftConflictError" },
		),
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/reply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Re: Original",
				text: "Raced reply",
				source_draft_id: "draft-1",
				source_draft_version: 7,
				idempotency_key: "reply-race-1",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 409);
	assert.equal(enqueued.length, 0);
	assert.deepEqual(await response.json(), {
		error: "Source draft changed. Review it before sending.",
	});
});

test("an enqueue response lost after commit reconciles the authoritative delivery", async () => {
	const undoUntil = "2026-07-11T10:00:10.000Z";
	const { app } = testApp({
		enqueueError: new Error("RPC response lost"),
		authoritativeAfterError: {
			id: "delivery-committed",
			emailId: "outbox-committed",
			status: "queued",
			undoUntil,
		},
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/reply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Re: Original",
				text: "Committed reply",
				idempotency_key: "reply-ambiguous-commit",
			}),
		},
		{ BUCKET: {} } as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		deliveryId: "delivery-committed",
		id: "outbox-committed",
		emailId: "outbox-committed",
		status: "queued",
		undoUntil,
		scheduledFor: null,
		replayed: true,
		outcome: "active_replay",
	});
});

test("browser replies without an idempotency key are rejected", async () => {
	const { app, enqueued } = testApp();
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/reply`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Re: Original",
				text: "No duplicate protection",
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.equal(enqueued.length, 0);
});

test("reply and forward APIs reject duplicate or malformed inline mappings before enqueue", async () => {
	const cases = [
		{
			path: "reply",
			html: '<img src="cid:chart@mail-portal.local" data-mail-inline-image="v1"><img src="cid:chart@mail-portal.local" data-mail-inline-image="v1">',
			code: "inline_image_duplicate_body_cid",
		},
		{
			path: "forward",
			html: '<img src="cid:chart@mail-portal.local" data-mail-inline-image="v1>',
			code: "inline_html_malformed",
		},
	] as const;

	for (const item of cases) {
		const { app, enqueued } = testApp();
		const stagingKey = `uploads/${mailboxId}/upload-${item.path}`;
		const objects = new Map<string, ArrayBuffer>([
			[stagingKey, new Uint8Array([1, 2, 3]).buffer],
		]);
		const response = await app.request(
			`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails/original-1/${item.path}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "customer@example.com",
					from: mailboxId,
					subject: "Inline authority",
					html: item.html,
					attachments: [{
						kind: "upload",
						uploadId: `upload-${item.path}`,
						disposition: "inline",
						contentId: "chart@mail-portal.local",
					}],
					idempotency_key: `inline-${item.path}-authority`,
				}),
			},
			{
				BUCKET: {
					async get(key: string) {
						const bytes = objects.get(key);
						return bytes ? {
							customMetadata: { filename: "chart.png", type: "image/png" },
							httpMetadata: {},
							async arrayBuffer() { return bytes.slice(0); },
						} : null;
					},
					async put(key: string, bytes: ArrayBuffer) { objects.set(key, bytes.slice(0)); },
					async delete(keys: string | string[]) {
						for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
					},
				},
			} as never,
		);

		assert.equal(response.status, 400, item.path);
		assert.equal((await response.json() as { code: string }).code, item.code);
		assert.equal(enqueued.length, 0);
		assert.equal(objects.has(stagingKey), true);
		assert.equal(objects.size, 1);
	}
});
