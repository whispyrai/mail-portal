import assert from "node:assert/strict";
import test from "node:test";
import {
	reconcileSnoozedSelection,
	snoozeScopeAffectsRow,
} from "./snooze-selection.ts";

const selected = {
	id: "selected",
	conversation_id: "conversation-1",
	thread_id: "thread-1",
};

test("Return now identifies the selected message or conversation row", () => {
	assert.equal(
		snoozeScopeAffectsRow({ kind: "message", emailId: "selected" }, selected),
		true,
	);
	assert.equal(
		snoozeScopeAffectsRow(
			{
				kind: "conversation",
				conversationId: "conversation-1",
				emailId: "representative",
				folderId: "snoozed",
			},
			selected,
		),
		true,
	);
	assert.equal(
		snoozeScopeAffectsRow(
			{
				kind: "conversation",
				conversationId: "another-conversation",
				emailId: "another",
				folderId: "snoozed",
			},
			selected,
		),
		false,
	);
});

test("a completed same-view refresh closes a previously visible Snoozed selection", () => {
	const initial = reconcileSnoozedSelection(null, {
		contextKey: "mailbox/snoozed/page-1",
		folderId: "snoozed",
		selectedId: "selected",
		visibleIds: ["selected", "another"],
		isFetching: false,
		hasResolvedData: true,
	});
	assert.equal(initial.shouldClose, false);
	const fetching = reconcileSnoozedSelection(initial.tracker, {
		contextKey: "mailbox/snoozed/page-1",
		folderId: "snoozed",
		selectedId: "selected",
		visibleIds: ["selected", "another"],
		isFetching: true,
		hasResolvedData: true,
	});
	assert.equal(fetching.shouldClose, false);
	const completed = reconcileSnoozedSelection(fetching.tracker, {
		contextKey: "mailbox/snoozed/page-1",
		folderId: "snoozed",
		selectedId: "selected",
		visibleIds: ["another"],
		isFetching: false,
		hasResolvedData: true,
	});
	assert.equal(completed.shouldClose, true);
});

test("pagination, filters, and unrelated selections never look like automatic wake", () => {
	const visible = reconcileSnoozedSelection(null, {
		contextKey: "page-1/no-filter",
		folderId: "snoozed",
		selectedId: "selected",
		visibleIds: ["selected"],
		isFetching: false,
		hasResolvedData: true,
	});
	for (const contextKey of ["page-2/no-filter", "page-1/label-vip"]) {
		const transition = reconcileSnoozedSelection(visible.tracker, {
			contextKey,
			folderId: "snoozed",
			selectedId: "selected",
			visibleIds: ["other"],
			isFetching: false,
			hasResolvedData: true,
		});
		assert.equal(transition.shouldClose, false, contextKey);
	}
	const unrelated = reconcileSnoozedSelection(null, {
		contextKey: "page-1/no-filter",
		folderId: "snoozed",
		selectedId: "deep-linked",
		visibleIds: ["other"],
		isFetching: false,
		hasResolvedData: true,
	});
	assert.equal(unrelated.shouldClose, false);
	assert.equal(unrelated.tracker?.wasVisible, false);
});
