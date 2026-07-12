import assert from "node:assert/strict";
import test from "node:test";
import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";
import {
	FollowUpReminderApiError,
	applyFollowUpReminderOperation,
	createFollowUpReminder,
	listFollowUpReminders,
} from "./follow-up-reminders.ts";

const reminder: FollowUpReminderView = {
	id: "reminder-1",
	ownerUserId: "user-1",
	mailboxAddress: "team+sales@example.com",
	conversationKey: "conversation-1",
	baselineMessageId: "message-1",
	baselineMessageDate: "2026-07-11T08:00:00.000Z",
	remindAt: "2026-07-12T08:00:00.000Z",
	state: "active",
	resolutionReason: null,
	version: 1,
	createdAt: 1,
	updatedAt: 1,
	resolvedAt: null,
	preview: {
		subject: "Proposal",
		counterparty: "Client <client@example.com>",
	},
};

test("follow-up client mirrors owner-private route paths and strict bodies", async () => {
	const requests: Array<{ url: string; init?: RequestInit }> = [];
	const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		const payload = requests.length === 1
			? { reminders: [reminder], nextCursor: null }
			: { reminder };
		return Response.json(payload);
	};

	assert.deepEqual(
		await listFollowUpReminders("team+sales@example.com", 25, fetcher),
		[reminder],
	);
	await createFollowUpReminder(
		"team+sales@example.com",
		{
			emailId: "message-1",
			remindAt: reminder.remindAt,
			idempotencyKey: "create-0001",
		},
		fetcher,
	);
	await applyFollowUpReminderOperation(
		"team+sales@example.com",
		"reminder/1",
		{
			action: "snooze",
			operationId: "snooze-0001",
			expectedVersion: 1,
			remindAt: "2026-07-13T08:00:00.000Z",
		},
		fetcher,
	);

	assert.equal(
		requests[0]?.url,
		"/api/v1/mailboxes/team%2Bsales%40example.com/follow-up-reminders?limit=25",
	);
	assert.equal(requests[0]?.init?.credentials, "same-origin");
	assert.equal(requests[1]?.init?.method, "POST");
	assert.deepEqual(JSON.parse(String(requests[1]?.init?.body)), {
		emailId: "message-1",
		remindAt: reminder.remindAt,
		idempotencyKey: "create-0001",
	});
	assert.equal(
		requests[2]?.url,
		"/api/v1/mailboxes/team%2Bsales%40example.com/follow-up-reminders/reminder%2F1/operations",
	);
	assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
		action: "snooze",
		operationId: "snooze-0001",
		expectedVersion: 1,
		remindAt: "2026-07-13T08:00:00.000Z",
	});
});

test("follow-up client fetches every page and safely de-duplicates moving rows", async () => {
	const requests: string[] = [];
	const rows = Array.from({ length: 101 }, (_, index): FollowUpReminderView => ({
		...reminder,
		id: `reminder-${String(index).padStart(3, "0")}`,
		conversationKey: `conversation-${index}`,
		baselineMessageId: `message-${index}`,
		remindAt: new Date(Date.parse(reminder.remindAt) + index * 1_000).toISOString(),
		preview: {
			subject: `Subject ${index}`,
			counterparty: `person-${index}@example.com`,
		},
	}));
	const moved = { ...rows[49]!, version: 2, updatedAt: 2 };
	const fetcher = async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		return requests.length === 1
			? Response.json({ reminders: rows.slice(0, 100), nextCursor: "page-2" })
			: Response.json({ reminders: [moved, rows[100]], nextCursor: null });
	};

	const listed = await listFollowUpReminders("team@example.com", 100, fetcher);
	assert.equal(listed.length, 101);
	assert.equal(listed.find((row) => row.id === moved.id)?.version, 2);
	assert.deepEqual(requests, [
		"/api/v1/mailboxes/team%40example.com/follow-up-reminders?limit=100",
		"/api/v1/mailboxes/team%40example.com/follow-up-reminders?limit=100&cursor=page-2",
	]);
});

test("follow-up client fails closed when a server cursor repeats", async () => {
	const fetcher = async () => Response.json({ reminders: [], nextCursor: "same" });
	await assert.rejects(
		() => listFollowUpReminders("team@example.com", 100, fetcher),
		/pagination did not advance/,
	);
});

test("follow-up client preserves typed conflict details for recovery", async () => {
	const fetcher = async () => Response.json(
		{
			error: "Reminder changed; refresh before retrying",
			code: "STATE_CONFLICT",
		},
		{ status: 409 },
	);

	await assert.rejects(
		() => applyFollowUpReminderOperation(
			"team@example.com",
			"reminder-1",
			{
				action: "complete",
				operationId: "complete-0001",
				expectedVersion: 1,
			},
			fetcher,
		),
		(error: unknown) => {
			assert.ok(error instanceof FollowUpReminderApiError);
			assert.equal(error.status, 409);
			assert.equal(error.code, "STATE_CONFLICT");
			return true;
		},
	);
});
