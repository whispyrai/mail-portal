import assert from "node:assert/strict";
import test from "node:test";
import {
	prepareRecoveredDraftAttachments,
	recoveredDraftId,
	sourceDraftMatchesSnapshot,
} from "./cancelled-outbound-recovery.ts";

const source = [{
	id: "attachment-1",
	email_id: "snapshot-1",
	filename: "proposal.pdf",
	mimetype: "application/pdf",
	size: 4,
	content_id: null,
	disposition: "attachment",
}, {
	id: "attachment-2",
	email_id: "snapshot-1",
	filename: "terms.txt",
	mimetype: "text/plain",
	size: 3,
	content_id: null,
	disposition: "attachment",
}];

class MemoryBucket {
	readonly objects = new Map<string, ArrayBuffer>([
		["attachments/snapshot-1/attachment-1/proposal.pdf", new Uint8Array([1, 2, 3, 4]).buffer],
		["attachments/snapshot-1/attachment-2/terms.txt", new Uint8Array([5, 6, 7]).buffer],
	]);
	putCalls = 0;
	failPutAt?: number;
	failDelete = false;

	async get(key: string) {
		const bytes = this.objects.get(key);
		return bytes ? { arrayBuffer: async () => bytes.slice(0) } : null;
	}

	async put(key: string, bytes: ArrayBuffer) {
		this.putCalls += 1;
		if (this.putCalls === this.failPutAt) throw new Error("copy failed");
		this.objects.set(key, bytes.slice(0));
	}

	async delete(keys: string | string[]) {
		if (this.failDelete) throw new Error("rollback failed");
		for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
	}
}

test("cancel recovery copies every attachment before returning draft metadata", async () => {
	const bucket = new MemoryBucket();
	const result = await prepareRecoveredDraftAttachments(bucket as never, "snapshot-1", source);

	assert.equal(result.draftId, "draft_recovered_snapshot-1");
	assert.deepEqual(result.attachments.map(({ id, email_id }) => ({ id, email_id })), [
		{ id: "recovered_attachment-1", email_id: "draft_recovered_snapshot-1" },
		{ id: "recovered_attachment-2", email_id: "draft_recovered_snapshot-1" },
	]);
	assert.equal(bucket.objects.has("attachments/snapshot-1/attachment-1/proposal.pdf"), true);
	assert.equal(bucket.objects.has("attachments/draft_recovered_snapshot-1/recovered_attachment-1/proposal.pdf"), true);
});

test("partial copy failure rolls back destinations and returns no exposed metadata", async () => {
	const bucket = new MemoryBucket();
	bucket.failPutAt = 2;

	await assert.rejects(
		prepareRecoveredDraftAttachments(bucket as never, "snapshot-1", source),
		/copy failed/,
	);
	assert.equal(bucket.objects.has("attachments/draft_recovered_snapshot-1/recovered_attachment-1/proposal.pdf"), false);
	assert.equal(bucket.objects.has("attachments/snapshot-1/attachment-1/proposal.pdf"), true);
});

test("failed rollback remains safely resumable through deterministic destination keys", async () => {
	const bucket = new MemoryBucket();
	bucket.failPutAt = 2;
	bucket.failDelete = true;
	await assert.rejects(
		prepareRecoveredDraftAttachments(bucket as never, "snapshot-1", source),
		/copy failed/,
	);

	bucket.failPutAt = undefined;
	bucket.failDelete = false;
	const resumed = await prepareRecoveredDraftAttachments(bucket as never, "snapshot-1", source);
	assert.equal(resumed.draftId, recoveredDraftId("snapshot-1"));
	assert.equal(resumed.attachments.length, 2);
	assert.equal(bucket.objects.has("attachments/snapshot-1/attachment-2/terms.txt"), true);
});

const comparableDraft = {
	folder_id: "draft",
	draft_version: 3,
	subject: "Quarterly update",
	sender: "team@example.com",
	recipient: "one@example.com, two@example.com",
	cc: "copy@example.com",
	bcc: null,
	body: "<p>Current body</p>",
	in_reply_to: "message-1",
	thread_id: "thread-1",
	attachments: [{ id: "draft-attachment-1" }],
};

const comparableSnapshot = {
	mailboxId: "team@example.com",
	draftId: "draft-1",
	draftVersion: 3,
	kind: "reply" as const,
	to: ["one@example.com", "two@example.com"],
	cc: ["copy@example.com"],
	bcc: [],
	from: "team@example.com",
	subject: "Quarterly update",
	html: "<p>Current body</p>",
	inReplyTo: "message-1",
	threadId: "thread-1",
	attachmentIds: ["snapshot-attachment-1"],
	sourceDraftAttachmentIds: ["draft-attachment-1"],
};

test("source draft equivalence requires exact content, version, and attachment identity", () => {
	assert.equal(
		sourceDraftMatchesSnapshot(comparableDraft, comparableSnapshot),
		true,
	);
	assert.equal(
		sourceDraftMatchesSnapshot(
			{ ...comparableDraft, body: "<p>Unsaved edit</p>" },
			comparableSnapshot,
		),
		false,
	);
	assert.equal(
		sourceDraftMatchesSnapshot(
			{ ...comparableDraft, attachments: [{ id: "different" }] },
			comparableSnapshot,
		),
		false,
	);
	assert.equal(
		sourceDraftMatchesSnapshot(
			{ ...comparableDraft, draft_version: 4 },
			comparableSnapshot,
		),
		false,
	);
});

test("legacy snapshots without source attachment identity recover conservatively", () => {
	const { sourceDraftAttachmentIds: _omitted, ...legacySnapshot } = comparableSnapshot;
	assert.equal(sourceDraftMatchesSnapshot(comparableDraft, legacySnapshot), false);
});
