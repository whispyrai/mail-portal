export const CONVERSATION_ANSWER_LIMITS = {
	requestBytes: 2 * 1_024,
	questionChars: 500,
	questionBytes: 2_000,
	claims: 5,
	claimChars: 600,
	claimBytes: 2_400,
	citationsPerClaim: 30,
	modelSystemChars: 6_000,
	modelUntrustedEvidenceChars: 256 * 1_024,
	modelSerializedBytes: 320 * 1_024,
	modelOutputBytes: 16 * 1_024,
} as const;

export type ConversationAnswerRequest = {
	question: string;
};

export type NormalizedConversationAnswerRequest = {
	version: 1;
	question: string;
};

export type ConversationAnswerClaim = {
	text: string;
	messageIds: string[];
};

export type ConversationAnswerGeneratedResult =
	| { state: "answered"; claims: ConversationAnswerClaim[] }
	| { state: "insufficient_evidence" };

const encoder = new TextEncoder();

function characterLength(value: string): number {
	return Array.from(value).length;
}

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

export function normalizeConversationAnswerQuestion(value: unknown): string {
	if (typeof value !== "string") {
		throw new Error("Conversation question must be text");
	}
	const canonical = value.normalize("NFC").replace(/\r\n?/g, "\n");
	if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(canonical)) {
		throw new Error("Conversation question contains unsupported control text");
	}
	const normalized = canonical.replace(/\s+/gu, " ").trim();
	if (!normalized) {
		throw new Error("Conversation question is required");
	}
	if (
		characterLength(normalized) > CONVERSATION_ANSWER_LIMITS.questionChars ||
		byteLength(normalized) > CONVERSATION_ANSWER_LIMITS.questionBytes
	) {
		throw new Error("Conversation question exceeds its safe bound");
	}
	return normalized;
}

export function parseConversationAnswerRequest(
	value: unknown,
): NormalizedConversationAnswerRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Conversation answer request is invalid");
	}
	const fields = Object.keys(value);
	if (fields.length !== 1 || fields[0] !== "question") {
		throw new Error("Conversation answer request must contain only question");
	}
	return {
		version: 1,
		question: normalizeConversationAnswerQuestion(
			(value as Record<string, unknown>).question,
		),
	};
}
