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
	const deleted: string[][] = [];
	return {
		objects,
		deleted,
		bucket: {
			async get(key: string) {
				const bytes = objects.get(key);
				if (!bytes) return null;
				return {
					customMetadata: {
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
