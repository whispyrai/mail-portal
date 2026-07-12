import type { Email } from "../types/index.ts";
import type {
	BatchTriageAction,
	BatchTriageCommand,
	BatchTriageResult,
} from "../../shared/batch-triage.ts";
import type { InboxTriageSuggestion } from "../services/inbox-triage-suggestions.ts";

export type InboxTriageVisibleSnapshot = {
	mailboxId: string;
	folderId: string;
	page: number;
	labelId: string | null;
	rows: Array<{
		id: string;
		conversationId: string | null;
		folderId: string | null;
		subject: string;
		sender: string;
		participants: string;
		date: string;
		read: boolean;
		starred: boolean;
		threadCount: number;
		threadUnreadCount: number;
		hasDraft: boolean;
	}>;
};

export function createInboxTriageVisibleSnapshot(input: {
	mailboxId: string;
	folderId: string;
	page: number;
	labelId: string | null;
	emails: readonly Email[];
}): InboxTriageVisibleSnapshot {
	return {
		mailboxId: input.mailboxId,
		folderId: input.folderId,
		page: input.page,
		labelId: input.labelId,
		rows: input.emails.map((email) => ({
			id: email.id,
			conversationId: email.conversation_id ?? email.thread_id ?? null,
			folderId: email.folder_id ?? null,
			subject: email.subject,
			sender: email.sender,
			participants: email.participants ?? "",
			date: email.date,
			read: email.read,
			starred: email.starred,
			threadCount: email.thread_count ?? 1,
			threadUnreadCount: email.thread_unread_count ?? (email.read ? 0 : 1),
			hasDraft: email.has_draft ?? false,
		})),
	};
}

export function inboxTriageSnapshotKey(
	snapshot: InboxTriageVisibleSnapshot,
): string {
	return JSON.stringify(snapshot);
}

export function inboxTriageSnapshotsEqual(
	left: InboxTriageVisibleSnapshot,
	right: InboxTriageVisibleSnapshot,
): boolean {
	return inboxTriageSnapshotKey(left) === inboxTriageSnapshotKey(right);
}

export function planInboxTriageApply(input: {
	action: Extract<BatchTriageAction, "archive" | "mark_read">;
	suggestions: readonly InboxTriageSuggestion[];
	selectedSuggestionIds: ReadonlySet<string>;
	responseSnapshot: InboxTriageVisibleSnapshot;
	currentSnapshot: InboxTriageVisibleSnapshot;
}):
	| { state: "stale" }
	| { state: "empty" }
	| { state: "ready"; command: BatchTriageCommand } {
	if (!inboxTriageSnapshotsEqual(input.responseSnapshot, input.currentSnapshot)) {
		return { state: "stale" };
	}
	const currentRows = new Map(
		input.currentSnapshot.rows.map((row) => [row.id, row]),
	);
	const selected = input.suggestions.filter(
		(suggestion) =>
			suggestion.action === input.action &&
			input.selectedSuggestionIds.has(suggestion.candidateId),
	);
	if (selected.length === 0) return { state: "empty" };
	const targets = selected.flatMap((suggestion) => {
		const row = currentRows.get(suggestion.emailId);
		if (!row?.conversationId) return [];
		return [
			{
				emailId: row.id,
				folderId: input.currentSnapshot.folderId,
				conversationId: row.conversationId,
			},
		];
	});
	if (targets.length !== selected.length) return { state: "stale" };
	return {
		state: "ready",
		command: { action: input.action, targets },
	};
}

export function createInboxTriageReviewSelection(
	suggestions: readonly InboxTriageSuggestion[],
): Set<string> {
	return new Set(suggestions.map((suggestion) => suggestion.candidateId));
}

export function toggleInboxTriageReviewSelection(
	selected: ReadonlySet<string>,
	candidateId: string,
): Set<string> {
	const next = new Set(selected);
	if (next.has(candidateId)) next.delete(candidateId);
	else next.add(candidateId);
	return next;
}

export function reconcileInboxTriageApplyResult(input: {
	action: "archive" | "mark_read";
	suggestions: readonly InboxTriageSuggestion[];
	selectedSuggestionIds: ReadonlySet<string>;
	result: BatchTriageResult;
}): {
	suggestions: InboxTriageSuggestion[];
	selectedSuggestionIds: Set<string>;
	failedSuggestionIds: Set<string>;
} {
	const statusByEmailId = new Map(
		input.result.results.map((result) => [result.emailId, result.status]),
	);
	const succeededSuggestionIds = new Set(
		input.suggestions
			.filter(
				(suggestion) =>
					suggestion.action === input.action &&
					input.selectedSuggestionIds.has(suggestion.candidateId) &&
					statusByEmailId.get(suggestion.emailId) === "updated",
			)
			.map((suggestion) => suggestion.candidateId),
	);
	const failedSuggestionIds = new Set(
		input.suggestions
			.filter(
				(suggestion) =>
					suggestion.action === input.action &&
					input.selectedSuggestionIds.has(suggestion.candidateId) &&
					statusByEmailId.get(suggestion.emailId) !== "updated",
			)
			.map((suggestion) => suggestion.candidateId),
	);
	return {
		suggestions: input.suggestions.filter(
			(suggestion) => !succeededSuggestionIds.has(suggestion.candidateId),
		),
		selectedSuggestionIds: new Set(
			[...input.selectedSuggestionIds].filter(
				(candidateId) => !succeededSuggestionIds.has(candidateId),
			),
		),
		failedSuggestionIds,
	};
}

export type ActiveInboxTriageRequest = {
	requestToken: number;
	controller: AbortController;
	snapshotIdentity: string;
};

export function createInboxTriageRequestController() {
	let nextRequestToken = 0;
	let active: ActiveInboxTriageRequest | null = null;
	return {
		begin(snapshot: InboxTriageVisibleSnapshot): ActiveInboxTriageRequest | null {
			if (active) return null;
			active = {
				requestToken: ++nextRequestToken,
				controller: new AbortController(),
				snapshotIdentity: inboxTriageSnapshotKey(snapshot),
			};
			return active;
		},
		isCurrent(
			request: ActiveInboxTriageRequest,
			snapshot: InboxTriageVisibleSnapshot,
		): boolean {
			return active?.requestToken === request.requestToken &&
				!request.controller.signal.aborted &&
				request.snapshotIdentity === inboxTriageSnapshotKey(snapshot);
		},
		finish(request: ActiveInboxTriageRequest): boolean {
			if (active?.requestToken !== request.requestToken) return false;
			active = null;
			return true;
		},
		cancel(): void {
			active?.controller.abort();
			active = null;
		},
	};
}
