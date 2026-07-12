import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxAttachmentItem } from "../../shared/mailbox-attachments.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createMailboxAttachmentRoutes,
	type MailboxAttachmentOperations,
} from "./mailbox-attachments.ts";

const item: MailboxAttachmentItem = {
	id: "attachment-1",
	emailId: "mail-1",
	filename: "proposal.pdf",
	mimetype: "application/pdf",
	size: 42,
	kind: "pdf",
	message: {
		subject: "Proposal",
		sender: "client@example.com",
		date: "2026-07-12T10:00:00.000Z",
		folderId: "inbox",
		folderName: "Inbox",
	},
};

function app(
	operations: MailboxAttachmentOperations,
	revalidateAccess: () => Promise<boolean> = async () => true,
) {
	const root = new Hono<MailboxContext>();
	root.route("/", createMailboxAttachmentRoutes({
		operations: () => operations,
		revalidateAccess,
	}));
	return root;
}

test("attachment list route validates and normalizes filters before storage", async () => {
	let received: unknown;
	const response = await app({
		async list(options) {
			received = options;
			return { items: [item], nextCursor: null };
		},
		async detail() { return null; },
	}).request("/api/v1/mailboxes/team%40example.com/attachments?limit=10&q=proposal&kind=pdf&folder=inbox");
	assert.equal(response.status, 200);
	assert.deepEqual(received, {
		limit: 10,
		q: "proposal",
		kind: "pdf",
		folder: "inbox",
		cursor: null,
	});
	assert.deepEqual(await response.json(), { items: [item], nextCursor: null });
});

test("attachment list and detail discard metadata when membership is revoked in flight", async () => {
	const calls: string[] = [];
	const operations: MailboxAttachmentOperations = {
		async list() {
			calls.push("list");
			return { items: [item], nextCursor: null };
		},
		async detail() {
			calls.push("detail");
			return item;
		},
	};
	const revalidate = async () => {
		calls.push("access");
		return false;
	};
	const list = await app(operations, revalidate)
		.request("/api/v1/mailboxes/team%40example.com/attachments");
	assert.equal(list.status, 403);
	assert.deepEqual(await list.json(), { error: "Forbidden" });
	const detail = await app(operations, revalidate)
		.request("/api/v1/mailboxes/team%40example.com/attachments/attachment-1");
	assert.equal(detail.status, 403);
	assert.deepEqual(await detail.json(), { error: "Forbidden" });
	assert.deepEqual(calls, ["list", "access", "detail", "access"]);
});

test("attachment list route rejects malformed input without storage work", async () => {
	let called = false;
	const response = await app({
		async list() {
			called = true;
			return { items: [], nextCursor: null };
		},
		async detail() { return null; },
	}).request("/api/v1/mailboxes/team%40example.com/attachments?limit=500");
	assert.equal(response.status, 400);
	assert.equal(called, false);
	assert.deepEqual(await response.json(), {
		error: "limit must be a whole number from 1 through 50",
		code: "INVALID_QUERY",
	});
});

test("attachment detail route returns eligible metadata and truthful missing state", async () => {
	const operations: MailboxAttachmentOperations = {
		async list() { return { items: [], nextCursor: null }; },
		async detail(id) { return id === item.id ? item : null; },
	};
	const visible = await app(operations).request(`/api/v1/mailboxes/team%40example.com/attachments/${item.id}`);
	assert.equal(visible.status, 200);
	assert.deepEqual(await visible.json(), item);
	const missing = await app(operations).request("/api/v1/mailboxes/team%40example.com/attachments/missing");
	assert.equal(missing.status, 404);
	assert.deepEqual(await missing.json(), { error: "Attachment not found" });
	const oversized = await app(operations).request(`/api/v1/mailboxes/team%40example.com/attachments/${"a".repeat(301)}`);
	assert.equal(oversized.status, 400);
});
