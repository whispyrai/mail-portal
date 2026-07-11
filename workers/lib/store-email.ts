// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { extractThreadToken } from "./thread-token.ts";
import { sanitizeFilename, type StoredAttachment } from "./attachments.ts";

export const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

type StoredEmail = {
	id: string;
	subject: string;
	sender: string;
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
};

type AttachmentBucket = {
	put(key: string, value: ArrayBuffer | string): Promise<unknown>;
	delete(key: string): Promise<unknown>;
};

type MailboxEmailStore = {
	createEmail(
		folder: string,
		email: StoredEmail,
		attachments: StoredAttachment[],
	): Promise<unknown>;
	findThreadBySubject(subject: string, senderAddress?: string): Promise<string | null>;
	getEmail(id: string): Promise<unknown | null>;
};

export type EmailStorageDependencies = {
	bucket: AttachmentBucket;
	mailbox: MailboxEmailStore;
};

type StoreParsedEmailOptions = {
	folder: string;
	date: string;
	messageId: string;
	read?: boolean;
	threadId?: string;
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

/**
 * Persist one parsed email through the shared live-receive and import path.
 * Callers choose identity, folder, date, read state, and an optional imported
 * thread id; this module owns attachment storage and the stored row shape.
 */
export async function storeParsedEmail(
	dependencies: EmailStorageDependencies,
	parsed: Email,
	options: StoreParsedEmailOptions,
): Promise<void> {
	const { folder, date, messageId, read } = options;
	const attachmentData: StoredAttachment[] = [];
	const attachmentKeys: string[] = [];

	try {
		for (const [attachmentIndex, attachment] of parsed.attachments.entries()) {
			const attachmentId = `${messageId}-${attachmentIndex}`;
			const filename = sanitizeFilename(attachment.filename ?? "untitled");
			const key = `attachments/${messageId}/${attachmentId}/${filename}`;
			attachmentKeys.push(key);
			await dependencies.bucket.put(key, attachment.content);
			attachmentData.push({
				id: attachmentId,
				email_id: messageId,
				filename,
				mimetype: attachment.mimeType,
				size:
					typeof attachment.content === "string"
						? attachment.content.length
						: attachment.content.byteLength,
				content_id: attachment.contentId ?? null,
				disposition: attachment.disposition ?? "attachment",
			});
		}

		const inReplyTo = messageIds(parsed.inReplyTo)[0] ?? null;
		const references = messageIds(parsed.references);
		const tokenThreadId = extractThreadToken(references, inReplyTo);
		let threadId =
			options.threadId ?? tokenThreadId ?? references[0] ?? inReplyTo ?? messageId;

		if (!options.threadId && !tokenThreadId && !inReplyTo && references.length === 0) {
			threadId =
				(await dependencies.mailbox.findThreadBySubject(
					parsed.subject ?? "",
					parsed.from?.address,
				)) ?? messageId;
		}

		await dependencies.mailbox.createEmail(
			folder,
			{
				id: messageId,
				subject: parsed.subject ?? "",
				sender: parsed.from?.address?.toLowerCase() ?? "",
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
			},
			attachmentData,
		);
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
