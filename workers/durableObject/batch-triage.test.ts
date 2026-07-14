import assert from "node:assert/strict";
import test from "node:test";
import {
	executeBatchTriage,
	type BatchTriageRepository,
} from "./batch-triage.ts";

function repository() {
	let transactions = 0;
	const readUpdates: Array<{ ids: string[]; read: boolean }> = [];
	const moves: Array<{ ids: string[]; from: string; to: string }> = [];
	const activities: string[] = [];
	const repo: BatchTriageRepository = {
		transaction(run) {
			transactions++;
			return run();
		},
		resolveTarget(target) {
			if (target.emailId === "stale") return null;
			return {
				emailIds: target.conversationId
					? [target.emailId, `${target.emailId}-older`]
					: [target.emailId],
				folderId:
					target.folderId === "Drafts" ? "draft" : target.folderId,
			};
		},
		hasActiveOutbound(emailIds) {
			return emailIds.includes("protected");
		},
		setRead(emailIds, read) {
			readUpdates.push({ ids: emailIds, read });
			return emailIds.includes("already") ? 0 : emailIds.length;
		},
		move(emailIds, fromFolderId, toFolderId) {
			moves.push({ ids: emailIds, from: fromFolderId, to: toFolderId });
		},
		recordActivity({ target }) {
			activities.push(target.emailId);
		},
	};
	return {
		repo,
		readUpdates,
		moves,
		activities,
		transactionCount: () => transactions,
	};
}

test("DO batch helper applies successful targets once and reports stale rows", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "mark_unread",
			targets: [
				{ emailId: "email-1", folderId: "inbox", conversationId: "thread-1" },
				{ emailId: "stale", folderId: "inbox" },
			],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.equal(state.transactionCount(), 1);
	assert.deepEqual(state.readUpdates, [
		{ ids: ["email-1", "email-1-older"], read: false },
	]);
	assert.deepEqual(result, {
		requestedCount: 2,
		succeededCount: 1,
		failedCount: 1,
		results: [
			{ emailId: "email-1", status: "updated", affectedCount: 2 },
			{ emailId: "stale", status: "not_found", affectedCount: 0 },
		],
	});
});

test("already-satisfied batch read remains successful without false activity", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "mark_read",
			targets: [{ emailId: "already", folderId: "inbox" }],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(result, {
		requestedCount: 1,
		succeededCount: 1,
		failedCount: 0,
		results: [
			{ emailId: "already", status: "updated", affectedCount: 0 },
		],
	});
	assert.deepEqual(state.activities, []);
});

test("DO batch helper never moves protected or folder-ineligible targets", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "archive",
			targets: [
				{ emailId: "protected", folderId: "inbox" },
				{ emailId: "sent-email", folderId: "sent" },
				{ emailId: "email-1", folderId: "inbox" },
			],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.equal(state.transactionCount(), 1);
	assert.deepEqual(state.moves, [{ ids: ["email-1"], from: "inbox", to: "archive" }]);
	assert.deepEqual(result.results.map(({ status }) => status), [
		"outbound_delivery_active",
		"invalid_action",
		"updated",
	]);
});

test("DO batch helper applies folder policy after canonical folder resolution", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "trash",
			targets: [{ emailId: "draft-1", folderId: "Drafts" }],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(state.moves, []);
	assert.deepEqual(result.results, [
		{ emailId: "draft-1", status: "invalid_action", affectedCount: 0 },
	]);
});
