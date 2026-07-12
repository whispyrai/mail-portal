import type { RecipientSuggestion } from "../../shared/recipient-suggestions.ts";

export type RecipientSuggestionResponse = {
	suggestions: RecipientSuggestion[];
};

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export class RecipientSuggestionApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "RecipientSuggestionApiError";
		this.status = status;
	}
}

export async function fetchRecipientSuggestions(
	mailboxId: string,
	query: string,
	limit = 10,
	signal?: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<RecipientSuggestion[]> {
	const params = new URLSearchParams({ q: query, limit: String(limit) });
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/recipient-suggestions?${params}`,
		{ method: "GET", credentials: "same-origin", signal },
	);
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new RecipientSuggestionApiError(
			response.status,
			body.error ?? "Recipient suggestions are unavailable",
		);
	}
	const body = await response.json() as RecipientSuggestionResponse;
	return body.suggestions;
}
