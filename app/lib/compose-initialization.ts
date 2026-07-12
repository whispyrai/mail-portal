import type { ComposeOptions } from "../hooks/useUIStore.ts";
import { replyAllRecipientFields } from "./recipient-input.ts";
import {
	FORWARDED_MESSAGE_MARKER,
	insertComposeSignature,
} from "./compose-signature.ts";
import {
	escapeHtml,
	stripHtml,
} from "./html-text.ts";
import { formatQuotedDate } from "../../shared/dates.ts";
import type { MailboxSignature } from "../../shared/mailbox-signature-settings";

export interface InitialComposeFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: InitialComposeFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function prefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function forwardBody(original: NonNullable<ComposeOptions["originalEmail"]>) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(
		/\n/g,
		"<br>",
	);

	return `<p><br></p><div ${FORWARDED_MESSAGE_MARKER} style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatQuotedDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
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
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			to: mode === "new" ? composeOptions.initialTo ?? "" : "",
			body: withSignature(signature?.enabled ? "<p><br></p>" : "", "new", signature),
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: original.sender,
			subject: prefixedSubject(original.subject, "Re"),
			body: withSignature(signature?.enabled ? "<p><br></p>" : "", "reply", signature),
		};
	}

	if (mode === "reply-all") {
		return {
			...EMPTY_FIELDS,
			...replyAllRecipientFields({
				sender: original.sender,
				to: original.recipient,
				cc: original.cc,
				mailboxAddress: mailboxEmail ?? "",
			}),
			subject: prefixedSubject(original.subject, "Re"),
			body: withSignature(signature?.enabled ? "<p><br></p>" : "", "reply-all", signature),
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
		body: withSignature(signature?.enabled ? "<p><br></p>" : "", "new", signature),
	};
}
