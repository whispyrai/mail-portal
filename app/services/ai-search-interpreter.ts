import {
	parseAiSearchInterpreterRequest,
	parseAiSearchInterpreterResponse,
	type AiSearchInterpreterRequest,
	type AiSearchInterpreterResponse,
} from "../../shared/ai-search-interpreter.ts";

export type {
	AiSearchFilters,
	AiSearchInterpreterReadyResponse,
	AiSearchInterpreterRequest,
	AiSearchInterpreterResponse,
} from "../../shared/ai-search-interpreter.ts";

export class AiSearchInterpreterApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "AiSearchInterpreterApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export async function fetchAiSearchInterpretation(
	mailboxId: string,
	request: AiSearchInterpreterRequest,
	signal: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<AiSearchInterpreterResponse> {
	const parsedRequest = parseAiSearchInterpreterRequest(request);
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/search/interpret`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(parsedRequest),
			signal,
		},
	);
	if (!response.ok) {
		throw new AiSearchInterpreterApiError(
			response.status,
			response.status === 403
				? "Mailbox access changed."
				: response.status === 400
					? "This search request could not be interpreted."
					: "AI search is temporarily unavailable.",
		);
	}
	let body: unknown;
	try {
		body = await response.json();
		return parseAiSearchInterpreterResponse(body);
	} catch (error) {
		if (error instanceof AiSearchInterpreterApiError) throw error;
		throw new AiSearchInterpreterApiError(
			502,
			"AI search returned an invalid response.",
		);
	}
}
