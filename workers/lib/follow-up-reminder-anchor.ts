import { Folders } from "../../shared/folders.ts";

type SqlValue = ArrayBuffer | string | number | null;

export interface ReminderAnchorSqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

export interface StoredReminderAnchor {
	conversationKey: string;
	baselineMessageId: string;
	baselineMessageDate: string;
}

export function readStoredReminderAnchor(
	sql: ReminderAnchorSqlReader,
	emailId: string,
): StoredReminderAnchor | null {
	const selected = [...sql.exec<{ id: string; thread_id: string | null }>(
		`SELECT id, thread_id
		 FROM emails
		 WHERE id = ?1
		   AND folder_id IN (?2, ?3, ?4, ?5)
		 LIMIT 1`,
		emailId,
		Folders.INBOX,
		Folders.SENT,
		Folders.ARCHIVE,
		Folders.SNOOZED,
	)][0];
	if (!selected) return null;

	const conversationKey = selected.thread_id?.trim() || selected.id;
	const latest = [...sql.exec<{ id: string; date: string | null }>(
		`SELECT id, date
		 FROM emails
		 WHERE (thread_id = ?1 OR (?2 = ?1 AND id = ?2))
		   AND folder_id IN (?3, ?4, ?5, ?6)
		 ORDER BY datetime(date) DESC, id DESC
		 LIMIT 1`,
		conversationKey,
		selected.id,
		Folders.INBOX,
		Folders.SENT,
		Folders.ARCHIVE,
		Folders.SNOOZED,
	)][0];
	if (!latest?.date || !Number.isFinite(Date.parse(latest.date))) return null;
	return {
		conversationKey,
		baselineMessageId: latest.id,
		baselineMessageDate: new Date(latest.date).toISOString(),
	};
}
