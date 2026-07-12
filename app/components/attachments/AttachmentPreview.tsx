import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	DownloadSimpleIcon,
	FileIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { MailboxAttachmentItem } from "../../../shared/mailbox-attachments.ts";
import { formatBytes } from "~/lib/utils";
import { useMailboxAttachmentBytes } from "~/queries/attachments";
import { useAttachmentDownload } from "./attachment-download.ts";
import {
	createObjectUrlLease,
	previewTypeForAttachment,
} from "./attachment-preview.ts";

interface AttachmentPreviewProps {
	mailboxId: string;
	attachment: MailboxAttachmentItem;
	showBack: boolean;
	focusHeading: boolean;
	onBack: () => void;
}

export default function AttachmentPreview({
	mailboxId,
	attachment,
	showBack,
	focusHeading,
	onBack,
}: AttachmentPreviewProps) {
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [previewResource, setPreviewResource] = useState<{
		attachmentId: string;
		url: string;
	} | null>(null);
	const [decodeFailed, setDecodeFailed] = useState(false);
	const previewType = previewTypeForAttachment(
		attachment.filename,
		attachment.mimetype,
	);
	const bytes = useMailboxAttachmentBytes(
		mailboxId,
		attachment,
		previewType !== null,
	);
	const attachmentDownload = useAttachmentDownload(mailboxId);
	const messageUrl = `/mailbox/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(attachment.message.folderId)}?email=${encodeURIComponent(attachment.emailId)}`;

	useEffect(() => {
		if (focusHeading) headingRef.current?.focus();
	}, [attachment.id, focusHeading]);

	useEffect(() => {
		setDecodeFailed(false);
		if (!bytes.data) {
			setPreviewResource(null);
			return;
		}
		const lease = createObjectUrlLease(bytes.data);
		setPreviewResource({ attachmentId: attachment.id, url: lease.url });
		return () => lease.revoke();
	}, [bytes.data, attachment.id]);
	const objectUrl = previewResource?.attachmentId === attachment.id
		? previewResource.url
		: null;

	const retryPreview = () => {
		setDecodeFailed(false);
		void bytes.refetch();
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-kumo-base">
			<div className="shrink-0 border-b border-kumo-line px-4 py-3 sm:px-5">
				{showBack && (
					<button
						type="button"
						onClick={onBack}
						className="mb-2 inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
					>
						<ArrowLeftIcon size={18} aria-hidden="true" />
						Back to files
					</button>
				)}
				<div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0">
						<h2
							ref={headingRef}
							tabIndex={-1}
							className="truncate text-base font-semibold text-kumo-default focus:outline-none"
						>
							{attachment.filename}
						</h2>
						<p className="mt-1 text-sm text-kumo-subtle">
							<span className="capitalize">{attachment.kind}</span>
							<span aria-hidden="true"> · </span>
							{formatBytes(attachment.size)}
						</p>
					</div>
					<div className="flex shrink-0 flex-wrap gap-2">
						<button
							type="button"
							onClick={() => void attachmentDownload.download(attachment)}
							disabled={attachmentDownload.downloadingId === attachment.id}
							className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							<DownloadSimpleIcon size={17} aria-hidden="true" />
							{attachmentDownload.downloadingId === attachment.id ? "Downloading…" : "Download"}
						</button>
						<Link
							to={messageUrl}
							className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-kumo-brand px-3 text-sm font-medium text-kumo-inverse hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							<ArrowSquareOutIcon size={17} aria-hidden="true" />
							Open message
						</Link>
					</div>
				</div>
				{attachmentDownload.error && (
					<div className="mt-3 flex items-center justify-between gap-3 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">
						<span>{attachmentDownload.error}</span>
						<button type="button" onClick={attachmentDownload.clearError} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Dismiss</button>
					</div>
				)}
				<div className="mt-3 rounded-md bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
					<p className="truncate font-medium text-kumo-default">
						{attachment.message.subject || "(No subject)"}
					</p>
					<p className="mt-0.5 truncate">
						{attachment.message.sender} · {attachment.message.folderName}
					</p>
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-auto bg-kumo-recessed p-4 sm:p-6">
				{previewType === null ? (
					<div className="grid min-h-full place-items-center">
						<div className="max-w-sm rounded-xl border border-kumo-line bg-kumo-base p-7 text-center shadow-sm">
							<FileIcon size={36} className="mx-auto text-kumo-subtle" aria-hidden="true" />
							<h3 className="mt-4 font-semibold text-kumo-default">Download only</h3>
							<p className="mt-2 text-sm leading-6 text-kumo-subtle">
								This format is not opened in the browser. Download it to inspect it safely.
							</p>
							<button
								type="button"
								onClick={() => void attachmentDownload.download(attachment)}
								disabled={attachmentDownload.downloadingId === attachment.id}
								className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
							>
								<DownloadSimpleIcon size={17} aria-hidden="true" />
								{attachmentDownload.downloadingId === attachment.id ? "Downloading…" : "Download file"}
							</button>
						</div>
					</div>
				) : bytes.isError || decodeFailed ? (
					<div className="grid min-h-full place-items-center" role="alert">
						<div className="max-w-sm rounded-xl border border-kumo-line bg-kumo-base p-7 text-center shadow-sm">
							<WarningCircleIcon size={36} className="mx-auto text-kumo-danger" aria-hidden="true" />
							<h3 className="mt-4 font-semibold text-kumo-default">Preview unavailable</h3>
							<p className="mt-2 text-sm leading-6 text-kumo-subtle">
								The file may be missing or could not be decoded. You can retry or download the original.
							</p>
							<div className="mt-5 flex flex-wrap justify-center gap-2">
								<button type="button" onClick={retryPreview} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
									Retry preview
								</button>
								<button type="button" onClick={() => void attachmentDownload.download(attachment)} disabled={attachmentDownload.downloadingId === attachment.id} className="inline-flex min-h-11 items-center rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
									{attachmentDownload.downloadingId === attachment.id ? "Downloading…" : "Download"}
								</button>
							</div>
						</div>
					</div>
				) : bytes.isPending || !objectUrl ? (
					<div className="grid min-h-full place-items-center" role="status" aria-live="polite">
						<div className="text-center text-sm text-kumo-subtle">
							<div className="mx-auto mb-3 size-7 animate-spin rounded-full border-2 border-kumo-line border-t-kumo-brand motion-reduce:animate-none" aria-hidden="true" />
							Loading secure preview…
						</div>
					</div>
				) : previewType === "image" ? (
					<div className="flex min-h-full items-center justify-center">
						<img
							src={objectUrl}
							alt={`Preview of ${attachment.filename}`}
							onError={() => setDecodeFailed(true)}
							className="max-h-full max-w-full rounded-lg bg-kumo-base object-contain shadow-sm"
						/>
					</div>
				) : (
					<iframe
						src={objectUrl}
						title={`Preview of ${attachment.filename}`}
						sandbox="allow-scripts"
						referrerPolicy="no-referrer"
						className="h-full min-h-[520px] w-full rounded-lg border border-kumo-line bg-kumo-base shadow-sm"
					/>
				)}
			</div>
		</div>
	);
}
