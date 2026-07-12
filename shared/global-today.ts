import type { FollowUpReminderView } from "./follow-up-reminders.ts";

export const GLOBAL_TODAY_LIMITS = {
	mailboxes: 12,
	concurrency: 4,
	mailboxTimeoutMs: 2_500,
	reminders: 500,
	reminderPageSize: 100,
	unreadPreviews: 3,
	messageIdChars: 300,
	conversationKeyChars: 500,
	addressChars: 320,
	subjectChars: 300,
} as const;

export type GlobalTodayUnreadPreview = {
	messageId: string;
	conversationKey: string;
	sender: string;
	subject: string;
	date: string;
};

export type GlobalTodayReminderPreview = {
	baselineMessageId: string;
	subject: string;
	counterparty: string;
};

export type GlobalTodayMailboxPulse = {
	unreadConversationCount: number;
	unreadPreviews: GlobalTodayUnreadPreview[];
	reminderPreviews: GlobalTodayReminderPreview[];
};

export type GlobalTodayMailboxSnapshot = {
	mailboxId: string;
	address: string;
	type: "PERSONAL" | "SHARED";
	reminders: FollowUpReminderView[];
	unreadConversationCount: number;
	unreadPreviews: GlobalTodayUnreadPreview[];
};

export type GlobalTodayMailboxFailure = {
	mailboxId: string;
	address: string;
	type: "PERSONAL" | "SHARED";
	reason: "timeout" | "unavailable";
};

export type GlobalTodayTotals = {
	privateRemindersDue: number;
	unreadConversations: number;
};

export type GlobalTodayReadyResponse = {
	state: "ready";
	complete: boolean;
	accessChanged: boolean;
	day: {
		timeZone: string;
		localDate: string;
		startAt: string;
		endAt: string;
	};
	currentMailboxCount: number;
	mailboxes: GlobalTodayMailboxSnapshot[];
	failures: GlobalTodayMailboxFailure[];
	totals: GlobalTodayTotals | null;
	generatedAt: string;
};

export type GlobalTodayResponse = GlobalTodayReadyResponse | {
	state: "capacity_exceeded";
	resource: "mailboxes" | "reminders";
	limit: number;
	actual: number;
};

export function globalTodayMailboxOrder(
	left: Pick<GlobalTodayMailboxSnapshot, "address" | "type">,
	right: Pick<GlobalTodayMailboxSnapshot, "address" | "type">,
) {
	if (left.type !== right.type) return left.type === "PERSONAL" ? -1 : 1;
	return left.address < right.address ? -1 : left.address > right.address ? 1 : 0;
}

export function globalTodayReminderOrder(
	left: Pick<FollowUpReminderView, "id" | "mailboxAddress" | "remindAt">,
	right: Pick<FollowUpReminderView, "id" | "mailboxAddress" | "remindAt">,
) {
	return Date.parse(left.remindAt) - Date.parse(right.remindAt) ||
		(left.mailboxAddress < right.mailboxAddress ? -1 : left.mailboxAddress > right.mailboxAddress ? 1 : 0) ||
		(left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
