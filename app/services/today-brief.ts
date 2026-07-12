/**
 * Actor-private, mailbox-scoped Today brief API. The server derives all mail
 * and reminder evidence from the authenticated actor and authorized mailbox.
 */

export type TodayBriefRequest = {
	timeZone: string;
};

export type TodayBriefCounts = {
	privateRemindersDue: number;
	unreadConversations: number;
};

export type TodayBriefCandidate = {
	candidateId: string;
	sourceEmailId: string;
	subject: string;
	counterparty: string;
	reasons: Array<
		"overdue_reminder" | "today_reminder" | "unread_in_mailbox"
	>;
	remindAt?: string;
};

export type TodayBriefItem = {
	candidate: TodayBriefCandidate;
	whyNow: string;
	suggestedNextStep: string;
	messageIds: string[];
	requiresHumanReview: true;
};

export type TodayBriefResponse =
	| {
		state: "cached" | "generated";
		fingerprint: string;
		generatedAt: string;
		counts: TodayBriefCounts;
		omittedCount: number;
		items: TodayBriefItem[];
	  }
	| {
		state: "no_attention";
		counts: TodayBriefCounts;
		omittedCount: 0;
	  }
	| {
		state: "budget_paused";
		reason: string;
		counts: TodayBriefCounts;
		omittedCount: number;
	  }
	| {
		state: "preparing";
		counts: TodayBriefCounts;
		omittedCount: number;
	  }
	| {
		state: "stale";
		counts: TodayBriefCounts;
		omittedCount: number;
	  };

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function apiError(status: number, message: string): Error & { status: number } {
	return Object.assign(new Error(message), {
		name: "TodayBriefApiError",
		status,
	});
}

function errorMessage(body: unknown): string | undefined {
	if (!body || typeof body !== "object" || !("error" in body)) return undefined;
	return typeof body.error === "string" ? body.error : undefined;
}

// POST /api/v1/mailboxes/:mailboxId/today-brief
export async function fetchTodayBrief(
	mailboxId: string,
	input: TodayBriefRequest,
	fetcher: FetchLike = fetch,
	signal?: AbortSignal,
): Promise<TodayBriefResponse> {
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/today-brief`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
			signal,
		},
	);
	if (!response.ok) {
		const body: unknown = await response.json().catch(() => null);
		throw apiError(
			response.status,
			errorMessage(body) ?? "Today brief is unavailable",
		);
	}
	return response.json();
}
