import { isMailboxAttachmentPreviewable } from "../../../shared/mailbox-attachments.ts";

export type AttachmentPreviewType = "image" | "pdf";

export function previewTypeForAttachment(
	filename: string,
	mimetype: string,
): AttachmentPreviewType | null {
	if (!isMailboxAttachmentPreviewable(filename, mimetype)) return null;
	const normalizedMime = mimetype.split(";", 1)[0]!.trim().toLowerCase();
	return normalizedMime === "application/pdf" ? "pdf" : "image";
}

interface ObjectUrlApi {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
}

export interface ObjectUrlLease {
	url: string;
	revoke(): void;
}

export function createObjectUrlLease(
	blob: Blob,
	urlApi: ObjectUrlApi = URL,
): ObjectUrlLease {
	const url = urlApi.createObjectURL(blob);
	let revoked = false;
	return {
		url,
		revoke() {
			if (revoked) return;
			revoked = true;
			urlApi.revokeObjectURL(url);
		},
	};
}
