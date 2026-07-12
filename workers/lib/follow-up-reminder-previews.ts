import type { FollowUpReminderPreview } from "../../shared/follow-up-reminders.ts";
import { Folders } from "../../shared/folders.ts";

type SqlValue = ArrayBuffer | string | number | null;

export type FollowUpReminderPreviewRecord = FollowUpReminderPreview & {
	baselineMessageId: string;
};

export type ReminderPreviewSqlReader = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
};

const MAX_PREVIEW_BATCH = 100;
const MAX_MESSAGE_ID_LENGTH = 300;

/**
 * Project only display context for eligible baseline mail. Message bodies,
 * attachments, Drafts, Outbox rows, and persistence-only mail never cross RPC.
 */
export function readFollowUpReminderPreviews(
	sql: ReminderPreviewSqlReader,
	mailboxAddress: string,
	baselineMessageIds: readonly string[],
): FollowUpReminderPreviewRecord[] {
	const uniqueIds = [...new Set(baselineMessageIds)];
	if (
		mailboxAddress.length < 3 ||
		mailboxAddress.length > 320 ||
		uniqueIds.length > MAX_PREVIEW_BATCH ||
		uniqueIds.some((id) => id.length < 1 || id.length > MAX_MESSAGE_ID_LENGTH)
	) {
		throw new Error("Reminder preview batch is invalid");
	}
	if (uniqueIds.length === 0) return [];

	const placeholders = uniqueIds.map(() => "?").join(", ");
	const rows = [...sql.exec<{
		id: string;
		subject: string;
		counterparty: string;
	}>(
		`SELECT id,
		        substr(trim(COALESCE(subject, '')), 1, 300) AS subject,
		        substr(
		          trim(CASE WHEN lower(COALESCE(sender, '')) = lower(?)
		                    THEN COALESCE(recipient, '')
		                    ELSE COALESCE(sender, '') END),
		          1,
		          500
		        ) AS counterparty
		 FROM emails
		 WHERE id IN (${placeholders})
		   AND folder_id IN (?, ?, ?, ?)
		 LIMIT 100`,
		mailboxAddress,
		...uniqueIds,
		Folders.INBOX,
		Folders.SENT,
		Folders.ARCHIVE,
		Folders.SNOOZED,
	)];

	return rows.map((row) => ({
		baselineMessageId: row.id,
		subject: row.subject.trim() || "(No subject)",
		counterparty: row.counterparty.trim() || "Unknown correspondent",
	}));
}
