export const MAIL_SIGNATURE_MARKER = 'data-mail-signature="v1"';
export const FORWARDED_MESSAGE_MARKER = 'data-mail-forwarded-message="v1"';

export type ComposeSignatureMode =
	| "new"
	| "reply"
	| "reply-all"
	| "forward"
	| "draft";

export type ComposeSignatureInsertionResult = {
	bodyHtml: string;
	inserted: boolean;
	reason: "inserted" | "duplicate" | "draft";
};

export type DelayedComposeSignaturePlan =
	| { action: "insert"; bodyHtml: string }
	| { action: "offer-manual"; bodyHtml: string }
	| {
			action: "none";
			bodyHtml: string;
			reason: "disabled" | "draft" | "duplicate";
	  };

const SIGNATURE_BLOCK_SOURCE =
	String.raw`<div\b(?=[^>]*\bdata-mail-signature\s*=\s*(["'])v1\1)[^>]*>[\s\S]*?<\/div\s*>`;
const FORWARDED_MESSAGE_OPEN_SOURCE =
	String.raw`<div\b(?=[^>]*\bdata-mail-forwarded-message\s*=\s*(["'])v1\1)[^>]*>`;

function signatureBlockPattern(global = false): RegExp {
	return new RegExp(SIGNATURE_BLOCK_SOURCE, global ? "gi" : "i");
}

function forwardedMessageIndex(bodyHtml: string): number {
	return bodyHtml.search(new RegExp(FORWARDED_MESSAGE_OPEN_SOURCE, "i"));
}

function authoredContent(bodyHtml: string): string {
	const index = forwardedMessageIndex(bodyHtml);
	return index >= 0 ? bodyHtml.slice(0, index) : bodyHtml;
}

export function extractForwardedMessageTail(bodyHtml: string): string | null {
	const index = forwardedMessageIndex(bodyHtml);
	return index >= 0 ? bodyHtml.slice(index) : null;
}

function normalizePlainText(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export function renderComposeSignature(text: string): string {
	const body = escapeHtml(normalizePlainText(text)).replace(/\n/g, "<br>");
	return `<div ${MAIL_SIGNATURE_MARKER}>${body}</div>`;
}

export function extractComposeSignature(bodyHtml: string): string | null {
	return bodyHtml.match(signatureBlockPattern())?.[0] ?? null;
}

export function hasComposeSignature(bodyHtml: string): boolean {
	return extractComposeSignature(bodyHtml) !== null;
}

export function removeComposeSignatures(bodyHtml: string): string {
	return bodyHtml.replace(signatureBlockPattern(true), "");
}

export function insertComposeSignature(
	bodyHtml: string,
	signatureText: string,
	mode: ComposeSignatureMode,
): ComposeSignatureInsertionResult {
	if (mode === "draft") {
		return { bodyHtml, inserted: false, reason: "draft" };
	}
	if (hasComposeSignature(mode === "forward" ? authoredContent(bodyHtml) : bodyHtml)) {
		return { bodyHtml, inserted: false, reason: "duplicate" };
	}
	const signature = renderComposeSignature(signatureText);
	const forwardMarkerIndex = mode === "forward"
		? forwardedMessageIndex(bodyHtml)
		: -1;
	return {
		bodyHtml: forwardMarkerIndex >= 0
			? `${bodyHtml.slice(0, forwardMarkerIndex)}${signature}${bodyHtml.slice(forwardMarkerIndex)}`
			: `${bodyHtml}${signature}`,
		inserted: true,
		reason: "inserted",
	};
}

export function planDelayedComposeSignature(input: {
	bodyHtml: string;
	signatureText: string;
	enabled: boolean;
	mode: ComposeSignatureMode;
	pristine: boolean;
}): DelayedComposeSignaturePlan {
	if (input.mode === "draft") {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "draft" };
	}
	if (!input.enabled) {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "disabled" };
	}
	if (
		hasComposeSignature(
			input.mode === "forward"
				? authoredContent(input.bodyHtml)
				: input.bodyHtml,
		)
	) {
		return { action: "none", bodyHtml: input.bodyHtml, reason: "duplicate" };
	}
	if (!input.pristine) {
		return { action: "offer-manual", bodyHtml: input.bodyHtml };
	}
	return {
		action: "insert",
		bodyHtml: insertComposeSignature(
			input.bodyHtml,
			input.signatureText,
			input.mode,
		).bodyHtml,
	};
}

export function insertComposeSignatureManually(
	bodyHtml: string,
	signatureText: string,
	mode: ComposeSignatureMode,
): ComposeSignatureInsertionResult {
	return insertComposeSignature(bodyHtml, signatureText, mode);
}

export function replaceAiAuthoredContent(
	currentBodyHtml: string,
	aiAuthoredHtml: string,
): string {
	const signature = extractComposeSignature(authoredContent(currentBodyHtml));
	const forwarded = extractForwardedMessageTail(currentBodyHtml);
	const replacement = removeComposeSignatures(authoredContent(aiAuthoredHtml));
	return `${replacement}${signature ?? ""}${forwarded ?? ""}`;
}
