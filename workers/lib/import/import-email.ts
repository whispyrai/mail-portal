// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import type { FolderId } from "../../../shared/folders";
import {
	storeParsedEmail,
	type EmailStorageDependencies,
	type MailboxEmailStore,
} from "../store-email.ts";
import {
	deriveImportId,
	deriveImportThreadId,
	deriveLegacyImportId,
	deriveLegacyImportThreadId,
	normalizeEmailDate,
} from "./parse.ts";
import { RecipientMemoryOrigins } from "../../../shared/recipient-suggestions.ts";

type ImportMailboxStore = MailboxEmailStore & {
	claimImportedEmail(
		emailId: string,
		legacyId: string,
		token: string,
	): Promise<
		| { status: "claimed" }
		| { status: "existing"; id: string }
		| { status: "busy" }
	>;
	releaseImportedEmailClaim(emailId: string, token: string): Promise<void>;
	renewImportedEmailClaim(emailId: string, token: string): Promise<boolean>;
	hasEmailOrThreadIdentity(identity: string): Promise<boolean>;
};

type ImportEmailDependencies = Omit<EmailStorageDependencies, "mailbox"> & {
	mailbox: ImportMailboxStore;
};

/** Import one parsed Zoho message without duplicating an earlier run. */
export async function importParsedEmail(
	dependencies: ImportEmailDependencies,
	parsed: Email,
	folder: FolderId,
	mailboxId: string,
) {
	const recipients = [...(parsed.to ?? []), ...(parsed.cc ?? []), ...(parsed.bcc ?? [])]
		.flatMap((recipient) => (recipient.address ? [recipient.address.toLowerCase()] : []))
		.sort()
		.join(",");
	const identity = {
		messageId: parsed.messageId,
		from: parsed.from?.address?.toLowerCase(),
		to: recipients,
		date: parsed.date,
		subject: parsed.subject,
		content: parsed.html ?? parsed.text ?? "",
	};
	const [id, legacyId] = await Promise.all([
		deriveImportId(identity, mailboxId),
		deriveLegacyImportId(identity),
	]);
	const claimToken = crypto.randomUUID();
	const claim = await dependencies.mailbox.claimImportedEmail(id, legacyId, claimToken);
	if (claim.status === "existing") {
		return {
			status: "skipped" as const,
			reason: "duplicate" as const,
			id: claim.id,
			folder,
		};
	}
	if (claim.status === "busy") {
		return {
			status: "skipped" as const,
			reason: "in_progress" as const,
			id,
			folder,
		};
	}

	try {
		const threadIdentity = {
			...identity,
			inReplyTo: parsed.inReplyTo,
			references: parsed.references,
		};
		const [scopedThreadId, legacyThreadId] = await Promise.all([
			deriveImportThreadId(threadIdentity, mailboxId),
			deriveLegacyImportThreadId(threadIdentity),
		]);
		const threadId = await dependencies.mailbox.hasEmailOrThreadIdentity(legacyThreadId)
			? legacyThreadId
			: scopedThreadId;
		const pendingObjects = new Map<string, ArrayBuffer | string>();
		const promotedObjects = new Set<string>();
		const attachmentIdNamespace = claimToken.replaceAll("-", "");
		const abandonPromotedObjects = async () => {
			const keys = [...promotedObjects];
			promotedObjects.clear();
			await Promise.allSettled(keys.map((key) => dependencies.bucket.delete(key)));
		};
		const ensureClaim = async () => {
			if (!(await dependencies.mailbox.renewImportedEmailClaim(id, claimToken))) {
				await abandonPromotedObjects();
				throw new Error("Import claim was lost before storage completed");
			}
		};
		const importBucket = {
			async put(key: string, value: ArrayBuffer | string) {
				pendingObjects.set(key, value);
			},
			async delete(key: string) {
				pendingObjects.delete(key);
				if (!promotedObjects.has(key)) return;
				await dependencies.bucket.delete(key);
				promotedObjects.delete(key);
			},
		};
		const importMailbox: MailboxEmailStore = {
			getEmail: (emailId) => dependencies.mailbox.getEmail(emailId),
			resolveCanonicalThreadId: (messageIds) =>
				dependencies.mailbox.resolveCanonicalThreadId(messageIds),
			createEmail: async (...args) => {
				await ensureClaim();
				for (const [key, value] of pendingObjects) {
					await ensureClaim();
					promotedObjects.add(key);
					await dependencies.bucket.put(key, value);
				}
				await ensureClaim();
				return dependencies.mailbox.createEmail(...args);
			},
		};

		await storeParsedEmail({ bucket: importBucket, mailbox: importMailbox }, parsed, {
			folder,
			date: normalizeEmailDate(parsed.date),
			messageId: id,
			read: true,
			threadId,
			recipientMemoryOrigin: RecipientMemoryOrigins.ADMIN_IMPORT,
			attachmentIdNamespace,
		});

		return { status: "imported" as const, id, folder };
	} finally {
		// The committed email is authoritative, and an abandoned claim expires.
		// A release transport failure must not turn a successful import into an
		// ambiguous client error or hide the original storage failure.
		await dependencies.mailbox.releaseImportedEmailClaim(id, claimToken).catch((error) => {
			console.warn("[mail-import] import claim release failed", {
				emailId: id,
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		});
	}
}
