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
	promotionOwner: "claim-1",
};

function harness(
	authoritative: unknown,
	outcome: {
		status: "missing" | "key_conflict" | "claimed" | "committed" | "aborted";
		draftId?: string;
		committedVersion?: number | null;
		claimToken?: string | null;
	} = {
		status: "committed",
		draftId: "draft-1",
		committedVersion: 4,
		claimToken: "claim-committed",
	},
	lookupError?: Error,
) {
	const deleted: string[][] = [];
	return {
		deleted,
		bucket: {
			async get(key: string) {
				return key === promotion.destinationKeys[0]
					? { customMetadata: { promotionOwner: promotion.promotionOwner } }
					: null;
			},
			async delete(keys: string | string[]) {
				deleted.push(Array.isArray(keys) ? keys : [keys]);
			},
		},
		stub: {
			async getAttachment() { return null; },
			async getEmail() {
				return authoritative;
			},
			async getDraftSaveOutcome() {
				if (lookupError) throw lookupError;
				return outcome;
			},
			async abortDraftSave() {
				return { status: "aborted" as const, destinationKeys: promotion.destinationKeys };
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
		saveKey: "save-1",
		saveFingerprint: "fingerprint-1",
		promotion,
		replacedAttachments: [{ id: "old-attachment", filename: "old.pdf" }],
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "committed");
	assert.equal(
		result.status === "committed" ? result.attachmentIdentityScope : null,
		"claim-committed",
	);
	assert.deepEqual(h.deleted, [
		["uploads/team/upload-1"],
		["attachments/draft-1/old-attachment/old.pdf"],
	]);
});

test("ambiguous recovery returns the authoritative replacement claim scope", async () => {
	const draft = {
		id: "draft-1",
		folder_id: "draft",
		draft_version: 4,
		attachments: [{ ...promotion.storedMetadata[0] }],
	};
	const h = harness(draft, {
		status: "committed",
		draftId: "draft-1",
		committedVersion: 4,
		claimToken: "claim-replacement",
	});
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 4,
		saveKey: "save-1",
		saveFingerprint: "fingerprint-1",
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "committed");
	assert.equal(
		result.status === "committed" ? result.attachmentIdentityScope : null,
		"claim-replacement",
	);
});

test("an authoritative miss rolls back new draft objects", async () => {
	const h = harness(null, { status: "missing" });
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 1,
		saveKey: "save-1",
		saveFingerprint: "fingerprint-1",
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "not_committed");
	assert.deepEqual(h.deleted, [["attachments/draft-1/new-attachment/new.pdf"]]);
});

test("an unavailable read never deletes possibly committed draft objects", async () => {
	const h = harness(
		null,
		{ status: "missing" },
		new Error("mailbox unavailable"),
	);
	const result = await reconcileAmbiguousDraftSave({
		bucket: h.bucket as never,
		stub: h.stub as never,
		draftId: "draft-1",
		expectedCommittedVersion: 1,
		saveKey: "save-1",
		saveFingerprint: "fingerprint-1",
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "indeterminate");
	assert.deepEqual(h.deleted, []);
});

test("a committed claim with a different authoritative version prevents cleanup", async () => {
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
		saveKey: "save-1",
		saveFingerprint: "fingerprint-1",
		promotion,
		replacedAttachments: [],
		actor: { kind: "user", id: "user-1" },
	});
	assert.equal(result.status, "indeterminate");
	assert.deepEqual(h.deleted, []);
});
