// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Composer attachment state for the upload-first model. Holds the unified list
 * of attachments (freshly picked files that upload to staging, plus files
 * hydrated from a reopened draft), validates against the shared limits, tracks
 * per-file upload status, and retains the source needed for explicit retries.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import api from "~/services/api";
import {
	recoverComposeAttachments,
	prepareSavedComposeAttachmentReconciliation,
	type ComposeAttachmentRecord,
} from "~/lib/compose-attachment-policy";
import { planComposeAttachmentAdmission } from "~/lib/compose-attachment-admission";
import { ComposeUploadAttemptRegistry } from "~/lib/compose-upload-attempts";
import {
	generateClientInlineContentId,
	type InlineImageInsertion,
} from "~/lib/compose-inline-images";
import { ComposeInlinePreviewUrls } from "~/lib/compose-inline-preview-urls";
import type { Attachment } from "~/types";
import { isInlineImageMimeType } from "../../shared/content-id";

export type ComposeAttachment = ComposeAttachmentRecord;
function newLocalId(): string {
	return crypto.randomUUID();
}

export function useAttachments(mailboxId: string | undefined) {
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	const [inlineImagePreviews, setInlineImagePreviews] = useState<
		Record<string, string>
	>({});
	const attachmentsRef = useRef<ComposeAttachment[]>([]);
	const uploadAttemptsRef = useRef(new ComposeUploadAttemptRegistry());
	const previewUrlsRef = useRef<ComposeInlinePreviewUrls | null>(null);
	if (!previewUrlsRef.current) {
		previewUrlsRef.current = new ComposeInlinePreviewUrls({
			createObjectURL: (file) => URL.createObjectURL(file),
			revokeObjectURL: (url) => URL.revokeObjectURL(url),
		});
	}
	const previewUrls = previewUrlsRef.current;
	const commitAttachments = useCallback(
		(
			update:
				| ComposeAttachment[]
				| ((current: ComposeAttachment[]) => ComposeAttachment[]),
		) => {
			const nextAttachments =
				typeof update === "function" ? update(attachmentsRef.current) : update;
			attachmentsRef.current = nextAttachments;
			setAttachments(nextAttachments);
			setInlineImagePreviews(previewUrls.reconcile(nextAttachments, mailboxId));
			return nextAttachments;
		},
		[mailboxId, previewUrls],
	);
	useEffect(() => () => {
		uploadAttemptsRef.current.abortAll();
		previewUrlsRef.current?.releaseAll();
	}, []);

	const uploadOne = useCallback(
		async (localId: string, file: File) => {
			const attempts = uploadAttemptsRef.current;
			const { token, signal } = attempts.begin(localId);
			if (!mailboxId) {
				if (!attempts.isCurrent(localId, token)) return;
				commitAttachments((prev) =>
					prev.map((attachment) =>
						attachment.localId === localId
							? {
								...attachment,
								status: "error",
								error: "No mailbox is available for this upload.",
							  }
							: attachment,
					),
				);
				attempts.finish(localId, token);
				return;
			}
			try {
				const res = await api.uploadAttachment(mailboxId, localId, file, signal);
				if (!attempts.isCurrent(localId, token)) return;
				commitAttachments((prev) =>
					prev.map((a) =>
						a.localId === localId && a.status === "uploading"
							? {
								...a,
								status: "ready",
								error: undefined,
								uploadId: res.uploadId,
								filename: res.filename,
								mimetype: res.mimetype,
								size: res.size,
							  }
							: a,
					),
				);
			} catch (e) {
				if (!attempts.isCurrent(localId, token)) return;
				const msg = e instanceof Error ? e.message : "Upload failed.";
				commitAttachments((prev) =>
					prev.map((a) =>
						a.localId === localId && a.status === "uploading"
							? { ...a, status: "error", error: msg, uploadId: undefined }
							: a,
					),
				);
			} finally {
				attempts.finish(localId, token);
			}
		},
		[commitAttachments, mailboxId],
	);

	const admitFiles = useCallback(
		(
			files: FileList | File[],
			dispositionFor: (file: File) => "attachment" | "inline",
		): InlineImageInsertion[] => {
			const incoming = Array.from(files);
			if (incoming.length === 0) return [];

			const admission = planComposeAttachmentAdmission(
				attachmentsRef.current,
				incoming.map((file) => ({ filename: file.name, size: file.size })),
			);
			const created: ComposeAttachment[] = [];
			const toUpload: { localId: string; file: File }[] = [];
			const insertions: InlineImageInsertion[] = [];

			for (const decision of admission.decisions) {
				const file = incoming[decision.index];
				if (!file) continue;
				const localId = newLocalId();
				const disposition = dispositionFor(file);
				const contentId = disposition === "inline"
					? generateClientInlineContentId()
					: undefined;
				const base: Omit<
					ComposeAttachment,
					"status" | "error" | "uploadId" | "existing"
				> = {
					localId,
					filename: file.name,
					mimetype: file.type || "application/octet-stream",
					size: file.size,
					file,
					disposition,
					contentId,
				};
				if (!decision.accepted) {
					created.push({
						...base,
						status: "rejected",
						error: decision.error ?? "This file could not be attached.",
					});
					continue;
				}
				created.push({ ...base, status: "uploading" });
				toUpload.push({ localId, file });
				if (disposition === "inline" && contentId) {
					insertions.push({ contentId, alt: file.name });
				}
			}

			const nextAttachments = [...attachmentsRef.current, ...created];
			commitAttachments(nextAttachments);
			for (const upload of toUpload) void uploadOne(upload.localId, upload.file);
			return insertions;
		},
		[commitAttachments, uploadOne],
	);

	const addFiles = useCallback(
		(files: FileList | File[]) => {
			admitFiles(files, () => "attachment");
		},
		[admitFiles],
	);

	const addInlineImages = useCallback(
		(files: FileList | File[]) =>
			admitFiles(files, (file) =>
				isInlineImageMimeType(file.type) ? "inline" : "attachment"
			),
		[admitFiles],
	);

	const retryAttachment = useCallback(
		(localId: string) => {
			uploadAttemptsRef.current.abort(localId);
			const attachment = attachmentsRef.current.find(
				(candidate) => candidate.localId === localId,
			);
			if (!attachment) return;
			if (!attachment.file) {
				commitAttachments((prev) =>
					prev.map((candidate) =>
						candidate.localId === localId
							? {
								...candidate,
								status: "error",
								error:
									"This stored file cannot be retried. Remove it and attach the original file again.",
							  }
							: candidate,
					),
				);
				return;
			}

			const retryAdmission = planComposeAttachmentAdmission(
				attachmentsRef.current.filter(
					(candidate) => candidate.localId !== localId,
				),
				[{ filename: attachment.file.name, size: attachment.file.size }],
			);
			const validationError = retryAdmission.decisions[0]?.error;

			if (validationError) {
				commitAttachments((prev) =>
					prev.map((candidate) =>
						candidate.localId === localId
							? {
								...candidate,
								status: "rejected",
								error: validationError,
								uploadId: undefined,
							  }
							: candidate,
					),
				);
				return;
			}

			commitAttachments((prev) =>
				prev.map((candidate) =>
					candidate.localId === localId
						? {
							...candidate,
							status: "uploading",
							error: undefined,
							uploadId: undefined,
							existing: undefined,
						  }
						: candidate,
				),
			);
			void uploadOne(localId, attachment.file);
		},
		[commitAttachments, uploadOne],
	);

	const removeAttachment = useCallback((localId: string) => {
		// Staging objects for removed uploads are reaped by the R2 lifecycle rule.
		uploadAttemptsRef.current.abort(localId);
		previewUrlsRef.current?.release(localId);
		commitAttachments((prev) => prev.filter((a) => a.localId !== localId));
	}, [commitAttachments]);

	/** Seed chips from a reopened draft's stored attachments (references, no re-upload). */
	const hydrateFromDraft = useCallback((emailId: string, draftAttachments?: Attachment[]) => {
		uploadAttemptsRef.current.abortAll();
		previewUrlsRef.current?.releaseAll();
		const hydrated: ComposeAttachment[] = (draftAttachments ?? []).map((a) => ({
			localId: newLocalId(),
			filename: a.filename,
			mimetype: a.mimetype,
			size: a.size,
			status: "ready",
			disposition: a.disposition === "inline" ? "inline" : "attachment",
			contentId: a.content_id,
			existing: { emailId, attachmentId: a.id },
		}));
		commitAttachments(hydrated);
	}, [commitAttachments]);

	const reconcileSavedDraft = useCallback(
		async (
			emailId: string,
			snapshot: ComposeAttachment[],
			draftAttachments?: Attachment[],
			attachmentIdentityScope?: string,
		) => {
			const apply = await prepareSavedComposeAttachmentReconciliation(
				snapshot,
				emailId,
				draftAttachments ?? [],
				attachmentIdentityScope,
			);
			return commitAttachments((current) => apply(current));
		},
		[commitAttachments],
	);

	const reset = useCallback(() => {
		uploadAttemptsRef.current.abortAll();
		previewUrlsRef.current?.releaseAll();
		commitAttachments([]);
	}, [commitAttachments]);
	const restore = useCallback((value: ComposeAttachment[]) => {
		uploadAttemptsRef.current.abortAll();
		previewUrlsRef.current?.releaseAll();
		commitAttachments(recoverComposeAttachments(value));
	}, [commitAttachments]);

	const isUploading = attachments.some((a) => a.status === "uploading");

	return {
		attachments,
		addFiles,
		addInlineImages,
		inlineImagePreviews,
		removeAttachment,
		retryAttachment,
		hydrateFromDraft,
		reconcileSavedDraft,
		reset,
		restore,
		isUploading,
	};
}
