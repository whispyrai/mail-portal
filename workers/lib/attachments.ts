// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound-attachment storage for the upload-first reference model.
 *
 * Files are uploaded once to R2 staging (`uploads/{mailbox}/{uploadId}`), and
 * carried through compose/reply/bulk as lightweight *references*. At send time
 * `resolveAndPromoteAttachments` reads the bytes, enforces the shared limits,
 * base64-encodes for SES, and writes a permanent per-email copy under
 * `attachments/{emailId}/...` (the same layout inbound mail and the download
 * route already use).
 */
import type { Env } from "../types";
import type { ActivityActor } from "./activity.ts";
import { ATTACHMENT_LIMITS, validateAttachmentSet } from "../../shared/attachments.ts";

/** Metadata for one stored attachment, shaped for the DO `attachments` table. */
export type StoredAttachment = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
};

/** An attachment shaped for `sendEmail` (SES inline delivery). */
type SesAttachmentInput = {
	content: string; // base64
	filename: string;
	type: string;
	disposition: "attachment" | "inline";
	contentId?: string;
};

/**
 * A reference to a file to attach, sent by the client instead of the bytes:
 *  - `upload`: a freshly uploaded file still in R2 staging.
 *  - `existing`: a file already stored against another email (e.g. a draft
 *    being sent, where the draft already owns the R2 objects).
 */
export type AttachmentRef =
	| { kind: "upload"; uploadId: string; disposition?: "attachment" | "inline" }
	| {
			kind: "existing";
			emailId: string;
			attachmentId: string;
			disposition?: "attachment" | "inline";
	  };

/**
 * Capture the source-draft attachment identities represented by a send. Any
 * upload or attachment owned by another email receives a non-matching marker,
 * forcing cancellation to recover the immutable snapshot conservatively.
 */
export function sourceDraftAttachmentIds(
	draftId: string | undefined,
	refs: AttachmentRef[] | undefined,
): string[] | undefined {
	if (!draftId) return undefined;
	return (refs ?? []).map((ref) =>
		ref.kind === "existing" && ref.emailId === draftId
			? ref.attachmentId
			: `!${ref.kind}:${ref.kind === "upload" ? ref.uploadId : `${ref.emailId}:${ref.attachmentId}`}`,
	);
}

/** R2 key for a freshly uploaded file not yet attached to a sent email. */
export function uploadKey(mailboxId: string, uploadId: string): string {
	return `uploads/${mailboxId.toLowerCase()}/${uploadId}`;
}

/** R2 key for an attachment permanently stored against an email. */
export function attachmentKey(emailId: string, attachmentId: string, filename: string): string {
	return `attachments/${emailId}/${attachmentId}/${filename}`;
}

/** Strip characters that could escape the R2 key namespace or break headers. */
export function sanitizeFilename(name: string): string {
	return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

/**
 * Base64-encode an ArrayBuffer in chunks. `btoa(String.fromCharCode(...bytes))`
 * blows the call stack for large files; chunking keeps each spread small.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	const CHUNK = 0x8000; // 32 KB
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** Minimal DO-stub surface needed to resolve `existing` references. */
type StubForResolve = {
	getAttachment: (
		id: string,
	) => Promise<{ filename: string; mimetype: string; size: number; email_id: string } | null>;
	queueAttachmentCleanup?: (
		emailId: string,
		keys: string[],
		actor?: ActivityActor,
	) => Promise<void>;
};

type ResolvedSource = {
	bytes: ArrayBuffer;
	filename: string;
	mimetype: string;
	disposition: "attachment" | "inline";
	stagingKey?: string; // present for `upload` refs; deleted after promotion
};

export type AttachmentPromotion = {
	sesAttachments: SesAttachmentInput[];
	storedMetadata: StoredAttachment[];
	/** Upload staging objects retained until the database enqueue commits. */
	stagingKeys: string[];
	/** Permanent copies to remove if the database enqueue does not commit. */
	destinationKeys: string[];
};

async function cleanupOrQueue(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	keys: string[],
	actor: ActivityActor,
) {
	if (keys.length === 0) return;
	try {
		await bucket.delete(keys);
	} catch (error) {
		if (!stub.queueAttachmentCleanup) throw error;
		await stub.queueAttachmentCleanup(emailId, keys, actor);
	}
}

/** Complete a committed promotion by deleting its now-redundant upload staging. */
export async function completeAttachmentPromotion(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	promotion: AttachmentPromotion,
	actor: ActivityActor = { kind: "system" },
) {
	await cleanupOrQueue(bucket, stub, emailId, promotion.stagingKeys, actor);
}

/** Roll back an uncommitted promotion without touching retryable staging data. */
export async function rollbackAttachmentPromotion(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	promotion: AttachmentPromotion,
	actor: ActivityActor = { kind: "system" },
) {
	await cleanupOrQueue(bucket, stub, emailId, promotion.destinationKeys, actor);
}

/** Delete replaced permanent objects, with the durable cleanup queue as fallback. */
export async function cleanupStoredAttachmentObjects(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	attachments: Array<{ id: string; filename: string }>,
	actor: ActivityActor = { kind: "system" },
) {
	await cleanupOrQueue(
		bucket,
		stub,
		emailId,
		attachments.map((attachment) =>
			attachmentKey(emailId, attachment.id, attachment.filename),
		),
		actor,
	);
}

/**
 * Resolve attachment references to deliverable + storable form.
 *
 * Reads each ref's bytes from R2, enforces the shared count/size limits against
 * the real resolved sizes, base64-encodes for SES, writes a fresh permanent
 * copy under `attachments/{newEmailId}/...`, and returns an explicit promotion
 * receipt. Upload staging remains intact until the caller confirms its durable
 * database write, so a failed enqueue can be retried without re-uploading.
 * Throws on a missing/expired upload or a limit violation.
 */
export async function resolveAndPromoteAttachments(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	mailboxId: string,
	newEmailId: string,
	refs: AttachmentRef[] | undefined,
	actor: ActivityActor = { kind: "system" },
): Promise<AttachmentPromotion> {
	if (!refs?.length) {
		return {
			sesAttachments: [],
			storedMetadata: [],
			stagingKeys: [],
			destinationKeys: [],
		};
	}
	if (refs.length > ATTACHMENT_LIMITS.maxFiles) {
		throw new Error(`Too many files: max ${ATTACHMENT_LIMITS.maxFiles} per message.`);
	}

	// Pass 1: locate each source and pull its bytes + metadata.
	const sources: ResolvedSource[] = [];
	for (const ref of refs) {
		const disposition: "attachment" | "inline" =
			ref.disposition === "inline" ? "inline" : "attachment";

		if (ref.kind === "upload") {
			const key = uploadKey(mailboxId, ref.uploadId);
			const obj = await bucket.get(key);
			if (!obj) {
				throw new Error(
					"An attachment upload was not found or has expired. Re-attach the file and try again.",
				);
			}
			const meta = obj.customMetadata ?? {};
			sources.push({
				bytes: await obj.arrayBuffer(),
				filename: sanitizeFilename(meta.filename || "untitled"),
				mimetype: meta.type || obj.httpMetadata?.contentType || "application/octet-stream",
				disposition,
				stagingKey: key,
			});
		} else {
			const att = await stub.getAttachment(ref.attachmentId);
			if (!att) throw new Error("A referenced attachment no longer exists.");
			const safe = sanitizeFilename(att.filename);
			const obj = await bucket.get(attachmentKey(att.email_id, ref.attachmentId, safe));
			if (!obj) throw new Error("A referenced attachment file is missing.");
			sources.push({
				bytes: await obj.arrayBuffer(),
				filename: safe,
				mimetype: att.mimetype || "application/octet-stream",
				disposition,
			});
		}
	}

	// Enforce the full-set limits against the actual resolved sizes.
	const setError = validateAttachmentSet(
		sources.map((s) => ({ filename: s.filename, size: s.bytes.byteLength })),
	);
	if (setError) throw new Error(setError);

	// Pass 2: promote to permanent storage + build the SES + DB payloads.
	const sesAttachments: SesAttachmentInput[] = [];
	const storedMetadata: StoredAttachment[] = [];
	const destinationKeys: string[] = [];
	try {
		for (const s of sources) {
			const attachmentId = crypto.randomUUID();
			const destinationKey = attachmentKey(
				newEmailId,
				attachmentId,
				s.filename,
			);
			await bucket.put(destinationKey, s.bytes);
			destinationKeys.push(destinationKey);
			sesAttachments.push({
				content: arrayBufferToBase64(s.bytes),
				filename: s.filename,
				type: s.mimetype,
				disposition: s.disposition,
			});
			storedMetadata.push({
				id: attachmentId,
				email_id: newEmailId,
				filename: s.filename,
				mimetype: s.mimetype,
				size: s.bytes.byteLength,
				content_id: null,
				disposition: s.disposition,
			});
		}
	} catch (error) {
		await cleanupOrQueue(bucket, stub, newEmailId, destinationKeys, actor);
		throw error;
	}

	return {
		sesAttachments,
		storedMetadata,
		stagingKeys: sources.flatMap((source) =>
			source.stagingKey ? [source.stagingKey] : [],
		),
		destinationKeys,
	};
}
