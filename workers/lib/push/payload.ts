// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Build the push payload the service worker renders. Notification content is
// decision B (WISER-240 grill): title = sender, body = subject + a snippet of
// the message. Deliberately surfaces email content on the lock screen in
// exchange for at-a-glance triage. Tapping deep-links to the exact message.

import type { PushPayload } from "./types";

export interface BuildPushPayloadInput {
	emailId: string;
	mailboxId: string;
	fromName?: string | null;
	fromAddress: string;
	subject?: string | null;
	/** Raw stored body (may be HTML or plain text). */
	body?: string | null;
	icon: string;
	badge: string;
}

const ENTITIES: [RegExp, string][] = [
	[/&nbsp;/g, " "],
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&#0*39;|&apos;/g, "'"],
	[/&amp;/g, "&"], // decode last so "&amp;lt;" → "&lt;", not "<"
];

/**
 * Reduce a stored email body (HTML or plain text) to a short, safe one-line
 * preview: strip tags, decode the common entities, collapse whitespace, and
 * truncate with an ellipsis. Not a security sanitizer — the output is a
 * notification string, never rendered as HTML.
 */
export function htmlToSnippet(raw: string | null | undefined, maxLength = 120): string {
	if (!raw) return "";
	let s = raw.replace(/<[^>]*>/g, " ");
	for (const [re, ch] of ENTITIES) s = s.replace(re, ch);
	s = s.replace(/\s+/g, " ").trim();
	if (s.length > maxLength) s = `${s.slice(0, maxLength - 1).trimEnd()}…`;
	return s;
}

export function buildPushPayload(input: BuildPushPayloadInput): PushPayload {
	const { emailId, mailboxId, fromName, fromAddress, subject, body, icon, badge } = input;

	const title = fromName?.trim() || fromAddress.split("@")[0] || "New email";
	const subjectText = subject?.trim() || "(no subject)";
	const snippet = htmlToSnippet(body);

	return {
		title,
		body: snippet ? `${subjectText} — ${snippet}` : subjectText,
		icon,
		badge,
		clickUrl: `/mailbox/${encodeURIComponent(mailboxId)}/emails/inbox?email=${encodeURIComponent(emailId)}`,
		data: { emailId, mailboxId },
	};
}
