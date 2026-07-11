import { Folders } from "./folders.ts";

export const MAX_BATCH_TRIAGE_TARGETS = 50;

export type BatchTriageAction =
	| "mark_read"
	| "mark_unread"
	| "archive"
	| "trash";

export type BatchTriageTarget = {
	emailId: string;
	folderId: string;
	conversationId?: string;
};

export type BatchTriageCommand = {
	action: BatchTriageAction;
	targets: BatchTriageTarget[];
};

export type BatchTriageTargetStatus =
	| "updated"
	| "not_found"
	| "invalid_action"
	| "outbound_delivery_active";

export type BatchTriageResult = {
	requestedCount: number;
	succeededCount: number;
	failedCount: number;
	results: Array<{
		emailId: string;
		status: BatchTriageTargetStatus;
		affectedCount: number;
	}>;
};

export function isBatchTriageActionAllowed(
	action: BatchTriageAction,
	folderId: string,
): boolean {
	if (
		folderId === Folders.OUTBOX ||
		folderId === Folders.DRAFT
	) return false;
	if (action === "mark_read" || action === "mark_unread") {
		return folderId !== Folders.SENT;
	}
	if (action === "archive") {
		return !new Set<string>([
			Folders.SENT,
			Folders.TRASH,
			Folders.ARCHIVE,
			Folders.SNOOZED,
		]).has(folderId);
	}
	return folderId !== Folders.TRASH && folderId !== Folders.SNOOZED;
}
