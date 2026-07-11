export type FollowUpReminderState = "active" | "completed" | "dismissed";
export type FollowUpReminderResolution =
	| "manual"
	| "inbound_reply"
	| "dismissed";

/** Personal productivity state. It is never mailbox assignment or team status. */
export interface FollowUpReminder {
	id: string;
	ownerUserId: string;
	mailboxAddress: string;
	conversationKey: string;
	baselineMessageId: string;
	baselineMessageDate: string;
	remindAt: string;
	state: FollowUpReminderState;
	resolutionReason: FollowUpReminderResolution | null;
	version: number;
	createdAt: number;
	updatedAt: number;
	resolvedAt: number | null;
}

export interface FollowUpReminderGroups {
	today: FollowUpReminder[];
	overdue: FollowUpReminder[];
	upcoming: FollowUpReminder[];
}

function chronological(left: FollowUpReminder, right: FollowUpReminder) {
	return Date.parse(left.remindAt) - Date.parse(right.remindAt) ||
		left.id.localeCompare(right.id);
}

/**
 * The caller supplies tomorrowStart in the user's display timezone. This keeps
 * grouping deterministic and makes the domain independent of server timezone.
 */
export function groupFollowUpReminders(
	reminders: readonly FollowUpReminder[],
	boundaries: { now: string; tomorrowStart: string },
): FollowUpReminderGroups {
	const now = Date.parse(boundaries.now);
	const tomorrowStart = Date.parse(boundaries.tomorrowStart);
	if (!Number.isFinite(now) || !Number.isFinite(tomorrowStart) || tomorrowStart <= now) {
		throw new Error("Valid reminder grouping boundaries are required");
	}
	const groups: FollowUpReminderGroups = {
		today: [],
		overdue: [],
		upcoming: [],
	};
	for (const reminder of reminders) {
		if (reminder.state !== "active") continue;
		const due = Date.parse(reminder.remindAt);
		if (!Number.isFinite(due)) continue;
		if (due < now) groups.overdue.push(reminder);
		else if (due < tomorrowStart) groups.today.push(reminder);
		else groups.upcoming.push(reminder);
	}
	groups.today.sort(chronological);
	groups.overdue.sort(chronological);
	groups.upcoming.sort(chronological);
	return groups;
}
