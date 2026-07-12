import {
	ATTACHMENT_KINDS,
	MAILBOX_ATTACHMENT_LIMITS,
	type AttachmentKind,
	type MailboxAttachmentItem,
	type MailboxAttachmentPage,
} from "../../shared/mailbox-attachments.ts";

export class MailboxAttachmentResponseError extends Error {
	constructor() {
		super("Mailbox attachments returned an invalid response");
		this.name = "MailboxAttachmentResponseError";
	}
}

function invalid(): never {
	throw new MailboxAttachmentResponseError();
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	const candidate = value as Record<string, unknown>;
	const actualKeys = Object.keys(candidate);
	if (
		actualKeys.length !== keys.length ||
		!keys.every((key) => Object.hasOwn(candidate, key))
	) invalid();
	return candidate;
}

function boundedString(
	value: unknown,
	maxLength: number,
	allowEmpty = true,
): string {
	if (
		typeof value !== "string" ||
		[...value].length > maxLength ||
		(!allowEmpty && value.length === 0)
	) invalid();
	return value;
}

function canonicalDate(value: unknown): string {
	const date = boundedString(value, MAILBOX_ATTACHMENT_LIMITS.cursorDateChars);
	if (date === "") return date;
	const timestamp = Date.parse(date);
	if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== date) invalid();
	return date;
}

export function compareMailboxAttachmentOrder(
	left: MailboxAttachmentItem,
	right: MailboxAttachmentItem,
): number {
	if (left.message.date !== right.message.date) {
		return left.message.date > right.message.date ? -1 : 1;
	}
	if (left.emailId !== right.emailId) return left.emailId < right.emailId ? -1 : 1;
	if (left.id !== right.id) return left.id < right.id ? -1 : 1;
	return 0;
}

export function parseMailboxAttachmentItem(value: unknown): MailboxAttachmentItem {
	const item = record(value, [
		"id", "emailId", "filename", "mimetype", "size", "kind", "message",
	]);
	const id = boundedString(item.id, MAILBOX_ATTACHMENT_LIMITS.identifierChars, false);
	const emailId = boundedString(item.emailId, MAILBOX_ATTACHMENT_LIMITS.identifierChars, false);
	const filename = boundedString(item.filename, 255);
	const mimetype = boundedString(item.mimetype, 100);
	if (!Number.isSafeInteger(item.size) || (item.size as number) < 0) invalid();
	if (
		typeof item.kind !== "string" ||
		!ATTACHMENT_KINDS.includes(item.kind as AttachmentKind)
	) invalid();
	const message = record(item.message, [
		"subject", "sender", "date", "folderId", "folderName",
	]);
	return {
		id,
		emailId,
		filename,
		mimetype,
		size: item.size as number,
		kind: item.kind as AttachmentKind,
		message: {
			subject: boundedString(message.subject, 500),
			sender: boundedString(message.sender, 320),
			date: canonicalDate(message.date),
			folderId: boundedString(message.folderId, MAILBOX_ATTACHMENT_LIMITS.folderChars, false),
			folderName: boundedString(message.folderName, MAILBOX_ATTACHMENT_LIMITS.folderChars),
		},
	};
}

export function parseMailboxAttachmentPage(
	value: unknown,
	maxItems = 50,
): MailboxAttachmentPage {
	const page = record(value, ["items", "nextCursor"]);
	if (
		!Number.isInteger(maxItems) ||
		maxItems < 1 ||
		maxItems > 50 ||
		!Array.isArray(page.items) ||
		page.items.length > maxItems
	) invalid();
	const items = page.items.map(parseMailboxAttachmentItem);
	const identities = new Set<string>();
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index]!;
		const identity = JSON.stringify([item.emailId, item.id]);
		if (identities.has(identity)) invalid();
		identities.add(identity);
		if (index > 0 && compareMailboxAttachmentOrder(items[index - 1]!, item) >= 0) {
			invalid();
		}
	}
	const nextCursor = page.nextCursor;
	if (
		nextCursor !== null &&
		(typeof nextCursor !== "string" ||
			nextCursor.length === 0 ||
			nextCursor.length > MAILBOX_ATTACHMENT_LIMITS.cursorChars ||
			!/^[A-Za-z0-9_-]+$/.test(nextCursor))
	) invalid();
	return { items, nextCursor: nextCursor as string | null };
}
