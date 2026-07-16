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
import {
	ATTACHMENT_LIMITS,
	validateAttachmentSet,
} from "../../shared/attachments.ts";
import {
	contentIdForDisposition,
	isInlineImageMimeType,
} from "../../shared/content-id.ts";
import { isSesAttachmentContentId } from "./ses-attachment.ts";
import {
	attachmentStorageId,
	attachmentStorageKeyPrefix,
	attachmentStorageSourceIdentity,
	safeAttachmentStorageFilename,
} from "../../shared/attachment-filename.ts";
import type { OutboundAttachmentByteIdentity } from "./outbound-delivery-contract.ts";

/** Metadata for one stored attachment, shaped for the DO `attachments` table. */
export type StoredAttachment = {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string;
	r2_key?: string | null;
	/** Transient exact-byte proof for a new immutable outbound snapshot. */
	content_sha256?: string;
};

export class AttachmentPreparationError extends Error {
	readonly code:
		| "attachment_request_invalid"
		| "attachment_source_unavailable"
		| "attachment_destination_conflict";
	readonly status: 400 | 409;

	constructor(
		code:
			| "attachment_request_invalid"
			| "attachment_source_unavailable"
			| "attachment_destination_conflict",
		status: 400 | 409,
		message: string,
	) {
		super(message);
		this.name = "AttachmentPreparationError";
		this.code = code;
		this.status = status;
	}
}

export function classifyAttachmentPreparationFailure(error: unknown): {
	status: 400 | 409 | 503;
	code: string;
	message: string;
} {
	if (error instanceof AttachmentPreparationError) {
		return { status: error.status, code: error.code, message: error.message };
	}
	return {
		status: 503,
		code: "attachment_preparation_unavailable",
		message: "Attachments could not be prepared right now. Retry this exact send.",
	};
}

function bytesToHex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function attachmentSha256(bytes: ArrayBuffer): Promise<{
	binary: ArrayBuffer;
	hex: string;
}> {
	const binary = await crypto.subtle.digest("SHA-256", bytes);
	return { binary, hex: bytesToHex(binary) };
}

export function outboundAttachmentByteIdentities(
	attachments: readonly {
		id: string;
		size: number;
		content_sha256?: string;
		filename: string;
		mimetype: string;
		disposition?: string;
		contentId?: string | null;
		content_id?: string | null;
	}[],
): OutboundAttachmentByteIdentity[] {
	return attachments.map((attachment) => {
		if (
			!attachment.content_sha256 ||
			!/^[a-f0-9]{64}$/.test(attachment.content_sha256)
		) {
			throw new Error("Promoted attachment is missing its exact byte identity");
		}
		const disposition =
			attachment.disposition === "inline" ? "inline" : "attachment";
		const contentId = contentIdForDisposition(
			disposition,
			attachment.contentId ?? attachment.content_id,
		);
		return {
			id: attachment.id,
			byteLength: attachment.size,
			sha256: attachment.content_sha256,
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			disposition,
			...(contentId ? { contentId } : {}),
		};
	});
}

export async function outboundAttachmentBytesMatch(
	bytes: ArrayBuffer,
	identity: OutboundAttachmentByteIdentity,
): Promise<boolean> {
	if (bytes.byteLength !== identity.byteLength) return false;
	return (await attachmentSha256(bytes)).hex === identity.sha256;
}

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
	| {
			kind: "upload";
			uploadId: string;
			disposition?: "attachment" | "inline";
			contentId?: string;
	  }
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

/** R2 prefix preceding the storage-normalized filename. */
export function attachmentKeyPrefix(
	emailId: string,
	attachmentId: string,
): string {
	return attachmentStorageKeyPrefix(emailId, attachmentId);
}

/** R2 key for an attachment permanently stored against an email. */
export function attachmentKey(
	emailId: string,
	attachmentId: string,
	filename: string,
): string {
	return `${attachmentKeyPrefix(emailId, attachmentId)}${filename}`;
}

/** Exact stored byte authority, with a fallback for rows created before migration 36. */
export function storedAttachmentKey(attachment: {
	email_id: string;
	id: string;
	filename: string;
	r2_key?: string | null;
}): string {
	return (
		attachment.r2_key ??
		attachmentKey(attachment.email_id, attachment.id, attachment.filename)
	);
}

/** Strip characters that could escape the R2 key namespace or break headers. */
export function sanitizeFilename(name: string): string {
	return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

const MAX_ATTACHMENT_STORAGE_FILENAME_BYTES = 240;
const MAX_ATTACHMENT_STORAGE_EXTENSION_BYTES = 24;

/** Truncate without splitting a UTF-8 code point. */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
	if (maxBytes <= 0 || value.length === 0) return "";
	const encoder = new TextEncoder();
	if (encoder.encode(value).byteLength <= maxBytes) return value;
	let result = "";
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = encoder.encode(character).byteLength;
		if (usedBytes + characterBytes > maxBytes) break;
		result += character;
		usedBytes += characterBytes;
	}
	return result;
}

/** Bound only the filename segment used in a derived R2 object key. */
export function boundedAttachmentStorageFilename(name: string): string {
	const cleaned = sanitizeFilename(name);
	const encoder = new TextEncoder();
	if (
		encoder.encode(cleaned).byteLength <= MAX_ATTACHMENT_STORAGE_FILENAME_BYTES
	)
		return cleaned;
	const dot = cleaned.lastIndexOf(".");
	const hasExtension = dot > 0 && dot < cleaned.length - 1;
	const extension = hasExtension
		? truncateUtf8Bytes(
				cleaned.slice(dot),
				MAX_ATTACHMENT_STORAGE_EXTENSION_BYTES,
			)
		: "";
	const baseLimit =
		MAX_ATTACHMENT_STORAGE_FILENAME_BYTES -
		encoder.encode(extension).byteLength;
	const rawBase = hasExtension ? cleaned.slice(0, dot) : cleaned;
	return `${truncateUtf8Bytes(rawBase, baseLimit) || "attachment"}${extension}`;
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

function equalAttachmentBytes(left: ArrayBuffer, right: ArrayBuffer): boolean {
	if (left.byteLength !== right.byteLength) return false;
	const leftBytes = new Uint8Array(left);
	const rightBytes = new Uint8Array(right);
	return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

/** Minimal DO-stub surface needed to resolve `existing` references. */
type StubForResolve = {
	getAttachment: (id: string) => Promise<{
		filename: string;
		mimetype: string;
		size: number;
		email_id: string;
			content_id?: string | null;
			disposition?: string | null;
			r2_key?: string | null;
		} | null>;
	queueAttachmentCleanup?: (
		emailId: string,
		keys: string[],
		actor?: ActivityActor,
		promotionOwner?: string,
	) => Promise<void>;
};

type ResolvedSource = {
	attachmentId: string;
	bytes: ArrayBuffer;
	filename: string;
	mimetype: string;
	disposition: "attachment" | "inline";
	contentId: string | null;
	stagingKey?: string; // present for `upload` refs; deleted after promotion
};

export type AttachmentPromotion = {
	sesAttachments: SesAttachmentInput[];
	storedMetadata: StoredAttachment[];
	/** Upload staging objects retained until the database enqueue commits. */
	stagingKeys: string[];
	/** Permanent copies to remove if the database enqueue does not commit. */
	destinationKeys: string[];
	/** Exclusive owner required before any permanent destination can be removed. */
	promotionOwner?: string;
};

type AttachmentPromotionOptions = {
	/** Additional stable operation identity for destinations shared by one Draft. */
	identityScope?: string;
	/** Exclusive owner recorded on permanent objects for ambiguous-write recovery. */
	promotionOwner?: string;
	/** Persist the complete destination intent before the first permanent write. */
	recordDestinationIntent?: (keys: string[]) => Promise<void>;
};

async function cleanupOrQueue(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	keys: string[],
	actor: ActivityActor,
	promotionOwner?: string,
) {
	if (keys.length === 0) return;
	try {
		if (!promotionOwner) {
			await bucket.delete(keys);
			return;
		}
		const ownedKeys: string[] = [];
		for (const key of keys) {
			const object = await bucket.get(key);
			if (object?.customMetadata?.promotionOwner === promotionOwner) {
				ownedKeys.push(key);
			}
		}
		if (ownedKeys.length > 0) await bucket.delete(ownedKeys);
	} catch (error) {
		if (!stub.queueAttachmentCleanup) throw error;
		await stub.queueAttachmentCleanup(emailId, keys, actor, promotionOwner);
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
	await cleanupOrQueue(
		bucket,
		stub,
		emailId,
		promotion.destinationKeys,
		actor,
		promotion.promotionOwner,
	);
}

/** Delete replaced permanent objects, with the durable cleanup queue as fallback. */
export async function cleanupStoredAttachmentObjects(
	bucket: Env["BUCKET"],
	stub: StubForResolve,
	emailId: string,
	attachments: Array<{ id: string; filename: string; r2_key?: string | null }>,
	actor: ActivityActor = { kind: "system" },
) {
	await cleanupOrQueue(
		bucket,
		stub,
		emailId,
			attachments.map((attachment) =>
				storedAttachmentKey({ ...attachment, email_id: emailId }),
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
	options: AttachmentPromotionOptions = {},
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
		throw new AttachmentPreparationError(
			"attachment_request_invalid",
			400,
			`Too many files: max ${ATTACHMENT_LIMITS.maxFiles} per message.`,
		);
	}

	// Pass 1: locate each source and pull its bytes + metadata.
	const sources: ResolvedSource[] = [];
	const sourceOccurrences = new Map<string, number>();
	for (const ref of refs) {
		const sourceIdentity = attachmentStorageSourceIdentity(ref);
		const occurrence = sourceOccurrences.get(sourceIdentity) ?? 0;
		sourceOccurrences.set(sourceIdentity, occurrence + 1);
		const attachmentId = await attachmentStorageId(
			newEmailId,
			ref,
			occurrence,
			options.identityScope,
		);
		if (ref.kind === "upload") {
			const disposition: "attachment" | "inline" =
				ref.disposition === "inline" ? "inline" : "attachment";
			const key = uploadKey(mailboxId, ref.uploadId);
			const obj = await bucket.get(key);
			if (!obj) {
				throw new AttachmentPreparationError(
					"attachment_source_unavailable",
					409,
					"An attachment upload was not found or has expired. Re-attach the file and try again.",
				);
			}
			const meta = obj.customMetadata ?? {};
			const mimetype =
				meta.type ||
				obj.httpMetadata?.contentType ||
				"application/octet-stream";
			if (disposition === "inline" && !isInlineImageMimeType(mimetype)) {
				throw new AttachmentPreparationError(
					"attachment_request_invalid",
					400,
					"Fresh inline attachments must use an image MIME type.",
				);
			}
			sources.push({
				attachmentId,
				bytes: await obj.arrayBuffer(),
				filename: sanitizeFilename(meta.filename || "untitled"),
				mimetype,
				disposition,
				contentId: contentIdForDisposition(disposition, ref.contentId),
				stagingKey: key,
			});
		} else {
			const att = await stub.getAttachment(ref.attachmentId);
			if (!att) {
				throw new AttachmentPreparationError(
					"attachment_source_unavailable",
					409,
					"A referenced attachment no longer exists.",
				);
			}
			if (att.email_id !== ref.emailId) {
				throw new AttachmentPreparationError(
					"attachment_request_invalid",
					400,
					"A referenced attachment does not belong to the referenced email.",
				);
			}
			const disposition: "attachment" | "inline" =
				att.disposition === "inline" ? "inline" : "attachment";
			const safe = sanitizeFilename(att.filename);
			const obj = await bucket.get(
				storedAttachmentKey({ ...att, id: ref.attachmentId, filename: safe }),
			);
			if (!obj) {
				throw new AttachmentPreparationError(
					"attachment_source_unavailable",
					409,
					"A referenced attachment file is missing.",
				);
			}
			sources.push({
				attachmentId,
				bytes: await obj.arrayBuffer(),
				filename: safe,
				mimetype: att.mimetype || "application/octet-stream",
				disposition,
				contentId: contentIdForDisposition(disposition, att.content_id),
			});
		}
	}
	for (const source of sources) {
		if (
			source.disposition === "inline" &&
			source.contentId &&
			!isSesAttachmentContentId(source.contentId)
		) {
			throw new AttachmentPreparationError(
				"attachment_request_invalid",
				400,
				"An inline attachment has a Content-ID that SES cannot deliver.",
			);
		}
	}

	// Enforce the full-set limits against the actual resolved sizes.
	const setError = validateAttachmentSet(
		sources.map((s) => ({ filename: s.filename, size: s.bytes.byteLength })),
	);
	if (setError) {
		throw new AttachmentPreparationError(
			"attachment_request_invalid",
			400,
			setError,
		);
	}

	// Pass 2: promote to permanent storage + build the SES + DB payloads.
	const digestedSources = await Promise.all(
		sources.map(async (source) => ({
			...source,
			digest: await attachmentSha256(source.bytes),
		})),
	);
	const destinations = digestedSources.map((source) => {
		const filename = safeAttachmentStorageFilename(
			source.filename,
			attachmentKeyPrefix(newEmailId, source.attachmentId),
		);
		return {
			source,
			filename,
			key: attachmentKey(newEmailId, source.attachmentId, filename),
		};
	});
	await options.recordDestinationIntent?.(
		destinations.map((destination) => destination.key),
	);

	const sesAttachments: SesAttachmentInput[] = [];
	const storedMetadata: StoredAttachment[] = [];
	const destinationKeys: string[] = [];
	try {
		for (const destination of destinations) {
			const s = destination.source;
			const attachmentId = s.attachmentId;
			const filename = destination.filename;
			const destinationKey = destination.key;
			let created;
			try {
				created = await bucket.put(destinationKey, s.bytes, {
					onlyIf: { etagDoesNotMatch: "*" },
					customMetadata: {
						contentSha256: s.digest.hex,
					...(options.promotionOwner
							? { promotionOwner: options.promotionOwner }
						: {}),
					},
					sha256: s.digest.binary,
				});
			} catch (error) {
				if (!options.promotionOwner) throw error;
				const existing = await bucket.get(destinationKey);
				if (
					!existing ||
					existing.customMetadata?.promotionOwner !== options.promotionOwner ||
					!equalAttachmentBytes(await existing.arrayBuffer(), s.bytes)
				) {
					throw error;
				}
				// The object is exact and carries this operation's durable owner. It is
				// therefore both usable and safe for this operation to clean on abort.
				created = existing;
			}
			if (created) {
				destinationKeys.push(destinationKey);
			} else {
				const existing = await bucket.get(destinationKey);
				if (
					!existing ||
					(options.promotionOwner &&
						existing.customMetadata?.promotionOwner !==
							options.promotionOwner) ||
					!equalAttachmentBytes(await existing.arrayBuffer(), s.bytes)
				) {
					throw new AttachmentPreparationError(
						"attachment_destination_conflict",
						409,
						"A permanent attachment identity already contains different bytes.",
					);
				}
				if (options.promotionOwner) destinationKeys.push(destinationKey);
			}
			sesAttachments.push({
				content: arrayBufferToBase64(s.bytes),
				filename,
				type: s.mimetype,
				disposition: s.disposition,
				...(s.disposition === "inline" && s.contentId
					? { contentId: s.contentId }
					: {}),
			});
			storedMetadata.push({
				id: attachmentId,
				email_id: newEmailId,
				filename,
				mimetype: s.mimetype,
				size: s.bytes.byteLength,
					content_id: s.contentId,
					disposition: s.disposition,
				content_sha256: s.digest.hex,
					r2_key: destinationKey,
				});
		}
	} catch (error) {
		await cleanupOrQueue(
			bucket,
			stub,
			newEmailId,
			options.promotionOwner
				? destinations.map((destination) => destination.key)
				: destinationKeys,
			actor,
			options.promotionOwner,
		);
		throw error;
	}

	return {
		sesAttachments,
		storedMetadata,
		stagingKeys: sources.flatMap((source) =>
			source.stagingKey ? [source.stagingKey] : [],
		),
		destinationKeys,
		...(options.promotionOwner
			? { promotionOwner: options.promotionOwner }
			: {}),
	};
}
