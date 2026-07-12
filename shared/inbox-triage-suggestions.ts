export const INBOX_TRIAGE_SUGGESTION_LIMITS = {
	requestBytes: 16 * 1_024,
	visibleEmails: 25,
	page: 100_000,
	labelIdChars: 128,
	labelIdBytes: 512,
	emailIdChars: 300,
	emailIdBytes: 1_200,
	candidates: 25,
	messagesPerCandidate: 2,
	messageTextChars: 800,
	messageTextBytes: 3_200,
	explanationChars: 240,
	explanationBytes: 960,
	citationsPerSuggestion: 2,
	modelSystemChars: 8_000,
	modelUntrustedChars: 128 * 1_024,
	modelSerializedBytes: 160 * 1_024,
	modelOutputBytes: 32 * 1_024,
} as const;

export type InboxTriageSuggestionAction = "archive" | "mark_read";

export type InboxTriageSuggestionRequest = {
	page: number;
	labelId?: string;
	visibleEmailIds: string[];
};

export type NormalizedInboxTriageSuggestionRequest = {
	version: 1;
	page: number;
	labelId: string | null;
	visibleEmailIds: string[];
};

export type InboxTriageSuggestion = {
	candidateId: string;
	emailId: string;
	conversationId: string | null;
	action: InboxTriageSuggestionAction;
	explanation: string;
	messageIds: string[];
	requiresHumanReview: true;
};

export type InboxTriageSuggestionResult = {
	suggestions: InboxTriageSuggestion[];
};

const encoder = new TextEncoder();
const CONTROL_TEXT = /[\u0000-\u001F\u007F]/;

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function characterLength(value: string): number {
	return Array.from(value).length;
}

function boundedIdentifier(
	value: unknown,
	label: string,
	limits: { chars: number; bytes: number },
): string {
	if (typeof value !== "string") throw new Error(`${label} must be text`);
	const normalized = value.normalize("NFC").trim();
	if (
		!normalized ||
		CONTROL_TEXT.test(normalized) ||
		/\s/u.test(normalized) ||
		characterLength(normalized) > limits.chars ||
		byteLength(normalized) > limits.bytes
	) {
		throw new Error(`${label} is invalid`);
	}
	return normalized;
}

export function normalizeInboxTriageEmailId(value: unknown): string {
	return boundedIdentifier(value, "Inbox Message ID", {
		chars: INBOX_TRIAGE_SUGGESTION_LIMITS.emailIdChars,
		bytes: INBOX_TRIAGE_SUGGESTION_LIMITS.emailIdBytes,
	});
}

export function normalizeInboxTriageLabelId(value: unknown): string {
	return boundedIdentifier(value, "Inbox label ID", {
		chars: INBOX_TRIAGE_SUGGESTION_LIMITS.labelIdChars,
		bytes: INBOX_TRIAGE_SUGGESTION_LIMITS.labelIdBytes,
	});
}

export function parseInboxTriageSuggestionRequest(
	value: unknown,
): NormalizedInboxTriageSuggestionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Inbox triage suggestion request is invalid");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(["page", "labelId", "visibleEmailIds"]);
	if (
		Object.keys(record).some((field) => !allowed.has(field)) ||
		!("page" in record) ||
		!("visibleEmailIds" in record)
	) {
		throw new Error("Inbox triage suggestion request contains invalid fields");
	}
	if (
		typeof record.page !== "number" ||
		!Number.isInteger(record.page) ||
		record.page < 1 ||
		record.page > INBOX_TRIAGE_SUGGESTION_LIMITS.page
	) {
		throw new Error("Inbox triage suggestion page is invalid");
	}
	if (
		!Array.isArray(record.visibleEmailIds) ||
		record.visibleEmailIds.length < 1 ||
		record.visibleEmailIds.length >
			INBOX_TRIAGE_SUGGESTION_LIMITS.visibleEmails
	) {
		throw new Error("Inbox triage visible Message IDs are invalid");
	}
	const visibleEmailIds = record.visibleEmailIds.map(normalizeInboxTriageEmailId);
	if (new Set(visibleEmailIds).size !== visibleEmailIds.length) {
		throw new Error("Inbox triage visible Message IDs must be unique");
	}
	if (byteLength(JSON.stringify(value)) > INBOX_TRIAGE_SUGGESTION_LIMITS.requestBytes) {
		throw new Error("Inbox triage suggestion request exceeds its safe bound");
	}
	return {
		version: 1,
		page: record.page,
		labelId:
			record.labelId === undefined
				? null
				: normalizeInboxTriageLabelId(record.labelId),
		visibleEmailIds,
	};
}

export function validateNormalizedInboxTriageSuggestionRequest(
	value: unknown,
): NormalizedInboxTriageSuggestionRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Normalized Inbox triage suggestion request is invalid");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set(["version", "page", "labelId", "visibleEmailIds"]);
	if (
		Object.keys(record).some((field) => !allowed.has(field)) ||
		Object.keys(record).length !== allowed.size ||
		record.version !== 1 ||
		typeof record.page !== "number" ||
		!Number.isInteger(record.page) ||
		record.page < 1 ||
		record.page > INBOX_TRIAGE_SUGGESTION_LIMITS.page ||
		(record.labelId !== null && typeof record.labelId !== "string") ||
		!Array.isArray(record.visibleEmailIds) ||
		record.visibleEmailIds.length < 1 ||
		record.visibleEmailIds.length >
			INBOX_TRIAGE_SUGGESTION_LIMITS.visibleEmails
	) {
		throw new Error("Normalized Inbox triage suggestion request is invalid");
	}
	const visibleEmailIds = record.visibleEmailIds.map(normalizeInboxTriageEmailId);
	if (new Set(visibleEmailIds).size !== visibleEmailIds.length) {
		throw new Error("Inbox triage visible Message IDs must be unique");
	}
	return {
		version: 1,
		page: record.page,
		labelId:
			record.labelId === null
				? null
				: normalizeInboxTriageLabelId(record.labelId),
		visibleEmailIds,
	};
}
