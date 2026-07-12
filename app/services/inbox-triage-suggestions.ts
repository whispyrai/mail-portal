import {
	INBOX_TRIAGE_SUGGESTION_LIMITS,
	normalizeInboxTriageEmailId,
	parseInboxTriageSuggestionRequest,
	type InboxTriageSuggestion,
	type InboxTriageSuggestionAction,
	type InboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";

export type {
	InboxTriageSuggestion,
	InboxTriageSuggestionAction,
	InboxTriageSuggestionRequest,
};

export type InboxTriageSuggestionsResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: { suggestions: InboxTriageSuggestion[] };
	  }
	| { state: "budget_paused"; reason: string }
	| { state: "stale" };

export class InboxTriageSuggestionsApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "InboxTriageSuggestionsApiError";
		this.status = status;
	}
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

const encoder = new TextEncoder();
const ACTIVE_MARKUP = /<\/?[a-z][^>\n]*>/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
	record: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	const actual = Object.keys(record);
	return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function boundedText(
	value: unknown,
	limits: { chars: number; bytes: number },
): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.normalize("NFC").trim();
	if (
		!normalized ||
		/[\u0000-\u001F\u007F]/.test(normalized) ||
		Array.from(normalized).length > limits.chars ||
		encoder.encode(normalized).byteLength > limits.bytes
	) return null;
	return normalized;
}

function boundedId(value: unknown): string | null {
	try {
		return normalizeInboxTriageEmailId(value);
	} catch {
		return null;
	}
}

function parseSuggestion(
	value: unknown,
	visibleEmailIds: ReadonlySet<string>,
): InboxTriageSuggestion | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			"candidateId",
			"emailId",
			"conversationId",
			"action",
			"explanation",
			"messageIds",
			"requiresHumanReview",
		])
	) return null;
	const candidateId = boundedId(value.candidateId);
	const emailId = boundedId(value.emailId);
	const conversationId = value.conversationId === null
		? null
		: boundedId(value.conversationId);
	const action = value.action === "archive" || value.action === "mark_read"
		? value.action
		: null;
	const explanation = boundedText(value.explanation, {
		chars: INBOX_TRIAGE_SUGGESTION_LIMITS.explanationChars,
		bytes: INBOX_TRIAGE_SUGGESTION_LIMITS.explanationBytes,
	});
	if (
		!candidateId ||
		!emailId ||
		!visibleEmailIds.has(emailId) ||
		(value.conversationId !== null && !conversationId) ||
		!action ||
		!explanation ||
		ACTIVE_MARKUP.test(explanation) ||
		value.requiresHumanReview !== true ||
		!Array.isArray(value.messageIds) ||
		value.messageIds.length < 1 ||
		value.messageIds.length >
			INBOX_TRIAGE_SUGGESTION_LIMITS.citationsPerSuggestion
	) return null;
	const messageIds = value.messageIds.map(boundedId);
	if (
		messageIds.some((messageId) => !messageId) ||
		new Set(messageIds).size !== messageIds.length
	) return null;
	return {
		candidateId,
		emailId,
		conversationId,
		action,
		explanation,
		messageIds: messageIds.filter((messageId): messageId is string => Boolean(messageId)),
		requiresHumanReview: true,
	};
}

function invalidResponse(): never {
	throw new InboxTriageSuggestionsApiError(
		502,
		"Inbox suggestions returned an invalid response",
	);
}

function parseResponse(
	value: unknown,
	request: InboxTriageSuggestionRequest,
): InboxTriageSuggestionsResponse {
	if (!isRecord(value) || typeof value.state !== "string") invalidResponse();
	if (value.state === "stale") {
		if (!hasExactKeys(value, ["state"])) invalidResponse();
		return { state: "stale" };
	}
	if (value.state === "budget_paused") {
		if (!hasExactKeys(value, ["state", "reason"])) invalidResponse();
		const reason = boundedText(value.reason, { chars: 200, bytes: 800 });
		if (!reason) invalidResponse();
		return { state: "budget_paused", reason };
	}
	if (
		value.state !== "generated" &&
		value.state !== "cached"
	) invalidResponse();
	if (
		!hasExactKeys(value, ["state", "fingerprint", "result"]) ||
		!isRecord(value.result) ||
		!hasExactKeys(value.result, ["suggestions"]) ||
		!Array.isArray(value.result.suggestions) ||
		value.result.suggestions.length > INBOX_TRIAGE_SUGGESTION_LIMITS.candidates
	) invalidResponse();
	const fingerprint = boundedText(value.fingerprint, { chars: 300, bytes: 1_200 });
	if (!fingerprint || /\s/u.test(fingerprint)) invalidResponse();
	const visibleEmailIds = new Set(
		parseInboxTriageSuggestionRequest(request).visibleEmailIds,
	);
	const suggestions = value.result.suggestions.map((suggestion) =>
		parseSuggestion(suggestion, visibleEmailIds),
	);
	if (suggestions.some((suggestion) => !suggestion)) invalidResponse();
	const parsed = suggestions.filter(
		(suggestion): suggestion is InboxTriageSuggestion => Boolean(suggestion),
	);
	if (
		new Set(parsed.map((suggestion) => suggestion.candidateId)).size !==
			parsed.length ||
		new Set(parsed.map((suggestion) => suggestion.emailId)).size !== parsed.length
	) invalidResponse();
	return {
		state: value.state,
		fingerprint,
		result: { suggestions: parsed },
	};
}

export async function fetchInboxTriageSuggestions(
	mailboxId: string,
	request: InboxTriageSuggestionRequest,
	signal: AbortSignal,
	fetcher: FetchLike = fetch,
): Promise<InboxTriageSuggestionsResponse> {
	const normalized = parseInboxTriageSuggestionRequest(request);
	const body = {
		page: normalized.page,
		...(normalized.labelId ? { labelId: normalized.labelId } : {}),
		visibleEmailIds: normalized.visibleEmailIds,
	};
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/inbox-triage-suggestions`,
		{
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		},
	);
	if (!response.ok) {
		const error: unknown = await response.json().catch(() => null);
		throw new InboxTriageSuggestionsApiError(
			response.status,
			isRecord(error) && typeof error.error === "string"
				? error.error
				: "Inbox suggestions are unavailable",
		);
	}
	let value: unknown;
	try {
		value = await response.json();
	} catch {
		invalidResponse();
	}
	return parseResponse(value, body);
}
