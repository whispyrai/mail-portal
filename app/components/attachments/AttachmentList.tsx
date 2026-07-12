import {
	ArrowSquareOutIcon,
	DownloadSimpleIcon,
	FileIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router";
import type { MailboxAttachmentItem } from "../../../shared/mailbox-attachments.ts";
import { formatBytes, formatListDate } from "~/lib/utils";
import { useAttachmentDownload } from "./attachment-download.ts";

interface AttachmentListProps {
	mailboxId: string;
	items: MailboxAttachmentItem[];
	selectedId: string | null;
	onSelect: (attachmentId: string) => void;
}

export default function AttachmentList({
	mailboxId,
	items,
	selectedId,
	onSelect,
}: AttachmentListProps) {
	const attachmentDownload = useAttachmentDownload(mailboxId);
	return (
		<div>
			{attachmentDownload.error && (
				<div className="flex items-center justify-between gap-3 border-b border-kumo-line bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-danger" role="alert">
					<span>{attachmentDownload.error}</span>
					<button type="button" onClick={attachmentDownload.clearError} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Dismiss</button>
				</div>
			)}
			<div className="divide-y divide-kumo-line" role="list" aria-label="Mailbox files">
			{items.map((attachment) => {
				const selected = attachment.id === selectedId;
				const messageUrl = `/mailbox/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(attachment.message.folderId)}?email=${encodeURIComponent(attachment.emailId)}`;
				return (
					<div
						key={attachment.id}
						role="listitem"
						className={`group flex items-stretch gap-1 px-2 py-1.5 ${selected ? "bg-kumo-tint" : "hover:bg-kumo-recessed"}`}
					>
						<button
							id={`attachment-row-${attachment.id}`}
							type="button"
							onClick={() => onSelect(attachment.id)}
							aria-current={selected ? "true" : undefined}
							className="flex min-h-11 min-w-0 flex-1 items-start gap-3 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							<span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-kumo-fill text-kumo-subtle" aria-hidden="true">
								<FileIcon size={19} />
							</span>
							<span className="min-w-0 flex-1">
								<span className="flex min-w-0 items-baseline gap-2">
									<span className="truncate text-sm font-semibold text-kumo-default">{attachment.filename}</span>
									<span className="ml-auto shrink-0 text-xs text-kumo-subtle">{formatBytes(attachment.size)}</span>
								</span>
								<span className="mt-0.5 block truncate text-sm text-kumo-strong">
									{attachment.message.subject || "(No subject)"}
								</span>
								<span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-kumo-subtle">
									<span className="truncate">{attachment.message.sender}</span>
									<span aria-hidden="true">·</span>
									<span className="max-w-24 truncate">{attachment.message.folderName}</span>
									<span aria-hidden="true">·</span>
									<span className="shrink-0">{formatListDate(attachment.message.date)}</span>
								</span>
							</span>
						</button>
						<button
							type="button"
							onClick={() => void attachmentDownload.download(attachment)}
							disabled={attachmentDownload.downloadingId === attachment.id}
							aria-label={`Download ${attachment.filename}`}
							title="Download"
							className="grid min-h-11 min-w-11 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							<DownloadSimpleIcon size={17} aria-hidden="true" />
						</button>
						<Link
							to={messageUrl}
							aria-label={`Open message for ${attachment.filename}`}
							title="Open message"
							className="grid min-h-11 min-w-11 place-items-center rounded-md text-kumo-subtle hover:bg-kumo-fill hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							<ArrowSquareOutIcon size={17} aria-hidden="true" />
						</Link>
					</div>
				);
			})}
			</div>
		</div>
	);
}
