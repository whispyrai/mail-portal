// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { extractThreadTokens } from "./thread-token.ts";
import { sanitizeFilename, type StoredAttachment } from "./attachments.ts";
import type { RecipientMemoryOrigin } from "../../shared/recipient-suggestions.ts";
import { contentIdForDisposition } from "../../shared/content-id.ts";
import { normalizeObservedSenderName } from "./people/index.ts";
import type { PushPayload } from "./push/types.ts";

export const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

type StoredEmail = {
	id: string;
	subject: string;
	sender: string;
	sender_name: string | null;
	recipient: string;
	cc: string | null;
	bcc: string | null;
	date: string;
	read?: boolean;
	body: string;
	in_reply_to: string | null;
	email_references: string | null;
	thread_id: string;
	message_id: string | null;
	raw_headers: string;
	recipient_memory_origin: RecipientMemoryOrigin;
	/** Exact live RFC/token thread identity allowed to wake Snoozed mail. */
	snooze_wake_thread_id: string | null;
	follow_up_reply_mailbox_address: string | null;
	push_notification?: PushPayload;
};

type AttachmentBucket = {
	put(key: string, value: ArrayBuffer | string): Promise<unknown>;
	delete(key: string): Promise<unknown>;
};

export type MailboxEmailStore = {
	createEmail(
		folder: string,
		email: StoredEmail,
		attachments: StoredAttachment[],
		actor?: undefined,
		mailboxAddress?: string,
	): Promise<unknown>;
	resolveCanonicalThreadId(messageIds: string[]): Promise<string | null>;
	getEmail(id: string): Promise<unknown | null>;
};

export type EmailStorageDependencies = {
	bucket: AttachmentBucket;
	mailbox: MailboxEmailStore;
};

export interface StoredEmailSignal {
	conversationKey: string;
	inboundMessageId: string;
	inboundMessageDate: string;
}

type StoreParsedEmailOptions = {
	folder: string;
	date: string;
	messageId: string;
	read?: boolean;
	threadId?: string;
	wakeSnoozedOnReply?: boolean;
	followUpMailboxAddress?: string;
	mailboxAddress?: string;
	recipientMemoryOrigin: RecipientMemoryOrigin;
	pushNotification?: PushPayload;
	/** Optional write-generation fence for import-only attachment identities. */
	attachmentIdNamespace?: string;
};

function messageIds(value: string | undefined): string[] {
	if (!value?.trim()) return [];
	const bracketed = Array.from(value.matchAll(/<([^>]+)>/g), (match) => match[1]).filter(
		(messageId): messageId is string => Boolean(messageId),
	);
	return bracketed.length > 0 ? bracketed : value.trim().split(/\s+/).filter(Boolean);
}

function addresses(entries: Email["to"]): string[] {
	return (entries ?? []).flatMap((entry) =>
		entry.address ? [entry.address.toLowerCase()] : [],
	);
}

function boundedRfcThreadCandidates(
	references: string[],
	inReplyTo: string | null,
): string[] {
	const root = references[0];
	const recent = references.slice(-48);
	return [...new Set([root, ...recent, inReplyTo].filter(
		(value): value is string => Boolean(value),
	))].slice(0, 50);
}

/**
 * Persist one parsed email through the shared live-receive and import path.
 * Callers choose identity, folder, date, read state, provenance, and an optional
 * imported thread id; this module owns attachment storage and the stored row shape.
 */
export async function storeParsedEmail(
	dependencies: EmailStorageDependencies,
	parsed: Email,
	options: StoreParsedEmailOptions,
): Promise<StoredEmailSignal> {
	const { folder, date, messageId, read } = options;
	if (
		options.attachmentIdNamespace !== undefined &&
		!/^[a-z0-9_-]{16,100}$/i.test(options.attachmentIdNamespace)
	) throw new Error("Attachment identity namespace is invalid");
	const attachmentData: StoredAttachment[] = [];
	const attachmentKeys: string[] = [];

	try {
		for (const [attachmentIndex, attachment] of parsed.attachments.entries()) {
			const attachmentId = options.attachmentIdNamespace
				? `${messageId}-${options.attachmentIdNamespace}-${attachmentIndex}`
				: `${messageId}-${attachmentIndex}`;
			const filename = sanitizeFilename(attachment.filename ?? "untitled");
			const key = `attachments/${messageId}/${attachmentId}/${filename}`;
			attachmentKeys.push(key);
			await dependencies.bucket.put(key, attachment.content);
			const disposition = attachment.disposition ?? "attachment";
			attachmentData.push({
				id: attachmentId,
				email_id: messageId,
				filename,
				mimetype: attachment.mimeType,
				size:
					typeof attachment.content === "string"
						? attachment.content.length
						: attachment.content.byteLength,
				content_id: contentIdForDisposition(disposition, attachment.contentId),
				disposition,
			});
		}

		const inReplyTo = messageIds(parsed.inReplyTo)[0] ?? null;
		const references = messageIds(parsed.references);
		const tokenThreadIds = extractThreadTokens(references, inReplyTo);
		const tokenThreadId = tokenThreadIds.length === 1 ? tokenThreadIds[0]! : null;
		const rfcReplyIds = boundedRfcThreadCandidates(references, inReplyTo);
		const canonicalReplyThreadId = tokenThreadIds.length > 1
			? null
			: tokenThreadId ?? (
			rfcReplyIds.length > 0
				? await dependencies.mailbox.resolveCanonicalThreadId(rfcReplyIds)
				: null
			);
		const threadId = options.threadId ?? canonicalReplyThreadId ?? messageId;
		const snoozeWakeThreadId = options.wakeSnoozedOnReply
			? canonicalReplyThreadId
			: null;

		await dependencies.mailbox.createEmail(
			folder,
			{
				id: messageId,
				subject: parsed.subject ?? "",
				sender: parsed.from?.address?.toLowerCase() ?? "",
				sender_name: normalizeObservedSenderName(parsed.from?.name),
				recipient: addresses(parsed.to).join(", "),
				cc: addresses(parsed.cc).join(", ") || null,
				bcc: addresses(parsed.bcc).join(", ") || null,
				date,
				read,
				body: parsed.html ?? parsed.text ?? "",
				in_reply_to: inReplyTo,
				email_references: references.length > 0 ? JSON.stringify(references) : null,
				thread_id: threadId,
				message_id: messageIds(parsed.messageId)[0] ?? null,
				raw_headers: JSON.stringify(parsed.headers),
				recipient_memory_origin: options.recipientMemoryOrigin,
				snooze_wake_thread_id: snoozeWakeThreadId,
					follow_up_reply_mailbox_address:
						options.followUpMailboxAddress?.toLowerCase() ?? null,
					push_notification: options.pushNotification,
			},
			attachmentData,
			undefined,
			options.mailboxAddress,
		);
		return {
			conversationKey: threadId,
			inboundMessageId: messageId,
			inboundMessageDate: date,
		};
	} catch (error) {
		let emailWasStored: boolean;
		try {
			emailWasStored = Boolean(await dependencies.mailbox.getEmail(messageId));
		} catch (verificationError) {
			console.error(
				"[mail-store] could not verify failed persistence; preserving attachment objects",
				{ messageId, verificationError },
			);
			throw error;
		}

		if (!emailWasStored) {
			const cleanupResults = await Promise.allSettled(
				attachmentKeys.map((key) => dependencies.bucket.delete(key)),
			);
			const cleanupFailures = cleanupResults.filter(
				(result) => result.status === "rejected",
			).length;
			if (cleanupFailures > 0) {
				console.error(
					"[mail-store] failed to remove attachment objects after persistence error",
					{ messageId, cleanupFailures },
				);
			}
		}
		throw error;
	}
}
