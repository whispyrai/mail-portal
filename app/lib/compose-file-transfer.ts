import type { InlineImageInsertion } from "./compose-inline-images.ts";

interface FileTransferData {
	files?: ArrayLike<File> | null;
	types?: ArrayLike<string> | null;
}

interface ComposeFileTransferEvent {
	clipboardData?: FileTransferData | null;
	dataTransfer?: FileTransferData | null;
	preventDefault(): void;
	stopPropagation(): void;
}

export function transferContainsFiles(
	transfer: FileTransferData | null | undefined,
): boolean {
	if (!transfer) return false;
	if (Array.from(transfer.files ?? []).length > 0) return true;
	return Array.from(transfer.types ?? []).some(
		(type) => type.toLowerCase() === "files",
	);
}

/** Consume only actual file payloads. Text and HTML paste stays browser-native. */
export function consumeComposeFileTransfer(
	event: ComposeFileTransferEvent,
	onFiles: (files: File[]) => void,
): boolean {
	const transfer = event.clipboardData ?? event.dataTransfer;
	const files = Array.from(transfer?.files ?? []);
	if (files.length === 0) return false;
	event.preventDefault();
	event.stopPropagation();
	onFiles(files);
	return true;
}

export function consumeComposeEditorFileTransfer(
	event: ComposeFileTransferEvent,
	handlers: {
		addInlineImages(files: File[]): InlineImageInsertion[];
	},
): { consumed: boolean; inlineInsertions: InlineImageInsertion[] } {
	const transfer = event.clipboardData ?? event.dataTransfer;
	const files = Array.from(transfer?.files ?? []);
	if (files.length === 0) return { consumed: false, inlineInsertions: [] };

	event.preventDefault();
	event.stopPropagation();
	// MIME classification happens inside the attachment hook so mixed transfers
	// retain their exact input order for deterministic same-tick admission.
	const inlineInsertions = handlers.addInlineImages(files);
	return { consumed: true, inlineInsertions };
}
