import assert from "node:assert/strict";
import test from "node:test";
import {
	activeReminderCount,
	nextLocalMidnight,
	reminderAccessibleContext,
	reminderOperationIdentity,
	reminderOperationId,
	reminderRescheduleTime,
	stableReminderOperationId,
} from "./today-workspace.ts";
import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";

function reminder(state: FollowUpReminder["state"]): FollowUpReminder {
	return {
		id: `reminder-${state}`,
		ownerUserId: "user-1",
		mailboxAddress: "team@example.com",
		conversationKey: "conversation-1",
		baselineMessageId: "message-1",
		baselineMessageDate: "2026-07-10T10:00:00.000Z",
		remindAt: "2026-07-11T10:00:00.000Z",
		state,
		resolutionReason: null,
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		resolvedAt: null,
	};
}

test("nextLocalMidnight uses the next local calendar boundary", () => {
	const result = nextLocalMidnight(new Date(2026, 6, 11, 23, 45));
	assert.equal(result.getFullYear(), 2026);
	assert.equal(result.getMonth(), 6);
	assert.equal(result.getDate(), 12);
	assert.equal(result.getHours(), 0);
	assert.equal(result.getMinutes(), 0);
});

test("reminder reschedule presets use calm local workday times", () => {
	const friday = new Date(2026, 6, 10, 15, 30);
	const tomorrow = reminderRescheduleTime("tomorrow", friday);
	const nextWeek = reminderRescheduleTime("next_week", friday);
	assert.equal(tomorrow.getDate(), 11);
	assert.equal(tomorrow.getHours(), 9);
	assert.equal(nextWeek.getDay(), 1);
	assert.equal(nextWeek.getHours(), 9);
});

test("operation IDs are stable for an exact retry payload until confirmed", () => {
	const operationIds = new Map<string, string>();
	const payload = {
		mailboxId: "team@example.com",
		reminderId: "reminder-1",
		action: "snooze" as const,
		expectedVersion: 3,
		remindAt: "2026-07-13T07:00:00.000Z",
	};
	const identity = reminderOperationIdentity(payload);
	let sequence = 0;
	const createId = () => `operation-${++sequence}`;
	assert.equal(stableReminderOperationId(operationIds, identity, createId), "operation-1");
	assert.equal(stableReminderOperationId(operationIds, identity, createId), "operation-1");
	assert.equal(sequence, 1);

	const changedTime = reminderOperationIdentity({
		...payload,
		remindAt: "2026-07-14T07:00:00.000Z",
	});
	assert.equal(stableReminderOperationId(operationIds, changedTime, createId), "operation-2");
	operationIds.delete(identity);
	assert.equal(stableReminderOperationId(operationIds, identity, createId), "operation-3");
});

test("Today counts only active personal reminders and creates unique operation IDs", () => {
	assert.equal(
		activeReminderCount([
			reminder("active"),
			reminder("completed"),
			reminder("dismissed"),
		]),
		1,
	);
	const first = reminderOperationId("complete", "reminder-1");
	const second = reminderOperationId("complete", "reminder-1");
	assert.match(first, /^today-complete-reminder-1-/);
	assert.notEqual(first, second);
});

test("duplicate subjects and missing previews keep distinct accessible action context", () => {
	const base = reminder("active");
	const first: FollowUpReminderView = {
		...base,
		id: "reminder-1",
		preview: { subject: "Renewal", counterparty: "Alice" },
	};
	const second: FollowUpReminderView = {
		...base,
		id: "reminder-2",
		preview: { subject: "Renewal", counterparty: "Bob" },
	};
	assert.notEqual(
		reminderAccessibleContext(first, "today at 9:00 AM"),
		reminderAccessibleContext(second, "today at 10:00 AM"),
	);
	assert.equal(
		reminderAccessibleContext({ ...base, preview: null }, "Friday at 2:00 PM"),
		"Conversation unavailable with Original message unavailable, due Friday at 2:00 PM",
	);
	assert.notEqual(
		reminderAccessibleContext({ ...base, id: "missing-1", preview: null }, "Friday at 2:00 PM"),
		reminderAccessibleContext({ ...base, id: "missing-2", preview: null }, "Friday at 3:00 PM"),
	);
});
