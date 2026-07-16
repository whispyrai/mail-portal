import { Folders } from "../../shared/folders.ts";
import type { OutboundDeliveryStatus } from "./outbound-delivery-contract.ts";

export function outboundDeliveryBlocksGenericLifecycle(
	status: OutboundDeliveryStatus,
): boolean {
	return status === "queued" ||
		status === "sending" ||
		status === "retrying" ||
		status === "cancelled";
}

export function planTrash(folderId: string) {
	return folderId === Folders.TRASH
		? ({ status: "already_trashed" as const })
		: ({ status: "trash" as const, previousFolderId: folderId });
}

export function resolveRestoreFolder(
	previousFolderId: string | null | undefined,
	previousFolderExists: boolean,
) {
	return previousFolderId &&
		previousFolderId !== Folders.TRASH &&
		previousFolderExists
		? previousFolderId
		: Folders.INBOX;
}

export function planMove(currentFolderId: string, targetFolderId: string) {
	if (targetFolderId === Folders.TRASH) {
		return { kind: "trash" as const };
	}
	return {
		kind: "move" as const,
		clearTrashMetadata: currentFolderId === Folders.TRASH,
	};
}
