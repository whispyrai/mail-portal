import { isMailboxAttachmentPreviewable } from "../../shared/mailbox-attachments.ts";

export const MAX_INLINE_IMAGE_COUNT = 32;
export const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_INLINE_ATTACHMENT_METADATA = 256;

export type PlannedInlineImage = {
	cid: string;
	attachmentId: string;
	expectedMimeType: string;
	expectedSize: number;
};

const utf8 = new TextEncoder();

function baseMimeType(value: string): string {
	return value.split(";", 1)[0]!.trim().toLowerCase();
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
	value: unknown,
	maxCodeUnits: number,
	maxBytes: number,
): string | null {
	if (typeof value !== "string" || value.length > maxCodeUnits) return null;
	return utf8.encode(value).byteLength <= maxBytes ? value : null;
}

export function normalizeInlineContentId(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 512) return null;
	let normalized = value.trim();
	if (/^cid:/i.test(normalized)) normalized = normalized.slice(4).trim();
	if (normalized.startsWith("<") && normalized.endsWith(">")) {
		normalized = normalized.slice(1, -1).trim();
	}
	if (
		!normalized ||
		utf8.encode(normalized).byteLength > 512 ||
		/[\u0000-\u0020\u007f<>]/.test(normalized)
	) {
		return null;
	}
	normalized = normalized.normalize("NFC").toLowerCase();
	return normalized.length <= 512 && utf8.encode(normalized).byteLength <= 512
		? normalized
		: null;
}

function eligibleAttachment(
	attachment: unknown,
	referencedCids: ReadonlySet<string>,
): PlannedInlineImage | null {
	if (!isUnknownRecord(attachment)) return null;
	const disposition = boundedString(attachment.disposition, 32, 32);
	if (disposition?.trim().toLowerCase() !== "inline") return null;
	const cid = normalizeInlineContentId(attachment.content_id);
	if (!cid || !referencedCids.has(cid)) return null;
	const attachmentId = boundedString(attachment.id, 300, 300);
	const filename = boundedString(attachment.filename, 512, 512);
	const mimetype = boundedString(attachment.mimetype, 256, 256);
	if (!attachmentId || !filename || !mimetype) return null;
	if (
		typeof attachment.size !== "number" ||
		!Number.isSafeInteger(attachment.size) ||
		attachment.size <= 0 ||
		attachment.size > MAX_INLINE_IMAGE_BYTES
	) {
		return null;
	}
	const expectedMimeType = baseMimeType(mimetype);
	if (
		!expectedMimeType.startsWith("image/") ||
		!isMailboxAttachmentPreviewable(filename, expectedMimeType)
	) {
		return null;
	}
	return {
		cid,
		attachmentId,
		expectedMimeType,
		expectedSize: attachment.size,
	};
}

function samePlannedImage(
	left: PlannedInlineImage,
	right: PlannedInlineImage,
): boolean {
	return left.attachmentId === right.attachmentId &&
		left.expectedMimeType === right.expectedMimeType &&
		left.expectedSize === right.expectedSize;
}

export function planReferencedInlineImages(
	references: unknown,
	attachments: unknown,
): PlannedInlineImage[] {
	try {
		if (
			!Array.isArray(attachments) ||
			!Array.isArray(references) ||
			!attachments.length ||
			!references.length ||
			attachments.length > MAX_INLINE_ATTACHMENT_METADATA
		) return [];
		const orderedCids: string[] = [];
		const referencedCids = new Set<string>();
		for (const reference of references) {
			const cid = normalizeInlineContentId(reference);
			if (!cid || referencedCids.has(cid)) continue;
			referencedCids.add(cid);
			orderedCids.push(cid);
			if (orderedCids.length === MAX_INLINE_IMAGE_COUNT) break;
		}

		const candidates = new Map<string, PlannedInlineImage | null>();
		for (const attachment of attachments) {
			let candidate: PlannedInlineImage | null;
			try {
				candidate = eligibleAttachment(attachment, referencedCids);
			} catch {
				continue;
			}
			if (!candidate) continue;
			const prior = candidates.get(candidate.cid);
			if (prior === undefined) {
				candidates.set(candidate.cid, candidate);
			} else if (prior !== null && !samePlannedImage(prior, candidate)) {
				candidates.set(candidate.cid, null);
			}
		}

		const planned: PlannedInlineImage[] = [];
		let totalBytes = 0;
		for (const cid of orderedCids) {
			const candidate = candidates.get(cid);
			if (!candidate || totalBytes + candidate.expectedSize > MAX_INLINE_IMAGE_BYTES) {
				continue;
			}
			planned.push(candidate);
			totalBytes += candidate.expectedSize;
		}
		return planned;
	} catch {
		return [];
	}
}

export function isExpectedInlineImageBlob(
	planned: PlannedInlineImage,
	blob: Blob,
): boolean {
	return blob.size === planned.expectedSize &&
		baseMimeType(blob.type) === planned.expectedMimeType &&
		planned.expectedMimeType.startsWith("image/");
}
