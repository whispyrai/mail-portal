// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	PaperclipIcon,
	FileIcon,
	ImageIcon,
	XIcon,
	CircleNotchIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRef } from "react";
import { formatBytes } from "~/lib/utils";
import type { ComposeAttachment } from "~/hooks/useAttachments";
import { bodyReferencesInlineAttachment } from "~/lib/compose-attachment-policy";

interface ComposeAttachmentsProps {
	attachments: ComposeAttachment[];
	bodyHtml: string;
	onAddFiles: (files: FileList) => void;
	onRemove: (localId: string) => void;
	onRetry: (localId: string) => void;
	disabled?: boolean;
}

/**
 * The composer's attach control: a paperclip trigger plus a chip row that
 * mirrors the read-only EmailAttachmentList styling, with per-file upload
 * spinner, error state, and a remove button.
 */
export default function ComposeAttachments({
	attachments,
	bodyHtml,
	onAddFiles,
	onRemove,
	onRetry,
	disabled = false,
}: ComposeAttachmentsProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div aria-live="polite">
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				disabled={disabled}
				className="flex min-h-11 items-center gap-1.5 rounded px-1 text-sm text-kumo-link hover:text-kumo-link-hover font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<PaperclipIcon size={15} />
				Attach files
			</button>
			<input
				ref={inputRef}
				type="file"
				multiple
				disabled={disabled}
				className="hidden"
				aria-label="Choose files to attach"
				onChange={(e) => {
					if (disabled) {
						e.target.value = "";
						return;
					}
					if (e.target.files && e.target.files.length > 0) onAddFiles(e.target.files);
					// Reset so picking the same file again still fires onChange.
					e.target.value = "";
				}}
			/>

			{attachments.length > 0 && (
				<div className="mt-2 flex min-w-0 flex-wrap gap-2" role="list" aria-label="Attachments">
					{attachments.map((a) => {
						const hasReference = Boolean(a.uploadId) !== Boolean(a.existing);
						const isError = a.status === "error" || a.status === "rejected";
						const hasIssue = isError || (a.status === "ready" && !hasReference);
						const isUploading = a.status === "uploading";
						const isInline = a.disposition === "inline";
						const isEmbedded =
							isInline && bodyReferencesInlineAttachment(bodyHtml, a.contentId);
						const inlineCopy = isInline
							? isEmbedded
								? "Embedded in message"
								: "Unused inline part"
							: null;
						const issueCopy = isError
							? a.error || (a.status === "rejected" ? "This file was rejected." : "Upload failed.")
							: !hasReference
								? "Attachment reference is missing. Retry the upload or remove this file."
								: null;
						return (
							<div
								key={a.localId}
								role="listitem"
								title={issueCopy || inlineCopy || a.filename}
								className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm ${
									hasIssue ? "border-red-300 bg-red-50" : "border-kumo-line"
								}`}
							>
								{isUploading ? (
									<CircleNotchIcon size={16} className="text-kumo-subtle shrink-0 animate-spin motion-reduce:animate-none" />
								) : hasIssue ? (
									<WarningCircleIcon size={16} className="text-red-500 shrink-0" />
								) : isInline ? (
									<ImageIcon size={16} className="text-kumo-subtle shrink-0" />
								) : (
									<FileIcon size={16} className="text-kumo-subtle shrink-0" />
								)}
								<span
									className={`font-medium truncate max-w-[160px] ${
										hasIssue ? "text-red-600" : "text-kumo-default"
									}`}
								>
									{a.filename}
								</span>
								<span
									role={hasIssue ? "alert" : undefined}
									className={hasIssue ? "min-w-[12rem] flex-1 break-words text-red-600" : "text-kumo-subtle"}
								>
									{hasIssue
										? issueCopy
										: isUploading
											? "Uploading…"
											: inlineCopy || formatBytes(a.size)}
								</span>
								{hasIssue && a.file && (
									<button
										type="button"
										onClick={() => onRetry(a.localId)}
										aria-label={`Retry ${a.filename}`}
										disabled={disabled}
										className="min-h-11 shrink-0 rounded px-2 font-semibold text-kumo-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50"
									>
										Retry
									</button>
								)}
								<button
									type="button"
									onClick={() => {
										if (
											isEmbedded &&
											!window.confirm(
												"This inline image is embedded in the message. Removing it will also remove the image from the message body. Remove it?",
											)
										) return;
										onRemove(a.localId);
									}}
									aria-label={`Remove ${a.filename}`}
									disabled={disabled}
									className="flex min-h-11 shrink-0 items-center gap-1 rounded px-2 text-kumo-subtle hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:cursor-not-allowed disabled:opacity-50"
								>
									<XIcon size={14} />
									<span>Remove</span>
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
