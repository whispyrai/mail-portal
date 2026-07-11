import assert from "node:assert/strict";
import test from "node:test";
import {
	outboundDeliveryBlocksGenericLifecycle,
	planMove,
	planTrash,
	resolveRestoreFolder,
} from "./email-lifecycle.ts";

test("active Outbox deliveries require explicit cancellation before generic lifecycle changes", () => {
	for (const status of ["queued", "sending", "retrying"] as const) {
		assert.equal(outboundDeliveryBlocksGenericLifecycle(status), true);
	}
	for (const status of [
		"sent",
		"bounced",
		"failed",
		"unknown",
		"cancelled",
	] as const) {
		assert.equal(outboundDeliveryBlocksGenericLifecycle(status), false);
	}
});

test("ordinary delete plans a reversible move to Trash", () => {
	assert.deepEqual(planTrash("archive"), {
		status: "trash",
		previousFolderId: "archive",
	});
});

test("ordinary delete never plans permanent deletion for mail already in Trash", () => {
	assert.deepEqual(planTrash("trash"), { status: "already_trashed" });
});

test("restore returns to the recorded folder when it still exists", () => {
	assert.equal(resolveRestoreFolder("archive", true), "archive");
});

test("restore falls back to Inbox when the recorded folder was removed", () => {
	assert.equal(resolveRestoreFolder("receipts", false), "inbox");
});

test("restore never targets Trash", () => {
	assert.equal(resolveRestoreFolder("trash", true), "inbox");
});

test("moving to Trash uses the reversible trash lifecycle", () => {
	assert.deepEqual(planMove("archive", "trash"), { kind: "trash" });
});

test("moving out of Trash clears stale restoration metadata", () => {
	assert.deepEqual(planMove("trash", "archive"), {
		kind: "move",
		clearTrashMetadata: true,
	});
	assert.deepEqual(planMove("inbox", "archive"), {
		kind: "move",
		clearTrashMetadata: false,
	});
});
