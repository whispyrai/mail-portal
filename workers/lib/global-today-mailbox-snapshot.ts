import { Folders } from "../../shared/folders.ts";
import {
	GLOBAL_TODAY_LIMITS,
	type GlobalTodayMailboxPulse,
} from "../../shared/global-today.ts";

type SqlValue = ArrayBuffer | string | number | null;

export type GlobalTodaySqlReader = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
};

const canonicalConversationSql = "COALESCE(NULLIF(TRIM(thread_id), ''), id)";
const inboxMessagesCte = `inbox_messages AS (
	SELECT
		${canonicalConversationSql} AS conversationKey,
		id,
		SUBSTR(COALESCE(date, ''), 1, 64) AS date,
		SUBSTR(TRIM(COALESCE(sender, '')), 1, ${GLOBAL_TODAY_LIMITS.addressChars}) AS sender,
		SUBSTR(TRIM(COALESCE(subject, '')), 1, ${GLOBAL_TODAY_LIMITS.subjectChars}) AS subject,
		ROW_NUMBER() OVER (
			PARTITION BY ${canonicalConversationSql}
			ORDER BY COALESCE(unixepoch(date), -1) DESC, id DESC
		) AS messageRank,
		SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) OVER (
			PARTITION BY ${canonicalConversationSql}
		) AS unreadMessageCount
	FROM emails
	WHERE folder_id = ?1
	  AND unixepoch(date) IS NOT NULL
	  AND LENGTH(id) BETWEEN 1 AND ${GLOBAL_TODAY_LIMITS.messageIdChars}
	  AND LENGTH(${canonicalConversationSql}) BETWEEN 1 AND ${GLOBAL_TODAY_LIMITS.conversationKeyChars}
)`;

export function readGlobalTodayMailboxSnapshot(
	sql: GlobalTodaySqlReader,
	mailboxAddress: string,
	baselineMessageIds: readonly string[],
): GlobalTodayMailboxPulse {
	const uniqueIds = [...new Set(baselineMessageIds)];
	if (
		mailboxAddress.length < 3 ||
		mailboxAddress.length > GLOBAL_TODAY_LIMITS.addressChars ||
		uniqueIds.length > GLOBAL_TODAY_LIMITS.reminders ||
		uniqueIds.some((id) => id.length < 1 || id.length > GLOBAL_TODAY_LIMITS.messageIdChars)
	) {
		throw new Error("Global Today Mailbox snapshot input is invalid");
	}

	const unreadRows = [...sql.exec<{
		conversationKey: string;
		messageId: string;
		date: string;
		sender: string;
		subject: string;
		total: number;
	}>(
		`WITH ${inboxMessagesCte}, unread_conversations AS (
			SELECT conversationKey, id, date, sender, subject
			FROM inbox_messages
			WHERE messageRank = 1 AND unreadMessageCount > 0
		), ranked AS (
			SELECT *, COUNT(*) OVER () AS total
			FROM unread_conversations
			ORDER BY COALESCE(unixepoch(date), -1) DESC, conversationKey ASC
		)
		SELECT conversationKey, id AS messageId, date, sender, subject, total
		FROM ranked
		LIMIT ${GLOBAL_TODAY_LIMITS.unreadPreviews}`,
		Folders.INBOX,
	)];
	const unreadConversationCount = unreadRows[0]?.total ?? Number(
		[...sql.exec<{ total: number }>(
			`WITH ${inboxMessagesCte}, unread_conversations AS (
				SELECT conversationKey
				FROM inbox_messages
				WHERE messageRank = 1 AND unreadMessageCount > 0
			)
			SELECT COUNT(*) AS total FROM unread_conversations`,
			Folders.INBOX,
		)][0]?.total ?? 0,
	);

	const reminderRows = uniqueIds.length === 0 ? [] : [...sql.exec<{
		baselineMessageId: string;
		subject: string;
		counterparty: string;
	}>(
		`WITH requested AS (
			SELECT CAST(value AS TEXT) AS id FROM json_each(?1)
		)
		SELECT
			e.id AS baselineMessageId,
			SUBSTR(TRIM(COALESCE(e.subject, '')), 1, ${GLOBAL_TODAY_LIMITS.subjectChars}) AS subject,
			SUBSTR(
				TRIM(CASE WHEN LOWER(COALESCE(e.sender, '')) = LOWER(?2)
					THEN COALESCE(e.recipient, '') ELSE COALESCE(e.sender, '') END),
				1,
				500
			) AS counterparty
		FROM requested
		INNER JOIN emails e ON e.id = requested.id
		WHERE e.folder_id IN (?3, ?4, ?5, ?6)
		ORDER BY e.id ASC
		LIMIT ${GLOBAL_TODAY_LIMITS.reminders}`,
		JSON.stringify(uniqueIds),
		mailboxAddress,
		Folders.INBOX,
		Folders.SENT,
		Folders.ARCHIVE,
		Folders.SNOOZED,
	)];

	return {
		unreadConversationCount: Math.max(0, Number(unreadConversationCount)),
		unreadPreviews: unreadRows.map((row) => ({
			messageId: row.messageId,
			conversationKey: row.conversationKey,
			sender: row.sender || "Unknown sender",
			subject: row.subject || "(No subject)",
			date: row.date,
		})),
		reminderPreviews: reminderRows.map((row) => ({
			baselineMessageId: row.baselineMessageId,
			subject: row.subject || "(No subject)",
			counterparty: row.counterparty || "Unknown correspondent",
		})),
	};
}
