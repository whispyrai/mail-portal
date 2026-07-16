// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import type { FolderId } from "../../../shared/folders";
import {
	assertR2DerivedUploadSize,
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
import { mailTelemetryLogRef } from "../mail-telemetry.ts";

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
	releaseImportedEmailClaim(emailId: string, token: string): Promise<boolean>;
	renewImportedEmailClaim(emailId: string, token: string): Promise<boolean>;
	beginImportedEmailPromotionIntent(
		emailId: string,
		claimToken: string,
		objectCount: number,
		totalByteLength: number,
	): Promise<unknown>;
	appendImportedEmailPromotionIntent(
		emailId: string,
		claimToken: string,
		objects: Array<{ ordinal: number; r2Key: string; byteLength: number }>,
	): Promise<unknown>;
	sealImportedEmailPromotionIntent(
		emailId: string,
		claimToken: string,
	): Promise<{ proofFingerprint: string }>;
	finalizeImportedEmailPromotionIntent(
		emailId: string,
		claimToken: string,
		proofFingerprint: string,
	): Promise<{ status: "pending" | "finalized" | "integrity_blocked" }>;
	createImportedEmail(
		folder: Parameters<MailboxEmailStore["createEmail"]>[0],
		email: Parameters<MailboxEmailStore["createEmail"]>[1],
		attachments: Parameters<MailboxEmailStore["createEmail"]>[2],
		mailboxAddress: string | undefined,
		claimToken: string,
		proofFingerprint: string,
	): Promise<{ status?: string }>;
	hasEmailOrThreadIdentity(identity: string): Promise<boolean>;
};

type ImportEmailDependencies = Omit<EmailStorageDependencies, "mailbox"> & {
	mailbox: ImportMailboxStore;
};

function objectByteLength(value: ArrayBuffer | string): number {
	return typeof value === "string"
		? new TextEncoder().encode(value).byteLength
		: value.byteLength;
}

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
	let sealedFingerprint: string | null = null;
	let intendedObjectCount = 0;
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
			const outcomes = await Promise.allSettled(
				keys.map((key) => dependencies.bucket.delete(key)),
			);
			outcomes.forEach((outcome, index) => {
				if (outcome.status === "fulfilled") promotedObjects.delete(keys[index]!);
			});
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
				return { size: objectByteLength(value) };
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
				const objects = [...pendingObjects].map(([r2Key, value], ordinal) => ({
					ordinal,
					r2Key,
					byteLength: objectByteLength(value),
				}));
				intendedObjectCount = objects.length;
				await dependencies.mailbox.beginImportedEmailPromotionIntent(
					id,
					claimToken,
					objects.length,
					objects.reduce((total, object) => total + object.byteLength, 0),
				);
				for (let offset = 0; offset < objects.length; offset += 20) {
					await dependencies.mailbox.appendImportedEmailPromotionIntent(
						id,
						claimToken,
						objects.slice(offset, offset + 20),
					);
				}
				sealedFingerprint = (
					await dependencies.mailbox.sealImportedEmailPromotionIntent(id, claimToken)
				).proofFingerprint;
				for (const [key, value] of pendingObjects) {
					await ensureClaim();
					promotedObjects.add(key);
					const result = await dependencies.bucket.put(key, value);
					assertR2DerivedUploadSize(result, objectByteLength(value));
				}
				await ensureClaim();
				const result = await dependencies.mailbox.createImportedEmail(
					args[0],
					args[1],
					args[2],
					args[4],
					claimToken,
					sealedFingerprint,
				);
				if (result.status === "cleanup_conflict") {
					throw new Error("Import promotion cleanup ownership conflicted");
				}
				return result;
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
			mailboxAddress: mailboxId,
		});

		return { status: "imported" as const, id, folder };
		} finally {
			const messageRef = await mailTelemetryLogRef("message", id);
			if (sealedFingerprint) {
			const maximumPasses = 2 * Math.ceil(intendedObjectCount / 20) + 3;
			for (let pass = 0; pass < maximumPasses; pass += 1) {
				try {
					const result = await dependencies.mailbox.finalizeImportedEmailPromotionIntent(
						id,
						claimToken,
						sealedFingerprint,
					);
					if (result.status !== "pending") break;
					} catch {
						if (pass + 1 === maximumPasses) {
							console.warn("[mail-import] durable promotion finalization deferred", {
								errorCode: "IMPORT_PROMOTION_FINALIZATION_DEFERRED",
								messageRef,
								operation: "import_promotion_finalize",
								status: "deferred",
							});
					}
				}
			}
		} else {
				await dependencies.mailbox.releaseImportedEmailClaim(id, claimToken).catch(() => {
					console.warn("[mail-import] import claim release failed", {
						errorCode: "IMPORT_CLAIM_RELEASE_FAILED",
						messageRef,
						operation: "import_claim_release",
						status: "degraded",
					});
			});
		}
	}
}
