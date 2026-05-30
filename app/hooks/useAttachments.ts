// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Composer attachment state for the upload-first model. Holds the unified list
 * of attachments (freshly picked files that upload to staging, plus files
 * hydrated from a reopened draft), validates against the shared limits, tracks
 * per-file upload status, and produces the lightweight references the send /
 * reply / draft endpoints expect.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import api from "~/services/api";
import { validateSingleFile, validateAttachmentSet } from "shared/attachments";
import { getNonInlineAttachments } from "~/lib/utils";
import type { Attachment, AttachmentRef } from "~/types";

export interface ComposeAttachment {
	/** Stable client-side id for React keys and status updates. */
	localId: string;
	filename: string;
	mimetype: string;
	size: number;
	status: "uploading" | "ready" | "error";
	error?: string;
	/** Set once a freshly picked file finishes uploading to staging. */
	uploadId?: string;
	/** Set when the chip came from a reopened draft (already stored in R2). */
	existing?: { emailId: string; attachmentId: string };
}

/** Map ready attachments to send references. Errored/uploading chips are skipped. */
export function attachmentsToRefs(attachments: ComposeAttachment[]): AttachmentRef[] {
	const refs: AttachmentRef[] = [];
	for (const a of attachments) {
		if (a.status !== "ready") continue;
		if (a.existing) {
			refs.push({ kind: "existing", emailId: a.existing.emailId, attachmentId: a.existing.attachmentId });
		} else if (a.uploadId) {
			refs.push({ kind: "upload", uploadId: a.uploadId });
		}
	}
	return refs;
}

function newLocalId(): string {
	return crypto.randomUUID();
}

export function useAttachments(mailboxId: string | undefined) {
	const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
	// Mirror to a ref so addFiles can read the latest list for limit math without
	// depending on a possibly-stale closure.
	const attachmentsRef = useRef(attachments);
	useEffect(() => {
		attachmentsRef.current = attachments;
	}, [attachments]);

	const uploadOne = useCallback(
		async (localId: string, file: File) => {
			if (!mailboxId) return;
			try {
				const res = await api.uploadAttachment(mailboxId, file);
				setAttachments((prev) =>
					prev.map((a) =>
						a.localId === localId
							? { ...a, status: "ready", uploadId: res.uploadId, filename: res.filename, mimetype: res.mimetype, size: res.size }
							: a,
					),
				);
			} catch (e) {
				const msg = e instanceof Error ? e.message : "Upload failed.";
				setAttachments((prev) =>
					prev.map((a) => (a.localId === localId ? { ...a, status: "error", error: msg } : a)),
				);
			}
		},
		[mailboxId],
	);

	const addFiles = useCallback(
		(files: FileList | File[]) => {
			const incoming = Array.from(files);
			if (incoming.length === 0) return;

			// Limit math runs against everything already accepted (not the errored chips).
			const working = attachmentsRef.current
				.filter((a) => a.status !== "error")
				.map((a) => ({ filename: a.filename, size: a.size }));

			const created: ComposeAttachment[] = [];
			const toUpload: { localId: string; file: File }[] = [];

			for (const file of incoming) {
				const localId = newLocalId();
				const base = {
					localId,
					filename: file.name,
					mimetype: file.type || "application/octet-stream",
					size: file.size,
				};
				const single = validateSingleFile({ filename: file.name, size: file.size });
				if (single) {
					created.push({ ...base, status: "error", error: single });
					continue;
				}
				const setErr = validateAttachmentSet([...working, { filename: file.name, size: file.size }]);
				if (setErr) {
					created.push({ ...base, status: "error", error: setErr });
					continue;
				}
				working.push({ filename: file.name, size: file.size });
				created.push({ ...base, status: "uploading" });
				toUpload.push({ localId, file });
			}

			setAttachments((prev) => [...prev, ...created]);
			for (const u of toUpload) void uploadOne(u.localId, u.file);
		},
		[uploadOne],
	);

	const removeAttachment = useCallback((localId: string) => {
		// Staging objects for removed uploads are reaped by the R2 lifecycle rule.
		setAttachments((prev) => prev.filter((a) => a.localId !== localId));
	}, []);

	/** Seed chips from a reopened draft's stored attachments (references, no re-upload). */
	const hydrateFromDraft = useCallback((emailId: string, draftAttachments?: Attachment[]) => {
		const files = getNonInlineAttachments(draftAttachments);
		setAttachments(
			files.map((a) => ({
				localId: newLocalId(),
				filename: a.filename,
				mimetype: a.mimetype,
				size: a.size,
				status: "ready" as const,
				existing: { emailId, attachmentId: a.id },
			})),
		);
	}, []);

	const reset = useCallback(() => setAttachments([]), []);

	const isUploading = attachments.some((a) => a.status === "uploading");
	const hasError = attachments.some((a) => a.status === "error");

	return {
		attachments,
		addFiles,
		removeAttachment,
		hydrateFromDraft,
		reset,
		isUploading,
		hasError,
	};
}
