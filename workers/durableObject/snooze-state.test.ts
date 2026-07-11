import assert from "node:assert/strict";
import test from "node:test";
import type { ActivityActor } from "../lib/activity.ts";
import type { SnoozeRequest } from "../lib/snooze.ts";
import {
	executeSnooze,
	executeUnsnooze,
	type SnoozeRepository,
} from "./snooze-state.ts";

function state(overrides: Partial<SnoozeRepository> = {}) {
	const snoozed: unknown[] = [];
	const cleared: unknown[] = [];
	const activity: unknown[] = [];
	const repo: SnoozeRepository = {
		transaction: (run) => run(),
		resolveScope: (_scope, mode) => mode === "snooze"
			? [{ id: "mail_1", folderId: "inbox", sourceFolderId: null }]
			: [{ id: "mail_1", folderId: "snoozed", sourceFolderId: "archive" }],
		hasActiveOutbound: () => false,
		folderExists: (folderId) => folderId !== "removed",
		applySnooze: (input) => snoozed.push(input),
		clearSnooze: (input) => cleared.push(input),
		recordActivity: (input) => activity.push(input),
		...overrides,
	};
	return { repo, snoozed, cleared, activity };
}

const actor: ActivityActor = { kind: "user", id: "usr_1" };
const request: SnoozeRequest = {
	scope: { kind: "message", emailId: "mail_1" },
	wakeAt: "2026-07-12T08:00:00.000Z",
};

test("snooze moves the exact validated scope and attributes one activity", () => {
	const current = state();
	assert.deepEqual(executeSnooze(current.repo, request, actor), {
		status: "snoozed",
		affectedCount: 1,
	});
	assert.deepEqual(current.snoozed, [{
		emailIds: ["mail_1"],
		sourceFolderId: "inbox",
		wakeAt: request.wakeAt,
	}]);
	assert.deepEqual(current.activity, [{
		actor,
		action: "email_snoozed",
		entityType: "email",
		entityId: "mail_1",
		metadata: {
			fromFolderId: "inbox",
			wakeAt: request.wakeAt,
			affectedCount: 1,
		},
	}]);
});

test("snooze fails closed for stale, ineligible, oversized, or outbound scopes", () => {
	for (const [repo, status] of [
		[state({ resolveScope: () => null }), "not_found"],
		[state({ resolveScope: () => [{ id: "x", folderId: "sent", sourceFolderId: null }] }), "ineligible"],
		[state({ resolveScope: () => Array.from({ length: 101 }, (_, index) => ({ id: String(index), folderId: "inbox", sourceFolderId: null })) }), "too_large"],
		[state({ resolveScope: () => ({ tooLarge: true }) }), "too_large"],
		[state({ hasActiveOutbound: () => true }), "outbound_delivery_active"],
	] as const) {
		assert.equal(executeSnooze(repo.repo, request, actor).status, status);
		assert.deepEqual(repo.snoozed, []);
	}
});

test("unsnooze clears state with per-message source restoration and Inbox fallback", () => {
	const current = state({
		resolveScope: () => [
			{ id: "a", folderId: "snoozed", sourceFolderId: "archive" },
			{ id: "b", folderId: "snoozed", sourceFolderId: "removed" },
		],
	});
	const scope = {
		kind: "conversation" as const,
		conversationId: "conversation_1",
		emailId: "a",
		folderId: "snoozed",
	};
	assert.deepEqual(executeUnsnooze(current.repo, scope, actor), {
		status: "unsnoozed",
		affectedCount: 2,
	});
	assert.deepEqual(current.cleared, [{
		targets: [
			{ id: "a", folderId: "archive" },
			{ id: "b", folderId: "inbox" },
		],
	}]);
	assert.equal((current.activity[0] as { action: string }).action, "conversation_unsnoozed");
});
