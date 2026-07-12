import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleSendEmail } from "./send-email.ts";

const mailboxId = "team@wiserchat.ai";

function fixture(
	existing: Record<string, unknown> | null = null,
	storedAttachment: Record<string, unknown> | null = null,
) {
	const enqueued: unknown[] = [];
	const enqueuedAttachments: Array<Array<{
		content_id?: string | null;
		disposition?: string;
	}>> = [];
	const stub = {
		async getOutboundDeliveryByIdempotencyKey() { return existing; },
		async getAttachment() { return storedAttachment; },
		async checkSendRateLimit() { return null; },
		async queueAttachmentCleanup() {},
		async enqueueOutbound(
			command: { undoUntil: string; scheduledFor?: string },
			attachments: Array<{
				content_id?: string | null;
				disposition?: string;
			}>,
		) {
			enqueued.push(command);
			enqueuedAttachments.push(attachments);
			return {
				delivery: {
					id: "delivery-1",
					emailId: "outbox-1",
					status: "queued",
					undoUntil: command.undoUntil,
					scheduledFor: command.scheduledFor,
				},
				replayed: false,
				outcome: "enqueued",
			};
		},
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
	app.post("/api/v1/mailboxes/:mailboxId/emails", handleSendEmail as never);
	return { app, enqueued, enqueuedAttachments };
}

test("terminal idempotency replay returns an explicit non-enqueue outcome", async () => {
	const { app, enqueued } = fixture({
		id: "delivery-cancelled",
		emailId: "outbox-cancelled",
		status: "cancelled",
		undoUntil: "2026-07-11T10:00:10.000Z",
	});
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Try again",
				text: "Body",
				idempotency_key: "cancelled-replay",
			}),
		},
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		deliveryId: "delivery-cancelled",
		id: "outbox-cancelled",
		emailId: "outbox-cancelled",
		status: "cancelled",
		undoUntil: "2026-07-11T10:00:10.000Z",
		scheduledFor: null,
		replayed: true,
		outcome: "terminal_replay",
	});
	assert.equal(enqueued.length, 0);
});

test("compose rejects delayed and far-future schedules before enqueue", async () => {
	for (const scheduledFor of [
		new Date(Date.now() + 30_000).toISOString(),
		new Date(Date.now() + 367 * 24 * 60 * 60_000).toISOString(),
	]) {
		const { app, enqueued } = fixture();
		const response = await app.request(
			`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "customer@example.com",
					from: mailboxId,
					subject: "Scheduled",
					text: "Body",
					idempotency_key: "compose-invalid-schedule",
					scheduled_for: scheduledFor,
				}),
			},
		);

		assert.equal(response.status, 400);
		assert.equal(enqueued.length, 0);
	}
});

test("compose API rejects mismatched inline HTML before Outbox mutation and retains staging", async () => {
	const existingAttachment = {
		id: "existing-inline",
		email_id: "draft-existing",
		filename: "legacy.png",
		mimetype: "image/png",
		size: 2,
		content_id: "legacy@mail-portal.local",
		disposition: "inline",
	};
	const { app, enqueued } = fixture(null, existingAttachment);
	const stagingKey = `uploads/${mailboxId}/upload-inline`;
	const existingKey = "attachments/draft-existing/existing-inline/legacy.png";
	const objects = new Map<string, ArrayBuffer>([
		[stagingKey, new Uint8Array([1, 2, 3]).buffer],
		[existingKey, new Uint8Array([4, 5]).buffer],
	]);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Broken inline",
				html: '<img src="cid:missing@mail-portal.local" data-mail-inline-image="v1">',
				attachments: [{
					kind: "upload",
					uploadId: "upload-inline",
					disposition: "inline",
					contentId: "actual@mail-portal.local",
				}, {
					kind: "existing",
					emailId: "draft-existing",
					attachmentId: "existing-inline",
				}],
				idempotency_key: "broken-inline-compose",
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

	assert.equal(response.status, 400);
	assert.equal(enqueued.length, 0);
	assert.deepEqual(await response.json(), {
		error: "An inline image in the message is missing its attachment (missing@mail-portal.local).",
		code: "inline_image_missing_attachment",
	});
	assert.equal(objects.has(stagingKey), true);
	assert.equal(objects.has(existingKey), true);
	assert.equal(objects.size, 2);
});

test("compose API accepts matching fresh and authoritative existing inline parts", async () => {
	const existingAttachment = {
		id: "existing-inline",
		email_id: "draft-existing",
		filename: "legacy.png",
		mimetype: "image/png",
		size: 2,
		content_id: "legacy@mail-portal.local",
		disposition: "inline",
	};
	const { app, enqueued, enqueuedAttachments } = fixture(null, existingAttachment);
	const stagingKey = `uploads/${mailboxId}/upload-fresh`;
	const existingKey = "attachments/draft-existing/existing-inline/legacy.png";
	const objects = new Map<string, ArrayBuffer>([
		[stagingKey, new Uint8Array([1, 2, 3]).buffer],
		[existingKey, new Uint8Array([4, 5]).buffer],
	]);
	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: "customer@example.com",
				from: mailboxId,
				subject: "Valid inline",
				html: [
					'<img src="cid:fresh@mail-portal.local" data-mail-inline-image="v1">',
					'<img src="cid:legacy@mail-portal.local">',
				].join(""),
				attachments: [{
					kind: "upload",
					uploadId: "upload-fresh",
					disposition: "inline",
					contentId: "fresh@mail-portal.local",
				}, {
					kind: "existing",
					emailId: "draft-existing",
					attachmentId: "existing-inline",
				}],
				idempotency_key: "valid-inline-compose",
			}),
		},
		{
			BUCKET: {
				async get(key: string) {
					const bytes = objects.get(key);
					if (!bytes) return null;
					return {
						customMetadata: key === stagingKey
							? { filename: "fresh.png", type: "image/png" }
							: {},
						httpMetadata: {},
						async arrayBuffer() { return bytes.slice(0); },
					};
				},
				async put(key: string, bytes: ArrayBuffer) { objects.set(key, bytes.slice(0)); },
				async delete(keys: string | string[]) {
					for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
				},
			},
		} as never,
	);

	assert.equal(response.status, 202);
	assert.equal(enqueued.length, 1);
	assert.deepEqual(
		enqueuedAttachments[0]?.map((attachment) => ({
			content_id: attachment.content_id,
			disposition: attachment.disposition,
		})),
		[
			{ content_id: "fresh@mail-portal.local", disposition: "inline" },
			{ content_id: "legacy@mail-portal.local", disposition: "inline" },
		],
	);
	assert.equal(objects.has(stagingKey), false);
	assert.equal(objects.has(existingKey), true);
});
