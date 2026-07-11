import assert from "node:assert/strict";
import test from "node:test";
import { reconcileAmbiguousDraftSave } from "./draft-save-recovery.ts";

const promotion = {
	sesAttachments: [],
	storedMetadata: [{
		id: "new-attachment",
		email_id: "draft-1",
		filename: "new.pdf",
		mimetype: "application/pdf",
		size: 3,
		content_id: null,
		disposition: "attachment",
	}],
	stagingKeys: ["uploads/team/upload-1"],
	destinationKeys: ["attachments/draft-1/new-attachment/new.pdf"],
};

function harness(authoritative: unknown, lookupError?: Error) {
	const deleted: string[][] = [];
	return {
		deleted,
		bucket: { async delete(keys: string | string[]) { deleted.push(Array.isArray(keys) ? keys : [keys]); } },
		stub: {
			async getAttachment() { return null; },
			async getEmail() {
				if (lookupError) throw lookupError;
				return authoritative;
			},
			async queueAttachmentCleanup() {},
		},
	};
}

test("a committed draft save retains new objects and cleans staging plus replaced objects", async () => {
	const draft = {
		id: "draft-1",
		folder_id: "draft",
		draft_version: 4,
		attachments: [{ ...promotion.storedMetadata[0] }],
	};
	const h = harness(draft);
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 4,
		promotion,
		replacedAttachments: [{ id: "old-attachment", filename: "old.pdf" }],
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "committed");
	assert.deepEqual(h.deleted, [
		["uploads/team/upload-1"],
		["attachments/draft-1/old-attachment/old.pdf"],
	]);
});

test("an authoritative miss rolls back new draft objects", async () => {
	const h = harness(null);
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 1,
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "not_committed");
	assert.deepEqual(h.deleted, [["attachments/draft-1/new-attachment/new.pdf"]]);
});

test("an unavailable read never deletes possibly committed draft objects", async () => {
	const h = harness(null, new Error("mailbox unavailable"));
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 1,
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "indeterminate");
	assert.deepEqual(h.deleted, []);
});

test("a newer concurrent draft that still references promoted bytes prevents rollback", async () => {
	const h = harness({
		id: "draft-1",
		folder_id: "draft",
		draft_version: 5,
		attachments: [{ ...promotion.storedMetadata[0] }],
	});
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 4,
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "indeterminate");
	assert.deepEqual(h.deleted, []);
});
