// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Shared email helpers to eliminate duplication across API routes, MCP, and agent.
 *
 * Includes: DO stub helpers, sender validation, message-ID generation,
 * threading, HTML utilities, and tool-logic (getFullEmail / getFullThread).
 */
import type { MailboxDO } from "../durableObject/index.ts";
import type { EmailFull } from "./schemas.ts";
import { Folders } from "../../shared/folders.ts";
export { buildThreadToken, extractThreadToken } from "./thread-token.ts";
import { extractThreadTokens } from "./thread-token.ts";
import type { Env } from "../types.ts";
import { formatQuotedDate } from "../../shared/dates.ts";

// ── DO Stub ────────────────────────────────────────────────────────

/**
 * Resolve a MailboxDO stub from a mailbox email address.
 * Replaces the repeated 3-line ns.idFromName / ns.get pattern.
 */
export function getMailboxStub(
	env: Env,
	mailboxId: string,
): DurableObjectStub<MailboxDO> {
	const ns = env.MAILBOX;
	const id = ns.idFromName(mailboxId);
	return ns.get(id);
}

// ── Mailbox Listing ────────────────────────────────────────────────

/**
 * List all mailboxes from R2 bucket metadata.
 */
export async function listMailboxes(
	bucket: R2Bucket,
): Promise<{ id: string; email: string }[]> {
	const list = await bucket.list({ prefix: "mailboxes/" });
	return list.objects.map((obj) => {
		const id = obj.key.replace("mailboxes/", "").replace(".json", "");
		return { id, email: id };
	});
}

// ── Sender Validation ──────────────────────────────────────────────

/**
 * Normalise to/from addresses and validate the sender matches the mailbox.
 * Returns the normalised values or throws with a user-facing message.
 */
export function validateSender(
	to: string | string[],
	from: string | { email: string; name: string },
	mailboxId: string,
): { toStr: string; fromEmail: string; fromDomain: string } {
	const toStr = (Array.isArray(to) ? to.join(", ") : to).toLowerCase();
	const fromEmail = (typeof from === "string" ? from : from.email).toLowerCase();

	if (fromEmail !== mailboxId.toLowerCase()) {
		throw new SenderValidationError("From address must match the mailbox email address");
	}

	const fromDomain = fromEmail.split("@")[1];
	if (!fromDomain) {
		throw new SenderValidationError("Invalid sender email address");
	}

	return { toStr, fromEmail, fromDomain };
}

export class SenderValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SenderValidationError";
	}
}

// ── Message ID ─────────────────────────────────────────────────────

/**
 * Generate an internal UUID and a proper RFC 2822 Message-ID.
 */
export function generateMessageId(fromDomain: string): {
	messageId: string;
	outgoingMessageId: string;
} {
	const messageId = crypto.randomUUID();
	const outgoingMessageId = `${messageId}@${fromDomain}`;
	return { messageId, outgoingMessageId };
}

// ── Threading ──────────────────────────────────────────────────────

/**
 * Build the References chain and In-Reply-To from an original email.
 */
export function buildReferencesChain(original: EmailFull): {
	originalMsgId: string;
	references: string[];
	threadId: string;
} {
	const originalMsgId = original.message_id || original.id;
	let existingRefs: string[] = [];
	if (original.email_references) {
		try {
			existingRefs = JSON.parse(original.email_references);
		} catch {
			// Malformed JSON in email_references — treat as empty
		}
	}
	const references = [...existingRefs, originalMsgId].filter(Boolean);
	const threadId = original.thread_id || original.id;
	return { originalMsgId, references, threadId };
}

/**
 * Build an app-controlled thread token that we stamp into the References header
 * of every outbound message. AWS SES overwrites the Message-ID header (so we
 * can't rely on it to match replies) but leaves References untouched, so the
 * recipient's client echoes this token back in their reply. That gives us
 * deterministic, SES-proof threading. See locked-decisions D-65.
 */
/**
 * Build threading headers (In-Reply-To + References) for an outbound message.
 * `originalMsgId` is set only for replies. `threadToken` (when provided) is
 * appended to References so replies thread back to us regardless of SES's
 * Message-ID rewriting.
 */
export function buildThreadingHeaders(
	originalMsgId: string | null,
	references: string[],
	threadToken?: string,
): Record<string, string> {
	const headers: Record<string, string> = {};
	const ids = [...new Set(references.map(bareMessageId).filter(isMessageId))];
	// Mail we sent is stored under SES's own id, which is not the Message-ID
	// its recipients saw. Answering it answers what it answered instead.
	const replyTarget = originalMsgId ? bareMessageId(originalMsgId) : null;
	const inReplyTo = replyTarget && isMessageId(replyTarget)
		? replyTarget
		: originalMsgId
			? ids.filter((id) => !isOwnThreadToken(id, threadToken)).at(-1)
			: undefined;
	if (inReplyTo) headers["In-Reply-To"] = `<${inReplyTo}>`;
	const refs = threadToken
		? [...ids.filter((id) => id !== threadToken), threadToken]
		: ids;
	const referencesHeader = fitReferences(refs);
	if (referencesHeader) headers["References"] = referencesHeader;
	return headers;
}

/** Our own thread token, as opposed to someone else's id that starts with `thread-`. */
function isOwnThreadToken(id: string, threadToken: string | undefined): boolean {
	if (!threadToken) return false;
	const ownDomain = threadToken.slice(threadToken.lastIndexOf("@"));
	return id.endsWith(ownDomain) && extractThreadTokens([id], null).length > 0;
}

/** SES rejects a custom header whose name and value exceed 996 characters. */
const MAX_REFERENCES_LENGTH = 996 - "References".length;

function bareMessageId(value: string): string {
	return value.trim().replace(/^<|>$/g, "");
}

/** A Message-ID a recipient can match: `local@domain`. */
function isMessageId(value: string): boolean {
	return /^[^\s<>]+@[^\s<>]+$/.test(value);
}

/**
 * A long thread's full chain outgrows the SES header limit and the whole send
 * fails, so keep what RFC 5322 asks to keep and drop from the middle: the
 * first message, when it fits beside the thread token, then the newest ids
 * back from the token (always last, so never dropped). Nothing longer than
 * the limit is ever returned.
 */
function fitReferences(ids: string[]): string {
	const render = (list: string[]) => list.map((id) => `<${id}>`).join(" ");
	if (render(ids).length <= MAX_REFERENCES_LENGTH) return render(ids);
	const root = ids[0]!;
	const keepsRoot = render([root, ids.at(-1)!]).length <= MAX_REFERENCES_LENGTH;
	const newest: string[] = [];
	for (const id of ids.slice(1).reverse()) {
		const candidate = keepsRoot ? [root, id, ...newest] : [id, ...newest];
		if (render(candidate).length > MAX_REFERENCES_LENGTH) break;
		newest.unshift(id);
	}
	return render(keepsRoot ? [root, ...newest] : newest);
}

// ── Draft-follows-in_reply_to ──────────────────────────────────────

/**
 * If the given email is a draft with an in_reply_to, resolve the real original.
 * Used by reply/forward routes to avoid threading against the draft itself.
 */
export async function resolveOriginalEmail(
	stub: DurableObjectStub<MailboxDO>,
	email: EmailFull,
): Promise<EmailFull> {
	if (email.folder_id === Folders.DRAFT && email.in_reply_to) {
		const realOriginal = (await stub.getEmail(email.in_reply_to)) as EmailFull | null;
		if (realOriginal) return realOriginal;
	}
	return email;
}

// ── HTML Utilities ─────────────────────────────────────────────────

/**
 * Escape all five OWASP-recommended HTML special characters in plain text.
 * Safe for use in both text content and attribute contexts.
 */
export function escapeHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/**
 * Convert plain text to HTML suitable for TipTap's setContent().
 * Paragraph breaks (2+ newlines) become separate <p> elements; single
 * newlines within a paragraph become <br> hard-breaks. This is the shape
 * TipTap's ProseMirror parser natively understands, so spacing, greetings,
 * and sign-offs survive the round-trip into the editor.
 */
export function textToHtml(text: string): string {
	if (!text) return "";
	const paragraphs = text.split(/\n{2,}/);
	return paragraphs
		.map((p) => {
			const trimmed = p.trim();
			if (!trimmed) return "";
			const escaped = escapeHtml(trimmed).replace(/\n/g, "<br>");
			return `<p>${escaped}</p>`;
		})
		.filter(Boolean)
		.join("");
}

/**
 * Strip HTML tags and normalize whitespace to produce plain text.
 * Removes <style> and <script> blocks first to avoid injecting their
 * content into the output.
 */
export function stripHtmlToText(html: string): string {
	if (!html) return "";
	return html
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Format a date string for use in quoted reply blocks.
 * @deprecated Use `formatQuotedDate` from `shared/dates` directly.
 */
export const formatEmailDate = formatQuotedDate;

/**
 * Build a quoted reply block HTML string from original email data.
 */
export function buildQuotedReplyBlock(original: {
	date?: string;
	sender?: string;
	body?: string;
}): string {
	if (!original.body) return "";
	
	// HTML-escape sender and date to prevent injection
	const originalSender = escapeHtml(original.sender || "unknown");
	const originalDate = escapeHtml(formatEmailDate(original.date || ""));

	// Sanitize the body to plain text to prevent stored XSS.
	// The original HTML renders safely in the sandboxed iframe, but quoted
	// reply blocks are injected into the compose editor and outgoing emails
	// where raw HTML would execute. Convert to escaped plain text instead.
	const plainBody = stripHtmlToText(original.body);
	const bodyToQuote = escapeHtml(plainBody).replace(/\n/g, "<br>");

	return `<br><blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;">On ${originalDate}, ${originalSender} wrote:<br><br>${bodyToQuote}</blockquote>`;
}

// ── Tool Logic (getFullEmail / getFullThread) ──────────────────────

type MailboxThreadReaderStub = {
	getThreadEmails: (threadId: string) => Promise<EmailFull[]>;
};

/**
 * Fetch a single email and return it with both HTML and plain-text body.
 * Returns null if the email is not found.
 */
export async function getFullEmail(
	stub: DurableObjectStub<MailboxDO>,
	emailId: string,
) {
	const email = (await stub.getEmail(emailId)) as EmailFull | null;
	if (!email) return null;

	const textBody = email.body ? stripHtmlToText(email.body) : "";
	return { ...email, body_text: textBody, body_html: email.body };
}

/**
 * Fetch all emails in a thread with full bodies in a single DO call.
 * Uses `getThreadEmails` which runs 2 SQL queries (emails + attachments)
 * instead of the previous N+1 pattern (1 list query + N getEmail calls).
 */
export async function getFullThread(
	stub: DurableObjectStub<MailboxDO>,
	threadId: string,
) {
	const threadStub = stub as unknown as MailboxThreadReaderStub;
	const emails = await threadStub.getThreadEmails(threadId);

	const enriched = emails.map((email) => {
		const textBody = email.body ? stripHtmlToText(email.body) : "";
		return { ...email, body_text: textBody };
	});

	// Already sorted ASC by the DO query, but ensure consistency
	enriched.sort(
		(a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
	);

	return { thread_id: threadId, message_count: enriched.length, messages: enriched };
}
