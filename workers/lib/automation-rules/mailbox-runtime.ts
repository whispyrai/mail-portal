import { Folders, InternalFolders } from "../../../shared/folders.ts";
import type {
	AutomationMessageSnapshot,
} from "../../../shared/automation-rules.ts";
import type {
	AutomationActionPlan,
	AutomationPlanningContext,
	AutomationRunClaim,
	AutomationRulesSql,
} from "./index.ts";

export const AUTOMATION_MAILBOX_RUNTIME_LIMITS = {
	conversationMessages: 200,
	dryRunMessages: 100,
	messageSqlBatch: 90,
} as const;

type MessageRow = {
	id: string;
	folderId: string;
	threadId: string | null;
	sender: string | null;
	subject: string | null;
	date: string | null;
	starred: number | null;
};

type AutomationActivityInput = {
	actor: { kind: "rule"; id: string };
	action: "email_updated" | "label_applied" | "email_moved";
	entityType: "email" | "conversation";
	entityId: string;
	metadata: Record<string, unknown>;
};

export type AutomationActivityRecorder = (input: AutomationActivityInput) => void;

function first<T extends Record<string, ArrayBuffer | string | number | null>>(
	sql: AutomationRulesSql,
	query: string,
	...bindings: (ArrayBuffer | string | number | null)[]
): T | null {
	return [...sql.exec<T>(query, ...bindings)][0] ?? null;
}

function messageRow(sql: AutomationRulesSql, messageId: string): MessageRow | null {
	return first<MessageRow>(sql,
		`SELECT id, folder_id AS folderId, thread_id AS threadId, sender, subject, date, starred
		 FROM emails WHERE id = ? AND folder_id <> ? LIMIT 1`,
		messageId,
		InternalFolders.RETIRED_OUTBOUND,
	);
}

function snapshotForMessage(
	sql: AutomationRulesSql,
	message: MessageRow,
): AutomationMessageSnapshot {
	const conversationId = message.threadId ?? message.id;
	const attachments = [...sql.exec<{
		filename: string;
		disposition: string | null;
	}>(
		`SELECT filename, disposition FROM attachments
		 WHERE email_id = ? ORDER BY id ASC`,
		message.id,
	)].map((attachment) => ({
		filename: attachment.filename,
		disposition: attachment.disposition === "inline"
			? ("inline" as const)
			: ("attachment" as const),
	}));
	return {
		messageId: message.id,
		conversationId,
		folderId: message.folderId,
		senderAddress: message.sender ?? "",
		subject: message.subject ?? "",
		date: message.date ?? "",
		attachments,
	};
}

function currentInboxScope(
	sql: AutomationRulesSql,
	message: MessageRow,
	conversationId: string,
): AutomationPlanningContext["currentInboxScope"] {
	if (message.folderId !== Folders.INBOX) return null;
	const rows = [...sql.exec<{ id: string }>(
		`SELECT id FROM emails
		 WHERE folder_id = ? AND COALESCE(thread_id, id) = ?
		 ORDER BY date ASC, id ASC LIMIT ?`,
		Folders.INBOX,
		conversationId,
		AUTOMATION_MAILBOX_RUNTIME_LIMITS.conversationMessages + 1,
	)];
	if (
		rows.length === 0 ||
		rows.length > AUTOMATION_MAILBOX_RUNTIME_LIMITS.conversationMessages ||
		!rows.some((row) => row.id === message.id)
	) return null;
	const ids = rows.map((row) => row.id);
	let fullySatisfiedLabels: Set<string> | null = null;
	for (const chunk of chunks(ids, AUTOMATION_MAILBOX_RUNTIME_LIMITS.messageSqlBatch)) {
		const chunkLabels = new Set([...sql.exec<{ labelId: string }>(
			`SELECT label_id AS labelId FROM email_labels
			 WHERE email_id IN (${placeholders(chunk)})
			 GROUP BY label_id HAVING COUNT(DISTINCT email_id) = ?
			 ORDER BY label_id ASC`,
			...chunk,
			chunk.length,
		)].map((row) => row.labelId));
		if (fullySatisfiedLabels === null) {
			fullySatisfiedLabels = chunkLabels;
		} else {
			const previous: Set<string> = fullySatisfiedLabels;
			fullySatisfiedLabels = new Set(
				Array.from(previous).filter((labelId: string) => chunkLabels.has(labelId)),
			);
		}
	}
	return {
		conversationMessageIds: ids,
		existingLabelIds: [...(fullySatisfiedLabels ?? [])].sort(),
		triggerIsStarred: message.starred === 1,
	};
}

export function readAutomationPlanningContext(
	sql: AutomationRulesSql,
	messageId: string,
): AutomationPlanningContext | null {
	const message = messageRow(sql, messageId);
	if (!message) return null;
	const snapshot = snapshotForMessage(sql, message);
	const availableLabelIds = [...sql.exec<{ id: string }>(
		"SELECT id FROM labels ORDER BY id ASC",
	)].map((row) => row.id);
	const availableMoveFolderIds = [...sql.exec<{ id: string }>(
		`SELECT id FROM folders
		 WHERE id = ? OR (is_deletable = 1 AND id <> ?)
		 ORDER BY id ASC`,
		Folders.ARCHIVE,
		InternalFolders.RETIRED_OUTBOUND,
	)].map((row) => row.id);
	return {
		snapshot,
		currentInboxScope: currentInboxScope(sql, message, snapshot.conversationId),
		availableLabelIds,
		availableMoveFolderIds,
	};
}

export function readAutomationDryRunContexts(
	sql: AutomationRulesSql,
	now: number,
): AutomationPlanningContext[] {
	const cutoff = new Date(now - 30 * 24 * 60 * 60_000).toISOString();
	const ids = [...sql.exec<{ id: string }>(
		`SELECT id FROM emails
		 WHERE recipient_memory_origin = 'live_inbound'
		   AND folder_id <> ? AND date >= ? AND date <= ?
		 ORDER BY date DESC, id DESC LIMIT ?`,
		InternalFolders.RETIRED_OUTBOUND,
		cutoff,
		new Date(now).toISOString(),
		AUTOMATION_MAILBOX_RUNTIME_LIMITS.dryRunMessages,
	)].map((row) => row.id);
	return ids.flatMap((id) => {
		const context = readAutomationPlanningContext(sql, id);
		return context ? [context] : [];
	});
}

function placeholders(values: readonly string[]): string {
	return values.map(() => "?").join(", ");
}

function chunks<T>(values: readonly T[], size: number): T[][] {
	const result: T[][] = [];
	for (let start = 0; start < values.length; start += size) {
		result.push(values.slice(start, start + size));
	}
	return result;
}

export function applyAutomationActionPlan(
	sql: AutomationRulesSql,
	claim: AutomationRunClaim,
	context: AutomationPlanningContext,
	plan: AutomationActionPlan,
	recordActivity: AutomationActivityRecorder,
): void {
	const scope = context.currentInboxScope;
	if (!scope) return;
	const messageIds = scope.conversationMessageIds;
	const messageBatches = chunks(messageIds, AUTOMATION_MAILBOX_RUNTIME_LIMITS.messageSqlBatch);
	const occurredAt = new Date().toISOString();

	for (const item of plan.applyLabels) {
		let insertedCount = 0;
		for (const batch of messageBatches) {
			insertedCount += [...sql.exec<{ emailId: string }>(
				`INSERT OR IGNORE INTO email_labels(email_id, label_id, created_at)
				 SELECT id, ?, ? FROM emails
				 WHERE id IN (${placeholders(batch)}) AND folder_id = ?
				 RETURNING email_id AS emailId`,
				item.labelId,
				occurredAt,
				...batch,
				Folders.INBOX,
			)].length;
		}
		if (insertedCount > 0) {
			recordActivity({
				actor: { kind: "rule", id: item.ruleId },
				action: "label_applied",
				entityType: "conversation",
				entityId: context.snapshot.conversationId,
				metadata: {
					labelId: item.labelId,
					affectedCount: insertedCount,
					automationRunId: claim.id,
					ruleVersion: item.ruleVersion,
				},
			});
		}
	}

	if (plan.star) {
		const updated = [...sql.exec<{ id: string }>(
			"UPDATE emails SET starred = 1 WHERE id = ? AND COALESCE(starred, 0) <> 1 RETURNING id",
			context.snapshot.messageId,
		)];
		if (updated.length > 0) {
			recordActivity({
				actor: { kind: "rule", id: plan.star.ruleId },
				action: "email_updated",
				entityType: "email",
				entityId: context.snapshot.messageId,
				metadata: {
					starred: true,
					automationRunId: claim.id,
					ruleVersion: plan.star.ruleVersion,
				},
			});
		}
	}

	if (plan.move) {
		let movedCount = 0;
		for (const batch of messageBatches) {
			movedCount += [...sql.exec<{ id: string }>(
				`UPDATE emails SET folder_id = ?, previous_folder_id = NULL, trashed_at = NULL
				 WHERE id IN (${placeholders(batch)}) AND folder_id = ? RETURNING id`,
				plan.move.folderId,
				...batch,
				Folders.INBOX,
			)].length;
		}
		if (movedCount > 0) {
			recordActivity({
				actor: { kind: "rule", id: plan.move.ruleId },
				action: "email_moved",
				entityType: "conversation",
				entityId: context.snapshot.conversationId,
				metadata: {
					fromFolderId: Folders.INBOX,
					toFolderId: plan.move.folderId,
					affectedCount: movedCount,
					automationRunId: claim.id,
					ruleVersion: plan.move.ruleVersion,
				},
			});
		}
	}
}
