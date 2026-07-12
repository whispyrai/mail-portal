import assert from "node:assert/strict";
import test from "node:test";
import {
	completeAttachmentPromotion,
	resolveAndPromoteAttachments,
	rollbackAttachmentPromotion,
	uploadKey,
} from "./attachments.ts";

function bucketFixture(options: { failDelete?: boolean } = {}) {
	const objects = new Map<string, ArrayBuffer>();
	const metadata = new Map<string, { filename: string; type: string }>();
	const deleted: string[][] = [];
	return {
		objects,
		metadata,
		deleted,
		bucket: {
			async get(key: string) {
				const bytes = objects.get(key);
				if (!bytes) return null;
				return {
					customMetadata: metadata.get(key) ?? {
						filename: "proposal.pdf",
						type: "application/pdf",
					},
					httpMetadata: {},
					async arrayBuffer() {
						return bytes.slice(0);
					},
				};
			},
			async put(key: string, bytes: ArrayBuffer) {
				objects.set(key, bytes.slice(0));
			},
			async delete(keys: string | string[]) {
				const list = Array.isArray(keys) ? keys : [keys];
				deleted.push(list);
				if (options.failDelete) throw new Error("R2 unavailable");
				for (const key of list) objects.delete(key);
			},
		} as never,
	};
}

const actor = { kind: "user" as const, id: "user-1" };

test("staging survives promotion until the durable enqueue succeeds", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-1");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);
	const queued: string[][] = [];
	const stub = {
		async getAttachment() { return null; },
		async queueAttachmentCleanup(_emailId: string, keys: string[]) {
			queued.push(keys);
		},
	};

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"email-1",
		[{ kind: "upload", uploadId: "upload-1" }],
		actor,
	);

	assert.equal(fixture.objects.has(stagingKey), true);
	assert.equal(fixture.objects.has(promotion.destinationKeys[0]!), true);
	assert.deepEqual(fixture.deleted, []);

	await completeAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);
	assert.equal(fixture.objects.has(stagingKey), false);
	assert.deepEqual(queued, []);
});

test("failed enqueue removes destination copies but retains staging for retry", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-1");
	fixture.objects.set(stagingKey, new Uint8Array([1]).buffer);
	const stub = {
		async getAttachment() { return null; },
		async queueAttachmentCleanup() {},
	};
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"email-1",
		[{ kind: "upload", uploadId: "upload-1" }],
		actor,
	);

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);

	assert.equal(fixture.objects.has(stagingKey), true);
	assert.equal(fixture.objects.has(promotion.destinationKeys[0]!), false);
});

test("failed destination cleanup is durably queued", async () => {
	const fixture = bucketFixture({ failDelete: true });
	const queued: Array<{ emailId: string; keys: string[]; actor: unknown }> = [];
	const stub = {
		async getAttachment() { return null; },
		async queueAttachmentCleanup(emailId: string, keys: string[], cleanupActor: unknown) {
			queued.push({ emailId, keys, actor: cleanupActor });
		},
	};
	const promotion = {
		sesAttachments: [],
		storedMetadata: [],
		stagingKeys: ["uploads/team/upload-1"],
		destinationKeys: ["attachments/email-1/attachment-1/file.pdf"],
	};

	await rollbackAttachmentPromotion(
		fixture.bucket,
		stub,
		"email-1",
		promotion,
		actor,
	);

	assert.deepEqual(queued, [
		{
			emailId: "email-1",
			keys: promotion.destinationKeys,
			actor,
		},
	]);
});

test("fresh inline upload promotion carries Content-ID into SES and stored metadata", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-inline"),
		new Uint8Array([10, 11, 12]).buffer,
	);
	fixture.metadata.set(uploadKey("team@example.com", "upload-inline"), {
		filename: "diagram.png",
		type: "image/png",
	});
	fixture.objects.set(
		uploadKey("team@example.com", "upload-ordinary"),
		new Uint8Array([13, 14]).buffer,
	);

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() { return null; },
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-1",
		[
			{
				kind: "upload",
				uploadId: "upload-inline",
				disposition: "inline",
				contentId: "diagram-1@mail-portal.local",
			},
			{
				kind: "upload",
				uploadId: "upload-ordinary",
				disposition: "attachment",
			},
		],
		actor,
	);

	assert.equal(promotion.sesAttachments[0]?.contentId, "diagram-1@mail-portal.local");
	assert.equal(promotion.storedMetadata[0]?.content_id, "diagram-1@mail-portal.local");
	assert.equal(promotion.storedMetadata[0]?.disposition, "inline");
	assert.equal(promotion.sesAttachments[1]?.contentId, undefined);
	assert.equal(promotion.storedMetadata[1]?.content_id, null);
	assert.equal(promotion.storedMetadata[1]?.disposition, "attachment");
});

test("fresh inline upload promotion rejects a resolved non-image MIME", async () => {
	const fixture = bucketFixture();
	const stagingKey = uploadKey("team@example.com", "upload-pdf");
	fixture.objects.set(stagingKey, new Uint8Array([1, 2, 3]).buffer);

	await assert.rejects(
		resolveAndPromoteAttachments(
			fixture.bucket,
			{
				async getAttachment() { return null; },
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"draft-pdf",
			[{
				kind: "upload",
				uploadId: "upload-pdf",
				disposition: "inline",
				contentId: "pdf@mail-portal.local",
			}],
			actor,
		),
		/inline.*image|image.*inline/i,
	);
	assert.equal(fixture.objects.has(stagingKey), true);
	assert.equal(fixture.objects.size, 1);
});

test("existing inline attachment promotion preserves its authoritative Content-ID", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		"attachments/draft-1/inline-1/signature.png",
		new Uint8Array([4, 5, 6]).buffer,
	);
	const stub = {
		async getAttachment() {
			return {
				id: "inline-1",
				email_id: "draft-1",
				filename: "signature.png",
				mimetype: "image/png",
				size: 3,
				content_id: "signature@example.com",
				disposition: "inline",
			};
		},
		async queueAttachmentCleanup() {},
	};

	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		stub,
		"team@example.com",
		"outbound-1",
		[
			{
				kind: "existing",
				emailId: "draft-1",
				attachmentId: "inline-1",
				// Existing metadata is authoritative even if a client downcasts it.
				disposition: "attachment",
			},
		],
		actor,
	);

	assert.deepEqual(promotion.sesAttachments, [
		{
			content: "BAUG",
			filename: "signature.png",
			type: "image/png",
			disposition: "inline",
			contentId: "signature@example.com",
		},
	]);
	assert.equal(promotion.storedMetadata[0]?.content_id, "signature@example.com");
	assert.equal(promotion.storedMetadata[0]?.disposition, "inline");
});

test("existing ordinary metadata cannot carry a legacy Content-ID into promotion", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		"attachments/draft-legacy/ordinary-1/proposal.pdf",
		new Uint8Array([4, 5, 6]).buffer,
	);
	const promotion = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() {
				return {
					id: "ordinary-1",
					email_id: "draft-legacy",
					filename: "proposal.pdf",
					mimetype: "application/pdf",
					size: 3,
					content_id: "legacy-ordinary@example.com",
					disposition: "attachment",
				};
			},
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"outbound-legacy",
		[{
			kind: "existing",
			emailId: "draft-legacy",
			attachmentId: "ordinary-1",
		}],
		actor,
	);

	assert.equal(promotion.sesAttachments[0]?.contentId, undefined);
	assert.equal(promotion.storedMetadata[0]?.content_id, null);
	assert.equal(promotion.storedMetadata[0]?.disposition, "attachment");
});

test("Content-ID survives upload to draft storage and subsequent send promotion", async () => {
	const fixture = bucketFixture();
	fixture.objects.set(
		uploadKey("team@example.com", "upload-chart"),
		new Uint8Array([7, 8, 9]).buffer,
	);
	fixture.metadata.set(uploadKey("team@example.com", "upload-chart"), {
		filename: "chart.png",
		type: "image/png",
	});
	const first = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() { return null; },
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"draft-2",
		[{
			kind: "upload",
			uploadId: "upload-chart",
			disposition: "inline",
			contentId: "chart@example.com",
		}],
		actor,
	);
	const savedInline = first.storedMetadata[0];
	assert.ok(savedInline);
	assert.equal(first.sesAttachments[0]?.contentId, "chart@example.com");
	assert.equal(savedInline.content_id, "chart@example.com");

	const second = await resolveAndPromoteAttachments(
		fixture.bucket,
		{
			async getAttachment() { return savedInline; },
			async queueAttachmentCleanup() {},
		},
		"team@example.com",
		"outbound-2",
		[
			{
				kind: "existing",
				emailId: "draft-2",
				attachmentId: savedInline.id,
			},
		],
		actor,
	);

	assert.equal(second.storedMetadata[0]?.content_id, "chart@example.com");
	assert.equal(second.storedMetadata[0]?.disposition, "inline");
	assert.equal(second.sesAttachments[0]?.contentId, "chart@example.com");
});

test("existing attachment references fail closed when the email identity does not match", async () => {
	const fixture = bucketFixture();
	await assert.rejects(
		resolveAndPromoteAttachments(
			fixture.bucket,
			{
				async getAttachment() {
					return {
						email_id: "other-draft",
						filename: "private.pdf",
						mimetype: "application/pdf",
						size: 3,
					};
				},
				async queueAttachmentCleanup() {},
			},
			"team@example.com",
			"outbound-3",
			[
				{
					kind: "existing",
					emailId: "expected-draft",
					attachmentId: "attachment-1",
				},
			],
			actor,
		),
		/A referenced attachment does not belong to the referenced email/,
	);
});
