import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";
import { reconcileFollowUpReminderList } from "./follow-up-reminders.ts";

const source = readFileSync(new URL("./follow-up-reminders.ts", import.meta.url), "utf8");

function reminder(
	id: string,
	remindAt: string,
	state: FollowUpReminder["state"] = "active",
): FollowUpReminderView {
	return {
		id,
		ownerUserId: "user-1",
		mailboxAddress: "team@example.com",
		conversationKey: `conversation-${id}`,
		baselineMessageId: `message-${id}`,
		baselineMessageDate: "2026-07-11T08:00:00.000Z",
		remindAt,
		state,
		resolutionReason: state === "active" ? null : "manual",
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		resolvedAt: state === "active" ? null : 2,
		preview: {
			subject: `Subject ${id}`,
			counterparty: `${id}@example.com`,
		},
	};
}

test("reminder cache reconciliation keeps active work ordered and removes terminal work", () => {
	const later = reminder("later", "2026-07-14T08:00:00.000Z");
	const sooner = reminder("sooner", "2026-07-12T08:00:00.000Z");
	assert.deepEqual(
		reconcileFollowUpReminderList([later], sooner).map((item) => item.id),
		["sooner", "later"],
	);

	const moved = { ...later, remindAt: "2026-07-11T12:00:00.000Z", version: 2 };
	assert.deepEqual(
		reconcileFollowUpReminderList([sooner, later], moved).map((item) => item.id),
		["later", "sooner"],
	);

	const completed = {
		...moved,
		state: "completed" as const,
		resolutionReason: "manual" as const,
		resolvedAt: 3,
	};
	assert.deepEqual(
		reconcileFollowUpReminderList([sooner, moved], completed).map((item) => item.id),
		["sooner"],
	);
});

test("active reminders poll so authoritative inbound completion becomes visible", () => {
	assert.match(source, /refetchInterval: 30_000/);
});
