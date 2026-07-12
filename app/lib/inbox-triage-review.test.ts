import assert from "node:assert/strict";
import test from "node:test";
import {
	createInboxTriageRequestController,
	createInboxTriageReviewSelection,
	createInboxTriageVisibleSnapshot,
	planInboxTriageApply,
	reconcileInboxTriageApplyResult,
	toggleInboxTriageReviewSelection,
} from "./inbox-triage-review.ts";
import type { InboxTriageSuggestion } from "../services/inbox-triage-suggestions.ts";

const firstSnapshot = createInboxTriageVisibleSnapshot({
	mailboxId: "team@example.com",
	folderId: "inbox",
	page: 1,
	labelId: null,
	emails: [
		{
			id: "message-1",
			conversation_id: "conversation-current",
			folder_id: "inbox",
			subject: "Launch",
			sender: "alice@example.com",
			recipient: "team@example.com",
			date: "2026-07-12T08:00:00.000Z",
			read: false,
			starred: false,
			thread_count: 2,
			thread_unread_count: 1,
			participants: "alice@example.com,team@example.com",
			has_draft: false,
		},
	],
});

test("every relevant visible row change makes an old Inbox review stale", () => {
	for (const changed of [
		{ ...firstSnapshot, mailboxId: "other@example.com" },
		{ ...firstSnapshot, page: 2 },
		{ ...firstSnapshot, labelId: "priority" },
		{
			...firstSnapshot,
			rows: firstSnapshot.rows.map((row) => ({ ...row, id: "message-2" })),
		},
		{
			...firstSnapshot,
			rows: firstSnapshot.rows.map((row) => ({ ...row, read: true })),
		},
		{
			...firstSnapshot,
			rows: firstSnapshot.rows.map((row) => ({
				...row,
				date: "2026-07-12T09:00:00.000Z",
			})),
		},
	]) {
		const requests = createInboxTriageRequestController();
		const request = requests.begin(firstSnapshot);
		assert.ok(request);
		assert.equal(requests.isCurrent(request, changed), false);
	}
});

test("explicit apply resolves exact targets from the current visible snapshot", () => {
	const suggestions: InboxTriageSuggestion[] = [
		{
			candidateId: "candidate-1",
			emailId: "message-1",
			conversationId: "conversation-from-untrusted-response",
			action: "archive",
			explanation: "Routine update with no requested reply.",
			messageIds: ["message-1"],
			requiresHumanReview: true,
		},
	];
	assert.deepEqual(
		planInboxTriageApply({
			action: "archive",
			suggestions,
			selectedSuggestionIds: new Set(["candidate-1"]),
			responseSnapshot: firstSnapshot,
			currentSnapshot: firstSnapshot,
		}),
		{
			state: "ready",
			command: {
				action: "archive",
				targets: [
					{
						emailId: "message-1",
						folderId: "inbox",
						conversationId: "conversation-current",
					},
				],
			},
		},
	);
	assert.deepEqual(
		planInboxTriageApply({
			action: "archive",
			suggestions,
			selectedSuggestionIds: new Set(["candidate-1"]),
			responseSnapshot: firstSnapshot,
			currentSnapshot: {
				...firstSnapshot,
				rows: firstSnapshot.rows.map((row) => ({ ...row, read: true })),
			},
		}),
		{ state: "stale" },
	);
});

test("explicit apply always carries canonical Conversation identity and fails closed without it", () => {
	const suggestion: InboxTriageSuggestion = {
		candidateId: "candidate-1",
		emailId: "message-1",
		conversationId: null,
		action: "mark_read",
		explanation: "Routine update.",
		messageIds: ["message-1"],
		requiresHumanReview: true,
	};
	const singleton = {
		...firstSnapshot,
		rows: firstSnapshot.rows.map((row) => ({ ...row, threadCount: 1 })),
	};
	assert.deepEqual(
		planInboxTriageApply({
			action: "mark_read",
			suggestions: [suggestion],
			selectedSuggestionIds: new Set(["candidate-1"]),
			responseSnapshot: singleton,
			currentSnapshot: singleton,
		}),
		{
			state: "ready",
			command: {
				action: "mark_read",
				targets: [
					{
						emailId: "message-1",
						folderId: "inbox",
						conversationId: "conversation-current",
					},
				],
			},
		},
	);
	const withoutConversation = {
		...singleton,
		rows: singleton.rows.map((row) => ({ ...row, conversationId: null })),
	};
	assert.deepEqual(
		planInboxTriageApply({
			action: "mark_read",
			suggestions: [suggestion],
			selectedSuggestionIds: new Set(["candidate-1"]),
			responseSnapshot: withoutConversation,
			currentSnapshot: withoutConversation,
		}),
		{ state: "stale" },
	);
});

test("review selection is independent and partial results retain only failed suggestions", () => {
	const suggestions: InboxTriageSuggestion[] = [
		{
			candidateId: "archive-1",
			emailId: "message-1",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: ["message-1"],
			requiresHumanReview: true,
		},
		{
			candidateId: "archive-2",
			emailId: "message-2",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: ["message-2"],
			requiresHumanReview: true,
		},
		{
			candidateId: "read-1",
			emailId: "message-3",
			conversationId: null,
			action: "mark_read",
			explanation: "No response requested.",
			messageIds: ["message-3"],
			requiresHumanReview: true,
		},
	];
	const initial = createInboxTriageReviewSelection(suggestions);
	assert.deepEqual([...initial], ["archive-1", "archive-2", "read-1"]);
	const changed = toggleInboxTriageReviewSelection(initial, "read-1");
	assert.deepEqual([...initial], ["archive-1", "archive-2", "read-1"]);
	assert.deepEqual([...changed], ["archive-1", "archive-2"]);

	assert.deepEqual(
		reconcileInboxTriageApplyResult({
			action: "archive",
			suggestions,
			selectedSuggestionIds: initial,
			result: {
				requestedCount: 2,
				succeededCount: 1,
				failedCount: 1,
				results: [
					{ emailId: "message-1", status: "updated", affectedCount: 1 },
					{ emailId: "message-2", status: "not_found", affectedCount: 0 },
				],
			},
		}),
		{
			suggestions: [suggestions[1], suggestions[2]],
			selectedSuggestionIds: new Set(["archive-2", "read-1"]),
			failedSuggestionIds: new Set(["archive-2"]),
		},
	);
});

test("Inbox triage allows only one request for one exact visible snapshot", () => {
	const requests = createInboxTriageRequestController();
	const first = requests.begin(firstSnapshot);
	assert.ok(first);
	assert.equal(requests.begin(firstSnapshot), null);
	assert.equal(requests.isCurrent(first, firstSnapshot), true);

	assert.equal(requests.finish(first), true);
	const second = requests.begin(firstSnapshot);
	assert.ok(second);
	assert.notEqual(second.requestToken, first.requestToken);
	assert.equal(requests.finish(first), false);
	assert.equal(requests.isCurrent(second, firstSnapshot), true);
});

test("closing review aborts its active generation and invalidates a late response", () => {
	const requests = createInboxTriageRequestController();
	const request = requests.begin(firstSnapshot);
	assert.ok(request);
	requests.cancel();
	assert.equal(request.controller.signal.aborted, true);
	assert.equal(requests.isCurrent(request, firstSnapshot), false);
	assert.ok(requests.begin(firstSnapshot));
});
