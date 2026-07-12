export const RELATIONSHIP_BRIEF_LIMITS = {
	conversations: 12,
	messages: 30,
	messageTextChars: 3_000,
	totalInputChars: 60_000,
	totalInputBytes: 80_000,
	topics: 6,
	openQuestions: 8,
	commitments: 8,
	importantConversations: 6,
	citationsPerItem: 8,
	claimChars: 600,
	completionTokens: 1_200,
	modelOutputChars: 20_000,
	modelOutputBytes: 80_000,
	retryAfterMs: 750,
} as const;

export type RelationshipBriefParty = "us" | "them";

export type RelationshipBriefRequest = { refresh: boolean };

export type RelationshipBriefCitation = {
	messageId: string;
	folderId: string;
	subject: string;
	sentAt: string;
};

export type RelationshipBriefClaim = {
	text: string;
	citations: RelationshipBriefCitation[];
};

export type RelationshipBrief = {
	topics: RelationshipBriefClaim[];
	openQuestions: Array<RelationshipBriefClaim & { askedBy: RelationshipBriefParty }>;
	commitments: Array<RelationshipBriefClaim & {
		madeBy: RelationshipBriefParty;
		dueAt?: string;
	}>;
	importantConversations: Array<{
		conversationId: string;
		reason: string;
		citations: RelationshipBriefCitation[];
	}>;
	suggestedNextStep: RelationshipBriefClaim & { requiresHumanReview: true };
	requiresHumanReview: true;
};

export type RelationshipBriefResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			generatedAt: string;
			brief: RelationshipBrief;
	  }
	| { state: "unavailable" }
	| { state: "preparing"; retryAfterMs: number }
	| { state: "budget_paused"; reason: string }
	| { state: "stale"; retryAfterMs: number };

export class RelationshipBriefContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RelationshipBriefContractError";
	}
}

const UNSAFE_TEXT =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/u;

function invalid(): never {
	throw new RelationshipBriefContractError("Relationship brief response is invalid");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const sorted = [...expected].sort();
	return actual.length === sorted.length &&
		actual.every((key, index) => key === sorted[index]);
}

function safeText(value: unknown, maximum: number, empty = false): string {
	if (
		typeof value !== "string" ||
		(!empty && !value) ||
		value !== value.trim().normalize("NFC") ||
		UNSAFE_TEXT.test(value) ||
		Array.from(value).length > maximum
	) invalid();
	return value;
}

function canonicalDate(value: unknown): string {
	const text = safeText(value, 64);
	const date = new Date(text);
	if (Number.isNaN(date.getTime()) || date.toISOString() !== text) invalid();
	return text;
}

function citation(value: unknown): RelationshipBriefCitation {
	const row = record(value);
	if (!exactKeys(row, ["messageId", "folderId", "subject", "sentAt"])) invalid();
	return {
		messageId: safeText(row.messageId, 320),
		folderId: safeText(row.folderId, 320),
		subject: safeText(row.subject, 1_000, true),
		sentAt: canonicalDate(row.sentAt),
	};
}

function citations(value: unknown): RelationshipBriefCitation[] {
	if (!Array.isArray(value) || value.length < 1 ||
		value.length > RELATIONSHIP_BRIEF_LIMITS.citationsPerItem) invalid();
	const result = value.map(citation);
	if (new Set(result.map((item) => item.messageId)).size !== result.length) invalid();
	return result;
}

function claim(value: unknown): RelationshipBriefClaim {
	const row = record(value);
	if (!exactKeys(row, ["text", "citations"])) invalid();
	return {
		text: safeText(row.text, RELATIONSHIP_BRIEF_LIMITS.claimChars),
		citations: citations(row.citations),
	};
}

function boundedItems<T>(value: unknown, maximum: number, parse: (item: unknown) => T): T[] {
	if (!Array.isArray(value) || value.length > maximum) invalid();
	return value.map(parse);
}

function brief(value: unknown): RelationshipBrief {
	const row = record(value);
	if (!exactKeys(row, [
		"topics",
		"openQuestions",
		"commitments",
		"importantConversations",
		"suggestedNextStep",
		"requiresHumanReview",
	]) || row.requiresHumanReview !== true) invalid();
	const suggested = record(row.suggestedNextStep);
	if (!exactKeys(suggested, ["text", "citations", "requiresHumanReview"]) ||
		suggested.requiresHumanReview !== true) invalid();
	return {
		topics: boundedItems(row.topics, RELATIONSHIP_BRIEF_LIMITS.topics, claim),
		openQuestions: boundedItems(
			row.openQuestions,
			RELATIONSHIP_BRIEF_LIMITS.openQuestions,
			(value) => {
				const item = record(value);
				if (!exactKeys(item, ["askedBy", "text", "citations"]) ||
					!(["us", "them"] as const).includes(item.askedBy as "us" | "them")) invalid();
				return { askedBy: item.askedBy as RelationshipBriefParty, ...claim({ text: item.text, citations: item.citations }) };
			},
		),
		commitments: boundedItems(
			row.commitments,
			RELATIONSHIP_BRIEF_LIMITS.commitments,
			(value) => {
				const item = record(value);
				const hasDueAt = Object.hasOwn(item, "dueAt");
				if (!exactKeys(item, hasDueAt
					? ["madeBy", "text", "dueAt", "citations"]
					: ["madeBy", "text", "citations"]) ||
					!(["us", "them"] as const).includes(item.madeBy as "us" | "them")) invalid();
				return {
					madeBy: item.madeBy as RelationshipBriefParty,
					...claim({ text: item.text, citations: item.citations }),
					...(hasDueAt ? { dueAt: canonicalDate(item.dueAt) } : {}),
				};
			},
		),
		importantConversations: boundedItems(
			row.importantConversations,
			RELATIONSHIP_BRIEF_LIMITS.importantConversations,
			(value) => {
				const item = record(value);
				if (!exactKeys(item, ["conversationId", "reason", "citations"])) invalid();
				return {
					conversationId: safeText(item.conversationId, 320),
					reason: safeText(item.reason, RELATIONSHIP_BRIEF_LIMITS.claimChars),
					citations: citations(item.citations),
				};
			},
		),
		suggestedNextStep: {
			...claim({ text: suggested.text, citations: suggested.citations }),
			requiresHumanReview: true,
		},
		requiresHumanReview: true,
	};
}

export function parseRelationshipBriefRequest(value: unknown): { refresh: boolean } {
	const row = record(value);
	if (!exactKeys(row, ["refresh"]) || typeof row.refresh !== "boolean") {
		throw new RelationshipBriefContractError("Relationship brief request is invalid");
	}
	return { refresh: row.refresh };
}

export function validateRelationshipBriefResponse(value: unknown): RelationshipBriefResponse {
	const row = record(value);
	if (row.state === "cached" || row.state === "generated") {
		if (!exactKeys(row, ["state", "fingerprint", "generatedAt", "brief"])) invalid();
		return {
			state: row.state,
			fingerprint: safeText(row.fingerprint, 200),
			generatedAt: canonicalDate(row.generatedAt),
			brief: brief(row.brief),
		};
	}
	if (row.state === "unavailable") {
		if (!exactKeys(row, ["state"])) invalid();
		return { state: "unavailable" };
	}
	if (row.state === "preparing" || row.state === "stale") {
		if (!exactKeys(row, ["state", "retryAfterMs"]) ||
			!Number.isSafeInteger(row.retryAfterMs) || Number(row.retryAfterMs) < 250 ||
			Number(row.retryAfterMs) > 10_000) invalid();
		return { state: row.state, retryAfterMs: Number(row.retryAfterMs) };
	}
	if (row.state === "budget_paused") {
		if (!exactKeys(row, ["state", "reason"])) invalid();
		return { state: "budget_paused", reason: safeText(row.reason, 100) };
	}
	invalid();
}
