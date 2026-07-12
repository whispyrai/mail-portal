import {
	MAILBOX_SIGNATURE_LIMITS,
	type MailboxSignature,
} from "../../shared/mailbox-signature-settings.ts";

export class InvalidMailboxSignatureError extends Error {
	constructor() {
		super("Signature settings are invalid");
		this.name = "InvalidMailboxSignatureError";
	}
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n?/g, "\n");
}

function decodeHtmlEntities(value: string): string {
	const codePoint = (raw: string, radix: number) => {
		const parsed = Number.parseInt(raw, radix);
		return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff
			? String.fromCodePoint(parsed)
			: "";
	};
	return value
		.replace(/&#(\d+);/g, (_match, code: string) => codePoint(code, 10))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => codePoint(code, 16))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'");
}

function legacyHtmlToText(value: string): string {
	return decodeHtmlEntities(
		value
			.replace(/<!--[\s\S]*?-->/g, "")
			.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
			.replace(/<br\s*\/?\s*>/gi, "\n")
			.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
			.replace(/<[^>]*>/g, ""),
	)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function normalizeEffectiveSignature(value: unknown): MailboxSignature {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { enabled: false, text: "" };
	}
	const stored = value as Record<string, unknown>;
	const source = typeof stored.text === "string"
		? stored.text
		: typeof stored.html === "string"
			? legacyHtmlToText(stored.html)
			: "";
	return {
		enabled: stored.enabled === true,
		text: normalizeLineEndings(source).slice(
			0,
			MAILBOX_SIGNATURE_LIMITS.textCharacters,
		),
	};
}

export function parseSignatureUpdate(value: unknown): MailboxSignature {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InvalidMailboxSignatureError();
	}
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 2 ||
		!("enabled" in input) ||
		!("text" in input) ||
		typeof input.enabled !== "boolean" ||
		typeof input.text !== "string"
	) {
		throw new InvalidMailboxSignatureError();
	}
	const text = normalizeLineEndings(input.text);
	if (text.length > MAILBOX_SIGNATURE_LIMITS.textCharacters) {
		throw new InvalidMailboxSignatureError();
	}
	return { enabled: input.enabled, text };
}

export function mergeStoredSignature(
	settings: unknown,
	signature: MailboxSignature,
): Record<string, unknown> {
	const current = settings && typeof settings === "object" && !Array.isArray(settings)
		? settings as Record<string, unknown>
		: {};
	return { ...current, signature: { ...signature } };
}
