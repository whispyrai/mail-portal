export const REPLY_REFINEMENT_LIMITS = {
	requestBytes: 32 * 1_024,
	sourceEmailIdChars: 300,
	sourceEmailIdBytes: 1_200,
	promptChars: 4_000,
	promptBytes: 16_000,
	currentBodyChars: 16_000,
	currentBodyBytes: 32 * 1_024,
	writingPromptChars: 8_000,
	writingPromptBytes: 32_000,
	modelSystemChars: 20_000,
	modelUntrustedDraftChars: 80_000,
	modelUntrustedEvidenceChars: 256 * 1_024,
	modelSerializedBytes: 384 * 1_024,
	modelOutputBytes: 64 * 1_024,
	outputBodyChars: 16_000,
	outputBodyBytes: 64 * 1_024,
} as const;

export type ReplyRefinementMode = "reply" | "reply-all";

export type ReplyRefinementRequest = {
	mode: ReplyRefinementMode;
	prompt: string;
	currentBody?: string;
	preserveSignature?: boolean;
};

export type NormalizedReplyRefinementRequest = {
	version: 1;
	mode: ReplyRefinementMode;
	prompt: string;
	currentBody: string;
	preserveSignature: boolean;
};

export type ReplyRefinementResult = {
	body: string;
	requiresHumanReview: true;
};

const encoder = new TextEncoder();
const CONTROL_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function characterLength(value: string): number {
	return Array.from(value).length;
}

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function canonicalText(value: string): string {
	return value.normalize("NFC").replace(/\r\n?/g, "\n");
}

function boundedText(
	value: unknown,
	label: string,
	limits: { chars: number; bytes: number },
	options: { required: boolean; trim: boolean },
): string {
	if (typeof value !== "string") throw new Error(`${label} must be text`);
	const canonical = canonicalText(value);
	if (CONTROL_TEXT.test(canonical)) {
		throw new Error(`${label} contains unsupported control text`);
	}
	const normalized = options.trim ? canonical.trim() : canonical;
	if (options.required && !normalized) throw new Error(`${label} is required`);
	if (
		characterLength(normalized) > limits.chars ||
		byteLength(normalized) > limits.bytes
	) {
		throw new Error(`${label} exceeds its safe bound`);
	}
	return normalized;
}

export function normalizeReplyRefinementSourceEmailId(value: unknown): string {
	const id = boundedText(
		value,
		"Reply source Message ID",
		{
			chars: REPLY_REFINEMENT_LIMITS.sourceEmailIdChars,
			bytes: REPLY_REFINEMENT_LIMITS.sourceEmailIdBytes,
		},
		{ required: true, trim: true },
	);
	if (/\s/u.test(id)) throw new Error("Reply source Message ID is invalid");
	return id;
}

export function normalizeReplyRefinementWritingPrompt(value: unknown): string {
	return boundedText(
		value,
		"Mailbox writing prompt",
		{
			chars: REPLY_REFINEMENT_LIMITS.writingPromptChars,
			bytes: REPLY_REFINEMENT_LIMITS.writingPromptBytes,
		},
		{ required: true, trim: true },
	);
}

export function parseReplyRefinementRequest(
	value: unknown,
): NormalizedReplyRefinementRequest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Reply refinement request is invalid");
	}
	const record = value as Record<string, unknown>;
	const allowed = new Set([
		"mode",
		"prompt",
		"currentBody",
		"preserveSignature",
	]);
	if (
		Object.keys(record).some((field) => !allowed.has(field)) ||
		!("mode" in record) ||
		!("prompt" in record)
	) {
		throw new Error("Reply refinement request contains invalid fields");
	}
	if (record.mode !== "reply" && record.mode !== "reply-all") {
		throw new Error("Reply refinement mode is invalid");
	}
	if (
		"preserveSignature" in record &&
		typeof record.preserveSignature !== "boolean"
	) {
		throw new Error("Reply refinement signature flag is invalid");
	}
	const preserveSignature = record.preserveSignature === true;
	const normalized: NormalizedReplyRefinementRequest = {
		version: 1,
		mode: record.mode,
		prompt: boundedText(
			record.prompt,
			"Reply refinement prompt",
			{
				chars: REPLY_REFINEMENT_LIMITS.promptChars,
				bytes: REPLY_REFINEMENT_LIMITS.promptBytes,
			},
			{ required: true, trim: true },
		),
		currentBody:
			record.currentBody === undefined
				? ""
				: boundedText(
						record.currentBody,
						"Current authored reply body",
						{
							chars: REPLY_REFINEMENT_LIMITS.currentBodyChars,
							bytes: REPLY_REFINEMENT_LIMITS.currentBodyBytes,
						},
						{ required: false, trim: false },
					),
		preserveSignature,
	};
	if (byteLength(JSON.stringify(value)) > REPLY_REFINEMENT_LIMITS.requestBytes) {
		throw new Error("Reply refinement request exceeds its safe bound");
	}
	return normalized;
}
