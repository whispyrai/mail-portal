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
	const activityFolders: string[] = [];
	const outboundChecks: string[][] = [];
	const repo: BatchTriageRepository = {
		transaction(run) {
			transactions++;
			return run();
		},
		resolveFolder(folderId) {
			if (folderId === "missing" || folderId === "deleted-custom") return null;
			if (folderId === "Drafts") return "draft";
			return folderId === "Inbox" ? "inbox" : folderId;
		},
		resolveTarget(target) {
			if (target.emailId === "stale") return null;
			return {
				emailIds: target.conversationId
					? [target.emailId, `${target.emailId}-older`]
					: [target.emailId],
				folderId: target.folderId,
			};
		},
		isTargetStateSatisfied(target, targetFolderId) {
			return (
				(target.emailId === "already-archived" ||
					target.emailId === "already-archived-deleted-source" ||
					target.emailId === "archived-with-new-reply") &&
				targetFolderId === "archive"
			) || (target.emailId === "already-trashed" && targetFolderId === "trash");
		},
		hasActiveOutbound(emailIds) {
			outboundChecks.push(emailIds);
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
			activityFolders.push(target.folderId);
		},
	};
	return {
		repo,
		readUpdates,
		moves,
		activities,
		activityFolders,
		outboundChecks,
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

test("already-achieved archive and Trash targets remain successful without side effects", () => {
	const state = repository();
	const archive = executeBatchTriage(
		state.repo,
		{
			action: "archive",
			targets: [
				{ emailId: "already-archived", folderId: "inbox" },
				{
					emailId: "archived-with-new-reply",
					folderId: "inbox",
					conversationId: "thread-1",
				},
			],
		},
		{ kind: "user", id: "user-1" },
	);
	const trash = executeBatchTriage(
		state.repo,
		{
			action: "trash",
			targets: [
				{
					emailId: "already-trashed",
					folderId: "sent",
					conversationId: "thread-2",
				},
			],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(archive, {
		requestedCount: 2,
		succeededCount: 2,
		failedCount: 0,
		results: [
			{ emailId: "already-archived", status: "updated", affectedCount: 0 },
			{ emailId: "archived-with-new-reply", status: "updated", affectedCount: 0 },
		],
	});
	assert.deepEqual(trash.results, [
		{ emailId: "already-trashed", status: "updated", affectedCount: 0 },
	]);
	assert.deepEqual(state.moves, []);
	assert.deepEqual(state.activities, []);
	assert.deepEqual(state.outboundChecks, []);
});

test("partial retry aggregates preserve satisfied successes while reporting real failures", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "archive",
			targets: [
				{ emailId: "already-archived", folderId: "inbox" },
				{ emailId: "stale", folderId: "inbox" },
				{ emailId: "protected", folderId: "inbox" },
			],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(result, {
		requestedCount: 3,
		succeededCount: 1,
		failedCount: 2,
		results: [
			{ emailId: "already-archived", status: "updated", affectedCount: 0 },
			{ emailId: "stale", status: "not_found", affectedCount: 0 },
			{
				emailId: "protected",
				status: "outbound_delivery_active",
				affectedCount: 0,
			},
		],
	});
	assert.deepEqual(state.moves, []);
	assert.deepEqual(state.activities, []);
});

test("target-first recovery survives deletion of an emptied custom source folder", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "archive",
			targets: [{
				emailId: "already-archived-deleted-source",
				folderId: "deleted-custom",
			}],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(result.results, [{
		emailId: "already-archived-deleted-source",
		status: "updated",
		affectedCount: 0,
	}]);
	assert.deepEqual(state.moves, []);
	assert.deepEqual(state.activities, []);
});

test("successful alias moves record the canonical source folder", () => {
	const state = repository();
	const result = executeBatchTriage(
		state.repo,
		{
			action: "archive",
			targets: [{ emailId: "email-1", folderId: "Inbox" }],
		},
		{ kind: "user", id: "user-1" },
	);

	assert.deepEqual(result.results, [
		{ emailId: "email-1", status: "updated", affectedCount: 1 },
	]);
	assert.deepEqual(state.moves, [{ ids: ["email-1"], from: "inbox", to: "archive" }]);
	assert.deepEqual(state.activityFolders, ["inbox"]);
});
