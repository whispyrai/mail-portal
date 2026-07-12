import { useEffect, useRef, useState } from "react";
import type { MailboxAttachmentItem } from "../../../shared/mailbox-attachments.ts";
import api, { ApiError } from "../../services/api.ts";
import { createObjectUrlLease } from "./attachment-preview.ts";

interface DownloadEnvironment {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
	click(url: string, filename: string): void;
	waitForNavigation?(): Promise<void>;
}

const browserDownloadEnvironment: DownloadEnvironment = {
	createObjectURL: (blob) => URL.createObjectURL(blob),
	revokeObjectURL: (url) => URL.revokeObjectURL(url),
	click: (url, filename) => {
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = filename;
		anchor.hidden = true;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	},
	waitForNavigation: () => new Promise((resolve) => setTimeout(resolve, 0)),
};

export async function saveBlobAsDownload(
	blob: Blob,
	filename: string,
	environment: DownloadEnvironment = browserDownloadEnvironment,
): Promise<void> {
	const downloadBlob = new Blob([blob], { type: "application/octet-stream" });
	const lease = createObjectUrlLease(downloadBlob, environment);
	try {
		environment.click(lease.url, filename);
		await (environment.waitForNavigation?.() ?? new Promise((resolve) => setTimeout(resolve, 0)));
	} finally {
		lease.revoke();
	}
}

export function useAttachmentDownload(mailboxId: string) {
	const controllerRef = useRef<AbortController | null>(null);
	const [downloadingId, setDownloadingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => () => {
		const controller = controllerRef.current;
		controllerRef.current = null;
		controller?.abort();
	}, []);

	const download = async (attachment: MailboxAttachmentItem) => {
		controllerRef.current?.abort();
		const controller = new AbortController();
		controllerRef.current = controller;
		setDownloadingId(attachment.id);
		setError(null);
		try {
			const blob = await api.getAttachment(
				mailboxId,
				attachment.emailId,
				attachment.id,
				{ signal: controller.signal },
			);
			await saveBlobAsDownload(blob, attachment.filename);
		} catch (caught) {
			if (controller.signal.aborted) return;
			setError(
				caught instanceof ApiError && caught.status === 404
					? "This file is missing and could not be downloaded."
					: "The download could not be completed. Try again.",
			);
		} finally {
			if (controllerRef.current === controller) {
				controllerRef.current = null;
				setDownloadingId(null);
			}
		}
	};

	return {
		download,
		downloadingId,
		error,
		clearError: () => setError(null),
	};
}
