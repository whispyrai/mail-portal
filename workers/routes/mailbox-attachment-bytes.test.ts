import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createMailboxAttachmentByteRoutes,
	encodeAttachmentFilenameStar,
	type MailboxAttachmentByteOperations,
} from "./mailbox-attachment-bytes.ts";

test("attachment filename-star encoding covers RFC 5987 punctuation", () => {
	assert.equal(
		encodeAttachmentFilenameStar("O'Reilly (final)*.pdf"),
		"O%27Reilly%20%28final%29%2A.pdf",
	);
});

const stored = {
	id: "attachment-1",
	email_id: "mail-1",
	filename: 'Q3 "proposal".pdf',
	mimetype: "application/pdf",
	size: 3,
	content_id: null,
	disposition: "attachment",
};

function app(
	operations: MailboxAttachmentByteOperations,
	bucketGet: (key: string) => Promise<{ body: BodyInit } | null>,
	revalidateAccess: () => Promise<boolean> = async () => true,
) {
	const root = new Hono<MailboxContext>();
	root.route("/", createMailboxAttachmentByteRoutes({
		operations: () => operations,
		bucket: () => ({ get: bucketGet }),
		revalidateAccess,
	}));
	return root;
}

test("attachment byte route requires the exact email and attachment pair before R2", async () => {
	const calls: string[][] = [];
	let bucketReads = 0;
	const response = await app({
		async exact(emailId, attachmentId) {
			calls.push([emailId, attachmentId]);
			return null;
		},
	}, async () => {
		bucketReads += 1;
		return { body: "secret" };
	}).request("/api/v1/mailboxes/team%40example.com/emails/wrong/attachments/attachment-1");
	assert.equal(response.status, 404);
	assert.deepEqual(calls, [["wrong", "attachment-1"]]);
	assert.equal(bucketReads, 0);
});

test("attachment byte route discards an R2 result when membership is revoked in flight", async () => {
	const calls: string[] = [];
	const response = await app(
		{
			async exact() {
				calls.push("metadata");
				return stored;
			},
		},
		async () => {
			calls.push("r2");
			return { body: "private bytes" };
		},
		async () => {
			calls.push("access");
			return false;
		},
	).request("/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1");
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.deepEqual(calls, ["metadata", "r2", "access"]);
});

test("attachment byte route derives the key from authoritative metadata and emits defensive headers", async () => {
	const keys: string[] = [];
	const response = await app({ async exact() { return stored; } }, async (key) => {
		keys.push(key);
		return { body: new Uint8Array([1, 2, 3]) };
	}).request("/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1");
	assert.equal(response.status, 200);
	assert.deepEqual(keys, ['attachments/mail-1/attachment-1/Q3 "proposal".pdf']);
	assert.equal(response.headers.get("content-type"), "application/pdf");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
	assert.equal(
		response.headers.get("content-disposition"),
		`attachment; filename="Q3 _proposal_.pdf"; filename*=UTF-8''Q3%20%22proposal%22.pdf`,
	);
	assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("attachment byte route falls back from invalid MIME and reports missing objects truthfully", async () => {
	const invalidMime = { ...stored, mimetype: "text/html\r\nX-Evil: yes" };
	const safe = await app({ async exact() { return invalidMime; } }, async () => ({ body: "bytes" }))
		.request("/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1");
	assert.equal(safe.headers.get("content-type"), "application/octet-stream");
	const missing = await app({ async exact() { return stored; } }, async () => null)
		.request("/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1");
	assert.equal(missing.status, 404);
	assert.deepEqual(await missing.json(), { error: "Attachment file not found" });
});

test("attachment byte route preserves valid long vendor MIME types", async () => {
	const vendorMime = `image/vnd.${"a".repeat(72)}`;
	assert.ok(vendorMime.length > 78);
	const response = await app(
		{ async exact() { return { ...stored, mimetype: vendorMime }; } },
		async () => ({ body: "bytes" }),
	).request(
		"/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1",
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), vendorMime);
});

test("attachment byte route rejects overlong media-type components", async () => {
	const overlongMime = `image/${"a".repeat(128)}`;
	const response = await app(
		{ async exact() { return { ...stored, mimetype: overlongMime }; } },
		async () => ({ body: "bytes" }),
	).request(
		"/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1",
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "application/octet-stream");
});

test("attachment byte route bounds the header filename without changing the R2 key", async () => {
	const originalFilename = `${"a".repeat(300)}.pdf`;
	const keys: string[] = [];
	const response = await app(
		{ async exact() { return { ...stored, filename: originalFilename }; } },
		async (key) => {
			keys.push(key);
			return { body: "bytes" };
		},
	).request(
		"/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1",
	);
	assert.equal(response.status, 200);
	assert.deepEqual(keys, [`attachments/mail-1/attachment-1/${originalFilename}`]);
	const disposition = response.headers.get("content-disposition") ?? "";
	assert.ok(disposition.length < 800);
	assert.match(disposition, /\.pdf"; filename\*=UTF-8''/);
	assert.equal(disposition.includes(originalFilename), false);
});

test("attachment byte route keeps Unicode in filename-star with an ASCII fallback", async () => {
	const filename = "عقد 📄 نهائي.pdf";
	const keys: string[] = [];
	const response = await app(
		{ async exact() { return { ...stored, filename }; } },
		async (key) => {
			keys.push(key);
			return { body: "bytes" };
		},
	).request(
		"/api/v1/mailboxes/team%40example.com/emails/mail-1/attachments/attachment-1",
	);
	assert.equal(response.status, 200);
	assert.deepEqual(keys, [`attachments/mail-1/attachment-1/${filename}`]);
	assert.equal(
		response.headers.get("content-disposition"),
		`attachment; filename="___ __ _____.pdf"; filename*=UTF-8''${encodeAttachmentFilenameStar(filename)}`,
	);
});

test("attachment byte route preserves authorized Draft and inline raster-image reads", async () => {
	const inline = { ...stored, filename: "logo.png", mimetype: "image/png", disposition: "inline" };
	const response = await app({ async exact() { return inline; } }, async () => ({ body: "png" }))
		.request("/api/v1/mailboxes/team%40example.com/emails/draft-1/attachments/attachment-1");
	assert.equal(response.status, 404, "the returned authoritative email identity must still match the path");
	const exactDraftInline = { ...inline, email_id: "draft-1" };
	const visible = await app({ async exact() { return exactDraftInline; } }, async () => ({ body: "png" }))
		.request("/api/v1/mailboxes/team%40example.com/emails/draft-1/attachments/attachment-1");
	assert.equal(visible.status, 200);
	assert.equal(visible.headers.get("content-type"), "image/png");
});
