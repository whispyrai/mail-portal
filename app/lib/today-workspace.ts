import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders";

export function reminderAccessibleContext(
	reminder: FollowUpReminderView,
	dueLabel: string,
) {
	const subject = reminder.preview?.subject.trim() || "Conversation unavailable";
	const counterparty = reminder.preview?.counterparty.trim() || "Original message unavailable";
	return `${subject} with ${counterparty}, due ${dueLabel}`;
}

export function nextLocalMidnight(now = new Date()): Date {
	const midnight = new Date(now);
	midnight.setHours(24, 0, 0, 0);
	return midnight;
}

export function reminderOperationId(action: string, reminderId: string): string {
	const randomPart =
		typeof crypto !== "undefined" && "randomUUID" in crypto
			? crypto.randomUUID()
			: `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	return `today-${action}-${reminderId}-${randomPart}`;
}

export function reminderOperationIdentity(input: {
	mailboxId: string;
	reminderId: string;
	action: "complete" | "dismiss" | "snooze";
	expectedVersion: number;
	remindAt?: string;
}): string {
	return JSON.stringify([
		input.mailboxId,
		input.reminderId,
		input.action,
		input.expectedVersion,
		input.remindAt ?? null,
	]);
}

export function stableReminderOperationId(
	operationIds: Map<string, string>,
	identity: string,
	createId = () => reminderOperationId("operation", "reminder"),
): string {
	const existing = operationIds.get(identity);
	if (existing) return existing;
	const created = createId();
	operationIds.set(identity, created);
	return created;
}

export function reminderRescheduleTime(
	preset: "tomorrow" | "next_week",
	now = new Date(),
): Date {
	const result = new Date(now);
	if (preset === "tomorrow") {
		result.setDate(result.getDate() + 1);
	} else {
		const daysAhead = ((8 - result.getDay()) % 7) || 7;
		result.setDate(result.getDate() + daysAhead);
	}
	result.setHours(9, 0, 0, 0);
	return result;
}

export function activeReminderCount(reminders: readonly FollowUpReminder[]) {
	return reminders.reduce(
		(count, reminder) => count + (reminder.state === "active" ? 1 : 0),
		0,
	);
}
