import {
	untrustedAiContextFits,
	wrapUntrustedAiContext,
} from "./ai-untrusted-context.ts";

export const AI_DRAFTING_LIMITS = {
	replyRequestBytes: 2_048,
	composeRequestBytes: 32 * 1_024,
	promptChars: 8_000,
	currentSubjectChars: 500,
	currentBodyChars: 20_000,
	modelDraftContextChars: 18_000,
	mailboxSystemPromptChars: 2_000,
	modelSystemEnvelopeChars: 4_000,
	modelSerializedChars: 32_000,
} as const;

export type AiComposeDraftRequest = {
	prompt: string;
	currentSubject?: string;
	currentBody?: string;
	preserveSignature?: boolean;
};

export function aiComposeDraftContextText(input: AiComposeDraftRequest): string {
	const parts: string[] = [];
	if (input.currentSubject !== undefined) {
		parts.push(`Current authored subject:\n${input.currentSubject}`);
	}
	if (input.currentBody !== undefined) {
		parts.push(`Current authored body (HTML):\n${input.currentBody}`);
	}
	return parts.join("\n\n");
}

export type AiComposeDraftValidation =
	| { ok: true }
	| {
			ok: false;
			code: "invalid_fields" | "request_too_large" | "draft_context_too_large";
	  };

export function validateAiComposeDraftRequest(
	input: AiComposeDraftRequest,
): AiComposeDraftValidation {
	if (
		input.prompt.trim().length === 0 ||
		input.prompt.length > AI_DRAFTING_LIMITS.promptChars ||
		(input.currentSubject?.length ?? 0) > AI_DRAFTING_LIMITS.currentSubjectChars ||
		(input.currentBody?.length ?? 0) > AI_DRAFTING_LIMITS.currentBodyChars
	) {
		return { ok: false, code: "invalid_fields" };
	}
	if (
		new TextEncoder().encode(JSON.stringify(input)).byteLength >
		AI_DRAFTING_LIMITS.composeRequestBytes
	) {
		return { ok: false, code: "request_too_large" };
	}
	if (
		(input.currentSubject !== undefined || input.currentBody !== undefined) &&
		!untrustedAiContextFits(aiComposeDraftContextText(input), {
			label: "DRAFT",
			maxChars: AI_DRAFTING_LIMITS.modelDraftContextChars,
		})
	) {
		return { ok: false, code: "draft_context_too_large" };
	}
	const simulatedMessages: Array<{ role: "system" | "user"; content: string }> = [
		{
			role: "system",
			content: "x".repeat(AI_DRAFTING_LIMITS.modelSystemEnvelopeChars),
		},
		{ role: "user", content: input.prompt },
	];
	if (input.currentSubject !== undefined || input.currentBody !== undefined) {
		simulatedMessages.push({
			role: "user",
			content: wrapUntrustedAiContext(aiComposeDraftContextText(input), {
				label: "DRAFT",
				maxChars: AI_DRAFTING_LIMITS.modelDraftContextChars,
				truncate: false,
			}),
		});
	}
	if (
		JSON.stringify(simulatedMessages).length >
		AI_DRAFTING_LIMITS.modelSerializedChars
	) {
		return { ok: false, code: "draft_context_too_large" };
	}
	return { ok: true };
}
