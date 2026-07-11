import assert from "node:assert/strict";
import test from "node:test";
import {
	planBulkEnqueueReconciliation,
	reconcileAmbiguousOutboundEnqueue,
} from "./outbound-enqueue-recovery.ts";

function promotion() {
	return {
		sesAttachments: [],
		storedMetadata: [],
		stagingKeys: ["uploads/team/upload-1"],
		destinationKeys: ["attachments/email-1/attachment-1/file.pdf"],
	};
}

function harness(authoritative: unknown, lookupError?: Error) {
	const deleted: string[][] = [];
	return {
		deleted,
		bucket: {
			async delete(keys: string | string[]) {
				deleted.push(Array.isArray(keys) ? keys : [keys]);
			},
		},
		stub: {
			async getAttachment() { return null; },
			async getOutboundDeliveryByIdempotencyKey() {
				if (lookupError) throw lookupError;
				return authoritative;
			},
			async queueAttachmentCleanup() {},
		},
	};
}

test("a committed enqueue keeps its destination bytes after an ambiguous RPC error", async () => {
	const h = harness({ id: "delivery-1", emailId: "email-1", status: "queued", undoUntil: "2026-07-11T10:00:10.000Z" });
	const result = await reconcileAmbiguousOutboundEnqueue({
		bucket: h.bucket as never,
		stub: h.stub as never,
		idempotencyKey: "action-1",
		attemptedEmailId: "email-1",
		promotion: promotion(),
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "committed");
	assert.deepEqual(h.deleted, [["uploads/team/upload-1"]]);
});

test("a concurrent replay removes only this request's orphan destination", async () => {
	const h = harness({ id: "delivery-existing", emailId: "email-existing", status: "queued", undoUntil: "2026-07-11T10:00:10.000Z" });
	const result = await reconcileAmbiguousOutboundEnqueue({
		bucket: h.bucket as never,
		stub: h.stub as never,
		idempotencyKey: "action-1",
		attemptedEmailId: "email-1",
		promotion: promotion(),
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "committed");
	assert.deepEqual(h.deleted, [
		["attachments/email-1/attachment-1/file.pdf"],
		["uploads/team/upload-1"],
	]);
});

test("an unavailable authoritative read never deletes possibly committed bytes", async () => {
	const h = harness(null, new Error("mailbox unavailable"));
	const result = await reconcileAmbiguousOutboundEnqueue({
		bucket: h.bucket as never,
		stub: h.stub as never,
		idempotencyKey: "action-1",
		attemptedEmailId: "email-1",
		promotion: promotion(),
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "indeterminate");
	assert.deepEqual(h.deleted, []);
});

test("an authoritative miss proves rollback is safe", async () => {
	const h = harness(null);
	const result = await reconcileAmbiguousOutboundEnqueue({
		bucket: h.bucket as never,
		stub: h.stub as never,
		idempotencyKey: "action-1",
		attemptedEmailId: "email-1",
		promotion: promotion(),
		actor: { kind: "user", id: "user-1" },
	});

	assert.equal(result.status, "not_committed");
	assert.deepEqual(h.deleted, [["attachments/email-1/attachment-1/file.pdf"]]);
});

test("bulk reconciliation preserves authoritative bytes and counts a post-commit failure as accepted", () => {
	assert.deepEqual(
		planBulkEnqueueReconciliation(
			{ id: "delivery-1", emailId: "email-1", status: "queued", undoUntil: "later" },
			"email-1",
		),
		{ status: "committed", deleteAttemptedBytes: false },
	);
});

test("bulk reconciliation deletes only replay or definitively uncommitted bytes", () => {
	assert.deepEqual(
		planBulkEnqueueReconciliation(
			{ id: "delivery-existing", emailId: "email-existing", status: "queued", undoUntil: "later" },
			"email-1",
		),
		{ status: "committed", deleteAttemptedBytes: true },
	);
	assert.deepEqual(
		planBulkEnqueueReconciliation(null, "email-1"),
		{ status: "not_committed", deleteAttemptedBytes: true },
	);
});
