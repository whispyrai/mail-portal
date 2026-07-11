import assert from "node:assert/strict";
import test from "node:test";
import {
	batchSelectionsEqual,
	batchSelectionContextKey,
	reconcileVisibleSelection,
	selectAllVisible,
	toggleVisibleSelection,
} from "./batch-selection.ts";

test("select all and toggles never add IDs outside the visible page", () => {
	const visible = ["email-1", "email-2", "email-3"];
	assert.deepEqual([...selectAllVisible(new Set(["hidden"]), visible)], visible);
	assert.deepEqual(
		[...toggleVisibleSelection(new Set(["email-1"]), "hidden", visible)],
		["email-1"],
	);
	assert.deepEqual(
		[...toggleVisibleSelection(new Set(["email-1"]), "email-2", visible)],
		["email-1", "email-2"],
	);
});

test("selection is intersected with current visible rows after refetch", () => {
	assert.deepEqual(
		[...reconcileVisibleSelection(new Set(["email-1", "email-2"]), ["email-2", "email-3"])],
		["email-2"],
	);
	assert.equal(
		batchSelectionsEqual(new Set(["email-1"]), new Set(["email-2"])),
		false,
	);
});

test("mailbox, folder, page, and search changes produce a new selection context", () => {
	const base = batchSelectionContextKey({
		mailboxId: "team@example.com",
		folderId: "inbox",
		page: 1,
		searchQuery: "",
	});
	assert.notEqual(base, batchSelectionContextKey({ mailboxId: "other@example.com", folderId: "inbox", page: 1, searchQuery: "" }));
	assert.notEqual(base, batchSelectionContextKey({ mailboxId: "team@example.com", folderId: "archive", page: 1, searchQuery: "" }));
	assert.notEqual(base, batchSelectionContextKey({ mailboxId: "team@example.com", folderId: "inbox", page: 2, searchQuery: "" }));
	assert.notEqual(base, batchSelectionContextKey({ mailboxId: "team@example.com", folderId: "inbox", page: 1, searchQuery: "proposal" }));
});
