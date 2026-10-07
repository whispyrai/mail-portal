import type { ComposeOptions } from "../hooks/useUIStore.ts";
import { replyRecipientFields } from "./recipient-input.ts";
import {
	FORWARDED_MESSAGE_MARKER,
	insertComposeSignature,
} from "./compose-signature.ts";
import { escapeHtml } from "./html-text.ts";
import { formatQuotedDate } from "../../shared/dates.ts";
import { decodeHtmlEntities } from "../../shared/html-entities.ts";
import type { MailboxSignature } from "../../shared/mailbox-signature-settings";

export interface InitialComposeFields {
	to: string;
	cc: string;
	bcc: string;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: InitialComposeFields = {
	to: "",
	cc: "",
	bcc: "",
	subject: "",
	body: "",
};

const SUBJECT_PREFIX_PATTERNS = {
	Re: /^re\s*:\s*/i,
	Fwd: /^(?:fwd|fw)\s*:\s*/i,
} as const;

/**
 * The one place a reply or forward prefix is applied. Existing prefixes are
 * absorbed whatever their spacing or case, so subjects never stack up as
 * "Re: Re: Fwd: ...".
 */
export function prefixedSubject(
	subject: string,
	prefix: "Re" | "Fwd",
): string {
	const pattern = SUBJECT_PREFIX_PATTERNS[prefix];
	let base = subject.trim();
	while (pattern.test(base)) base = base.replace(pattern, "").trim();
	return `${prefix}: ${base}`;
}

/**
 * Real markup, by tag name. A plain-text mail full of `<alice@example.com>`
 * or `<https://example.com>` must not be mistaken for HTML and stripped.
 */
const HTML_TAG =
	/<\/?(?:html|head|body|div|p|br|span|font|a|b|i|u|em|strong|table|tbody|thead|tr|td|th|ul|ol|li|img|h[1-6]|blockquote|pre|center|section|article|header|footer|style|meta|title|hr)(?=[\s/>])[^<>]*>/i;

/**
 * The original as readable text: paragraphs, line breaks, list items and link
 * targets survive, markup and styling do not. Plain-text mail is taken as is,
 * so a literal "<" in it is never mistaken for a tag.
 */
function quotedText(body: string): string {
	const text = HTML_TAG.test(body)
		? decodeHtmlEntities(
				body
					.replace(/<(style|script|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
					.replace(/<!--[\s\S]*?-->/g, "")
					.replace(
						/<a\b[^>]*\bhref\s*=\s*["']((?:https?:|mailto:)[^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
						(_match, href: string, label: string) => {
							const visible = label.replace(/<[^>]*>/g, "").trim();
							const target = href.replace(/^mailto:/i, "");
							return visible && visible !== target && visible !== href
								? `${visible} (${target})`
								: target;
						},
					)
					.replace(/<br\s*\/?>/gi, "\n")
					.replace(/<li\b[^>]*>/gi, "\n• ")
					.replace(/<\/tr\s*>/gi, "\n")
					.replace(/<\/(?:p|div|h[1-6]|table|blockquote|pre|ul|ol|section|article|header|footer)\s*>/gi, "\n\n")
					.replace(/<[^>]*>/g, ""),
			)
		: body;
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/[^\S\n]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function quotedHtml(text: string): string {
	return text
		.split("\n\n")
		.map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
		.join("");
}

function namedAddress(name: string | null | undefined, address: string): string {
	const cleanName = name?.trim().replace(/^"(.*)"$/, "$1").trim();
	return cleanName && cleanName.toLowerCase() !== address.toLowerCase()
		? `${cleanName} <${address}>`
		: address;
}

function forwardBody(original: NonNullable<ComposeOptions["originalEmail"]>) {
	const header = [
		["From", namedAddress(original.sender_name, original.sender)],
		["Date", formatQuotedDate(original.date)],
		["Subject", original.subject],
		["To", original.recipient],
		["Cc", original.cc],
	]
		.filter(([, value]) => value?.trim())
		.map(([label, value]) => `<strong>${label}:</strong> ${escapeHtml(value!.trim())}`)
		.join("<br>");
	const body = quotedText(original.body || "");

	return `<p><br></p><div ${FORWARDED_MESSAGE_MARKER} style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><p><strong>---------- Forwarded message ----------</strong><br>${header}</p>${body ? quotedHtml(body) : ""}</div>`;
}

function withSignature(
	bodyHtml: string,
	mode: "new" | "reply" | "reply-all" | "forward",
	signature: MailboxSignature | undefined,
) {
	return signature?.enabled
		? insertComposeSignature(bodyHtml, signature.text, mode).bodyHtml
		: bodyHtml;
}

/**
 * A clean writing space and nothing else. Replies deliberately quote nothing:
 * the message being answered is already in the thread above the composer, so
 * repeating it only pushes the reply out of view.
 */
function blankBody(
	mode: "new" | "reply" | "reply-all",
	signature: MailboxSignature | undefined,
) {
	return withSignature(signature?.enabled ? "<p><br></p>" : "", mode, signature);
}

export function buildInitialComposeFields(input: {
	composeOptions: ComposeOptions;
	mailboxEmail?: string;
	signature?: MailboxSignature;
}): InitialComposeFields {
	const { composeOptions, mailboxEmail, signature } = input;
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			to: mode === "new" ? composeOptions.initialTo ?? "" : "",
			body: blankBody("new", signature),
		};
	}

	if (mode === "reply" || mode === "reply-all") {
		return {
			...EMPTY_FIELDS,
			...replyRecipientFields({
				original,
				mailboxAddress: mailboxEmail ?? "",
				all: mode === "reply-all",
			}),
			subject: prefixedSubject(original.subject, "Re"),
			body: blankBody(mode, signature),
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: prefixedSubject(original.subject, "Fwd"),
			body: withSignature(forwardBody(original), "forward", signature),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: blankBody("new", signature),
	};
}
