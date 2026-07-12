import type {
	FollowUpReminder,
	FollowUpReminderListPage,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";

/**
 * Owner-private follow-up reminder API. Every request is scoped to the current
 * session and rechecked against live mailbox access by the server.
 */

export type ListFollowUpRemindersResponse = FollowUpReminderListPage;

export type CreateFollowUpReminderRequest = {
	emailId: string;
	remindAt: string;
	idempotencyKey: string;
};

export type CreateFollowUpReminderResponse = {
	reminder: FollowUpReminder;
};

export type FollowUpReminderOperationRequest =
	| {
			action: "dismiss" | "complete";
			operationId: string;
			expectedVersion: number;
	  }
	| {
			action: "snooze";
			operationId: string;
			expectedVersion: number;
			remindAt: string;
	  };

export type FollowUpReminderOperationResponse = {
	reminder: FollowUpReminder;
};

export type FollowUpReminderApiErrorCode =
	| "INVALID"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "ACTIVE_CONFLICT"
	| "STATE_CONFLICT"
	| "IDEMPOTENCY_CONFLICT";

export class FollowUpReminderApiError extends Error {
	readonly status: number;
	readonly code: FollowUpReminderApiErrorCode | undefined;

	constructor(
		status: number,
		message: string,
		code?: FollowUpReminderApiErrorCode,
	) {
		super(message);
		this.name = "FollowUpReminderApiError";
		this.status = status;
		this.code = code;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function base(mailboxId: string): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/follow-up-reminders`;
}

async function request<T>(
	url: string,
	init: RequestInit,
	fetcher: FetchLike,
): Promise<T> {
	const response = await fetcher(url, {
		credentials: "same-origin",
		...init,
		headers: {
			...(init.body ? { "Content-Type": "application/json" } : {}),
			...init.headers,
		},
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: FollowUpReminderApiErrorCode;
		};
		throw new FollowUpReminderApiError(
			response.status,
			body.error ?? "Follow-up reminder request failed",
			body.code,
		);
	}
	return response.json() as Promise<T>;
}

// GET /api/v1/mailboxes/:mailboxId/follow-up-reminders?limit=N&cursor=...
export async function listFollowUpReminders(
	mailboxId: string,
	limit = 100,
	fetcher: FetchLike = fetch,
): Promise<FollowUpReminderView[]> {
	const reminders = new Map<string, FollowUpReminderView>();
	const seenCursors = new Set<string>();
	let cursor: string | null = null;
	do {
		const params = new URLSearchParams({ limit: String(limit) });
		if (cursor) params.set("cursor", cursor);
		const response = await request<ListFollowUpRemindersResponse>(
			`${base(mailboxId)}?${params}`,
			{ method: "GET" },
			fetcher,
		);
		for (const reminder of response.reminders) {
			const existing = reminders.get(reminder.id);
			if (
				!existing ||
				reminder.version > existing.version ||
				(reminder.version === existing.version && reminder.updatedAt > existing.updatedAt)
			) {
				reminders.set(reminder.id, reminder);
			}
		}
		cursor = response.nextCursor ?? null;
		if (cursor) {
			if (seenCursors.has(cursor)) {
				throw new FollowUpReminderApiError(
					502,
					"Follow-up reminder pagination did not advance",
				);
			}
			seenCursors.add(cursor);
		}
	} while (cursor);

	return [...reminders.values()].sort(
		(left, right) =>
			Date.parse(left.remindAt) - Date.parse(right.remindAt) ||
			left.id.localeCompare(right.id),
	);
}

// POST /api/v1/mailboxes/:mailboxId/follow-up-reminders
export async function createFollowUpReminder(
	mailboxId: string,
	input: CreateFollowUpReminderRequest,
	fetcher: FetchLike = fetch,
): Promise<CreateFollowUpReminderResponse["reminder"]> {
	const response = await request<CreateFollowUpReminderResponse>(
		base(mailboxId),
		{ method: "POST", body: JSON.stringify(input) },
		fetcher,
	);
	return response.reminder;
}

// POST /api/v1/mailboxes/:mailboxId/follow-up-reminders/:reminderId/operations
export async function applyFollowUpReminderOperation(
	mailboxId: string,
	reminderId: string,
	input: FollowUpReminderOperationRequest,
	fetcher: FetchLike = fetch,
): Promise<FollowUpReminderOperationResponse["reminder"]> {
	const response = await request<FollowUpReminderOperationResponse>(
		`${base(mailboxId)}/${encodeURIComponent(reminderId)}/operations`,
		{ method: "POST", body: JSON.stringify(input) },
		fetcher,
	);
	return response.reminder;
}
