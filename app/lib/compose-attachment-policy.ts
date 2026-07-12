import type { Attachment, AttachmentRef } from "../types/index.ts";
import {
	isCanonicalContentId,
	isInlineImageMimeType,
} from "../../shared/content-id.ts";
import {
	authoredBodyReferencesInlineContentId,
	validateInlineImageMappings,
} from "./compose-inline-images.ts";

export type ComposeAttachmentStatus =
	| "uploading"
	| "ready"
	| "error"
	| "rejected";

export interface ComposeAttachmentPolicyItem {
	filename: string;
	mimetype?: string;
	status: ComposeAttachmentStatus;
	error?: string;
	uploadId?: string;
	existing?: { emailId: string; attachmentId: string };
	disposition?: "attachment" | "inline";
	contentId?: string;
}

export interface ComposeAttachmentRecord extends ComposeAttachmentPolicyItem {
	localId: string;
	mimetype: string;
	size: number;
	file?: File;
}

export type ComposeAttachmentPolicyResult =
	| { ok: true; refs: AttachmentRef[] }
	| { ok: false; error: string };

/**
 * Upload requests do not survive a composer remount. Preserve every settled
 * record exactly, but turn an orphaned in-flight record into an explicit error
 * that retains its File for a deliberate user retry.
 */
export function recoverComposeAttachments(
	attachments: ReadonlyArray<ComposeAttachmentRecord>,
): ComposeAttachmentRecord[] {
	return attachments.map((attachment) =>
		attachment.status === "uploading"
			? {
					...attachment,
					status: "error",
					error: "The upload was interrupted. Retry it or remove the file.",
					uploadId: undefined,
					existing: undefined,
			  }
			: attachment,
	);
}

export function bodyReferencesInlineAttachment(
	bodyHtml: string,
	contentId: string | null | undefined,
): boolean {
	return authoredBodyReferencesInlineContentId(bodyHtml, contentId);
}

/**
 * Decide whether the exact attachment list shown by the composer can cross an
 * outgoing boundary. Save and Send use this same result, so neither operation
 * can silently omit a chip that failed, was rejected, is still uploading, or
 * lost its durable upload/existing reference.
 */
export function evaluateComposeAttachments(
	attachments: ComposeAttachmentPolicyItem[],
	bodyHtml?: string,
): ComposeAttachmentPolicyResult {
	const refs: AttachmentRef[] = [];

	for (const attachment of attachments) {
		if (attachment.status === "uploading") {
			return {
				ok: false,
				error: `Wait for "${attachment.filename}" to finish uploading before saving or sending.`,
			};
		}
		if (attachment.status === "error") {
			return {
				ok: false,
				error: `"${attachment.filename}" could not be attached: ${attachment.error || "Upload failed."} Retry the upload or remove the file before saving or sending.`,
			};
		}
		if (attachment.status === "rejected") {
			return {
				ok: false,
				error: `"${attachment.filename}" was rejected: ${attachment.error || "This file is not supported."} Remove it or choose a supported file before saving or sending.`,
			};
		}

		const hasUpload = Boolean(attachment.uploadId);
		const hasExisting = Boolean(
			attachment.existing?.emailId && attachment.existing.attachmentId,
		);
		if (hasUpload === hasExisting) {
			return {
				ok: false,
				error: `"${attachment.filename}" is not attached to an outgoing file. Retry the upload or remove the file before saving or sending.`,
			};
		}

		const disposition = attachment.disposition ?? "attachment";
		if (hasUpload && disposition === "inline") {
			if (!attachment.contentId || !isCanonicalContentId(attachment.contentId)) {
				return {
					ok: false,
					error: `"${attachment.filename}" needs a valid Content-ID before it can be saved or sent inline.`,
				};
			}
			if (!isInlineImageMimeType(attachment.mimetype)) {
				return {
					ok: false,
					error: `"${attachment.filename}" must be an image to be saved or sent inline.`,
				};
			}
		} else if (hasUpload && attachment.contentId !== undefined) {
			return {
				ok: false,
				error: `"${attachment.filename}" has a Content-ID that is only valid for inline uploads.`,
			};
		}
		if (hasExisting && attachment.existing) {
			refs.push({
				kind: "existing",
				emailId: attachment.existing.emailId,
				attachmentId: attachment.existing.attachmentId,
				disposition,
			});
		} else if (attachment.uploadId) {
			refs.push({
				kind: "upload",
				uploadId: attachment.uploadId,
				disposition,
				...(disposition === "inline" && attachment.contentId
					? { contentId: attachment.contentId }
					: {}),
			});
		}
	}
	if (bodyHtml !== undefined) {
		const mapping = validateInlineImageMappings(bodyHtml, attachments);
		if (!mapping.ok) return mapping;
	}

	return { ok: true, refs };
}

/**
 * Build the complete attachment reference set for the message-panel's
 * one-click draft send. This uses the same fail-closed policy as the composer
 * and deliberately includes inline parts, which are part of the draft body
 * even though they are not ordinary downloadable attachments.
 */
export function evaluateStoredDraftAttachments(
	draftId: string,
	attachments: Attachment[] | undefined,
	bodyHtml?: string,
): ComposeAttachmentPolicyResult {
	return evaluateComposeAttachments(
		(attachments ?? []).map((attachment) => ({
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			status: "ready",
			disposition:
				attachment.disposition === "inline" ? "inline" : "attachment",
			existing: attachment.id
				? { emailId: draftId, attachmentId: attachment.id }
				: undefined,
			contentId: attachment.content_id,
		})),
		bodyHtml,
	);
}

function attachmentSignature(attachment: {
	filename: string;
	mimetype: string;
	size: number;
	disposition?: string;
	contentId?: string | null;
}): string {
	return JSON.stringify([
		attachment.filename,
		attachment.mimetype,
		attachment.size,
		attachment.disposition === "inline" ? "inline" : "attachment",
		attachment.contentId ?? null,
	]);
}

/**
 * Replace the upload/existing references represented by one committed save
 * without erasing attachments the user added or removed while it was in flight.
 */
export function reconcileSavedComposeAttachments(
	current: ComposeAttachmentRecord[],
	snapshot: ComposeAttachmentRecord[],
	draftId: string,
	savedAttachments: Attachment[],
): ComposeAttachmentRecord[] {
	const savedBySignature = new Map<string, Attachment[]>();
	for (const saved of savedAttachments) {
		const signature = attachmentSignature({
			filename: saved.filename,
			mimetype: saved.mimetype,
			size: saved.size,
			disposition: saved.disposition,
			contentId: saved.content_id,
		});
		const candidates = savedBySignature.get(signature) ?? [];
		candidates.push(saved);
		savedBySignature.set(signature, candidates);
	}

	const savedByLocalId = new Map<string, Attachment>();
	for (const source of snapshot) {
		const signature = attachmentSignature(source);
		const candidates = savedBySignature.get(signature);
		const saved = candidates?.shift();
		if (saved) savedByLocalId.set(source.localId, saved);
	}
	const snapshotIds = new Set(snapshot.map((attachment) => attachment.localId));

	return current.map((attachment) => {
		if (!snapshotIds.has(attachment.localId)) return attachment;
		const saved = savedByLocalId.get(attachment.localId);
		if (!saved) {
			return {
				...attachment,
				status: "error",
				error: "The saved draft did not confirm this attachment. Retry or remove it.",
				uploadId: undefined,
				existing: undefined,
			};
		}
		return {
			...attachment,
			filename: saved.filename,
			mimetype: saved.mimetype,
			size: saved.size,
			status: "ready",
			error: undefined,
			uploadId: undefined,
			disposition:
				saved.disposition === "inline" ? "inline" : "attachment",
			contentId: saved.content_id,
			existing: { emailId: draftId, attachmentId: saved.id },
		};
	});
}
