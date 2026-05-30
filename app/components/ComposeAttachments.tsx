// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
	PaperclipIcon,
	FileIcon,
	XIcon,
	CircleNotchIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useRef } from "react";
import { formatBytes } from "~/lib/utils";
import type { ComposeAttachment } from "~/hooks/useAttachments";

interface ComposeAttachmentsProps {
	attachments: ComposeAttachment[];
	onAddFiles: (files: FileList) => void;
	onRemove: (localId: string) => void;
	disabled?: boolean;
}

/**
 * The composer's attach control: a paperclip trigger plus a chip row that
 * mirrors the read-only EmailAttachmentList styling, with per-file upload
 * spinner, error state, and a remove button.
 */
export default function ComposeAttachments({
	attachments,
	onAddFiles,
	onRemove,
	disabled = false,
}: ComposeAttachmentsProps) {
	const inputRef = useRef<HTMLInputElement>(null);

	return (
		<div>
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				disabled={disabled}
				className="flex items-center gap-1.5 text-sm text-kumo-link hover:text-kumo-link-hover font-medium disabled:opacity-50 disabled:cursor-not-allowed"
			>
				<PaperclipIcon size={15} />
				Attach files
			</button>
			<input
				ref={inputRef}
				type="file"
				multiple
				className="hidden"
				onChange={(e) => {
					if (e.target.files && e.target.files.length > 0) onAddFiles(e.target.files);
					// Reset so picking the same file again still fires onChange.
					e.target.value = "";
				}}
			/>

			{attachments.length > 0 && (
				<div className="mt-2 flex flex-wrap gap-2">
					{attachments.map((a) => {
						const isError = a.status === "error";
						const isUploading = a.status === "uploading";
						return (
							<div
								key={a.localId}
								title={a.error || a.filename}
								className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
									isError ? "border-red-300 bg-red-50" : "border-kumo-line"
								}`}
							>
								{isUploading ? (
									<CircleNotchIcon size={16} className="text-kumo-subtle shrink-0 animate-spin" />
								) : isError ? (
									<WarningCircleIcon size={16} className="text-red-500 shrink-0" />
								) : (
									<FileIcon size={16} className="text-kumo-subtle shrink-0" />
								)}
								<span
									className={`font-medium truncate max-w-[160px] ${
										isError ? "text-red-600" : "text-kumo-default"
									}`}
								>
									{a.filename}
								</span>
								<span className={isError ? "text-red-500 truncate max-w-[180px]" : "text-kumo-subtle"}>
									{isError ? a.error || "Failed" : isUploading ? "Uploading…" : formatBytes(a.size)}
								</span>
								<button
									type="button"
									onClick={() => onRemove(a.localId)}
									aria-label={`Remove ${a.filename}`}
									className="shrink-0 text-kumo-subtle hover:text-kumo-default"
								>
									<XIcon size={14} />
								</button>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
