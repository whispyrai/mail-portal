export type ConversationAnswerClaim = {
	text: string;
	messageIds: string[];
};

export type ConversationAnswerResult =
	| {
			state: "answered";
			claims: ConversationAnswerClaim[];
	  }
	| { state: "insufficient_evidence" };

export type ConversationAnswerResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: ConversationAnswerResult;
	  }
	| { state: "budget_paused"; reason: string }
	| { state: "stale" };

export class ConversationAnswerApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "ConversationAnswerApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export async function fetchConversationAnswer(
	mailboxId: string,
	emailId: string,
	question: string,
	signal: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<ConversationAnswerResponse> {
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/question`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ question }),
			signal,
		},
	);

	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as {
			error?: unknown;
		} | null;
		throw new ConversationAnswerApiError(
			response.status,
			typeof body?.error === "string"
				? body.error
				: "This conversation could not be answered",
		);
	}

	return response.json() as Promise<ConversationAnswerResponse>;
}
