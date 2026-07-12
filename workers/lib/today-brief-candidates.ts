import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
	TODAY_BRIEF_ELIGIBLE_FOLDERS,
	TODAY_BRIEF_LIMITS,
	type TodayBriefCandidateInput,
	type TodayBriefCandidateReason,
	type TodayBriefEligibleFolder,
} from "../../shared/today-brief.ts";
import { stripHtmlToText } from "./email-helpers.ts";

type SqlValue = ArrayBuffer | string | number | null;

export const TODAY_BRIEF_CANDIDATE_LIMITS = {
	candidates: TODAY_BRIEF_LIMITS.candidates,
	messagesPerCandidate: TODAY_BRIEF_LIMITS.messagesPerCandidate,
	bodyChars: TODAY_BRIEF_LIMITS.messageTextChars,
	reminderInputs: 100,
	conversationKeyChars: TODAY_BRIEF_LIMITS.conversationKeyChars,
	messageIdChars: TODAY_BRIEF_LIMITS.idChars,
	addressChars: TODAY_BRIEF_LIMITS.senderChars,
	subjectChars: TODAY_BRIEF_LIMITS.subjectChars,
	dateChars: 64,
	/** A bounded raw window is reduced to the smaller plain-text limit before return. */
	rawBodyChars: 12_000,
} as const;

export type TodayBriefSqlReader = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
};

type ProjectedEvidenceMessage = {
	id: string;
	folderId: TodayBriefEligibleFolder;
	sender: string;
	recipient: string;
	date: string;
	subject: string;
	text: string;
};

export type TodayBriefCandidateProjection = {
	candidates: TodayBriefCandidateInput[];
	omittedCount: number;
	counts: {
		privateRemindersDue: number;
		unreadConversations: number;
	};
};

type ReminderReason = {
	id: string;
	version: number;
	state: "active";
	remindAt: string;
	due: "overdue" | "today";
	baselineMessageId: string;
	baselineMessageDate: string;
	updatedAt: number;
};

type UnreadReason = {
	messageCount: number;
	latestMessageId: string;
	latestMessageAt: string;
};

type UnreadRow = {
	conversationKey: string;
	latestMessageId: string;
	latestMessageAt: string;
	unreadMessageCount: number;
};

type EvidenceRow = Omit<ProjectedEvidenceMessage, "text"> & {
	conversationKey: string;
	messageRank: number;
	body: string;
};

const eligibleFolders = TODAY_BRIEF_ELIGIBLE_FOLDERS;

const canonicalConversationSql =
	"COALESCE(NULLIF(TRIM(thread_id), ''), id)";

const inboxConversationCte = `
	WITH inbox_messages AS (
		SELECT
			${canonicalConversationSql} AS conversationKey,
			id,
			SUBSTR(COALESCE(date, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.dateChars}) AS date,
			ROW_NUMBER() OVER (
				PARTITION BY ${canonicalConversationSql}
				ORDER BY COALESCE(unixepoch(date), -1) DESC, id DESC
			) AS messageRank,
			SUM(CASE WHEN read = 0 THEN 1 ELSE 0 END) OVER (
				PARTITION BY ${canonicalConversationSql}
			) AS unreadMessageCount
		FROM emails
		WHERE folder_id = '${TODAY_BRIEF_ELIGIBLE_FOLDERS[0]}'
		  AND unixepoch(date) IS NOT NULL
		  AND LENGTH(id) BETWEEN 1 AND ${TODAY_BRIEF_CANDIDATE_LIMITS.messageIdChars}
		  AND LENGTH(${canonicalConversationSql}) BETWEEN 1 AND ${TODAY_BRIEF_CANDIDATE_LIMITS.conversationKeyChars}
		  AND TRIM(COALESCE(sender, '')) <> ''
	), unread_conversations AS (
		SELECT conversationKey, id, date, unreadMessageCount
		FROM inbox_messages
		WHERE messageRank = 1 AND unreadMessageCount > 0
	)`;

function parseBoundaries(boundaries: { now: string; tomorrowStart: string }) {
	const now = Date.parse(boundaries.now);
	const tomorrowStart = Date.parse(boundaries.tomorrowStart);
	if (
		!Number.isFinite(now) ||
		!Number.isFinite(tomorrowStart) ||
		tomorrowStart <= now
	) {
		throw new Error("Valid Today brief boundaries are required");
	}
	return { now, tomorrowStart };
}

function dueReminderReasons(
	reminders: readonly FollowUpReminder[],
	boundaries: { now: number; tomorrowStart: number },
) {
	if (reminders.length > TODAY_BRIEF_CANDIDATE_LIMITS.reminderInputs) {
		throw new Error("Today brief reminder input exceeds its bound");
	}
	const byConversation = new Map<string, ReminderReason>();
	for (const reminder of reminders) {
		const conversationKey = reminder.conversationKey.trim();
		const remindAt = Date.parse(reminder.remindAt);
		if (
			reminder.state !== "active" ||
			conversationKey.length < 1 ||
			conversationKey.length >
				TODAY_BRIEF_CANDIDATE_LIMITS.conversationKeyChars ||
			!Number.isFinite(remindAt) ||
			remindAt >= boundaries.tomorrowStart
		) {
			continue;
		}
		const reason: ReminderReason = {
			id: reminder.id,
			version: reminder.version,
			state: "active",
			remindAt: new Date(remindAt).toISOString(),
			due: remindAt < boundaries.now ? "overdue" : "today",
			baselineMessageId: reminder.baselineMessageId,
			baselineMessageDate: reminder.baselineMessageDate,
			updatedAt: reminder.updatedAt,
		};
		const current = byConversation.get(conversationKey);
		if (
			!current ||
			Date.parse(reason.remindAt) < Date.parse(current.remindAt) ||
			(reason.remindAt === current.remindAt && reason.id < current.id)
		) {
			byConversation.set(conversationKey, reason);
		}
	}
	return byConversation;
}

function eligibleReminderKeys(
	sql: TodayBriefSqlReader,
	conversationKeys: readonly string[],
) {
	if (conversationKeys.length === 0) return new Set<string>();
	const rows = [...sql.exec<{ conversationKey: string }>(
		`WITH reminder_keys AS (
			SELECT CAST(value AS TEXT) AS conversationKey FROM json_each(?1)
		)
		SELECT reminder_keys.conversationKey
		FROM reminder_keys
		WHERE EXISTS (
			SELECT 1 FROM emails
			WHERE ${canonicalConversationSql} = reminder_keys.conversationKey
			  AND folder_id IN (?2, ?3, ?4, ?5)
			  AND unixepoch(date) IS NOT NULL
			  AND LENGTH(id) BETWEEN 1 AND ${TODAY_BRIEF_CANDIDATE_LIMITS.messageIdChars}
			  AND TRIM(COALESCE(sender, '')) <> ''
		)`,
		JSON.stringify(conversationKeys),
		...eligibleFolders,
	)];
	return new Set(rows.map((row) => row.conversationKey));
}

function unreadRowToReason(row: UnreadRow): UnreadReason {
	return {
		messageCount: Math.max(1, row.unreadMessageCount),
		latestMessageId: row.latestMessageId,
		latestMessageAt: row.latestMessageAt,
	};
}

function topUnreadConversations(sql: TodayBriefSqlReader): UnreadRow[] {
	return [...sql.exec<UnreadRow>(
		`${inboxConversationCte}
		 SELECT
			conversationKey,
			id AS latestMessageId,
			date AS latestMessageAt,
			unreadMessageCount
		 FROM unread_conversations
		 ORDER BY COALESCE(unixepoch(date), -1) DESC, conversationKey ASC
		 LIMIT ${TODAY_BRIEF_CANDIDATE_LIMITS.candidates}`,
	)];
}

function unreadReminderConversations(
	sql: TodayBriefSqlReader,
	conversationKeys: readonly string[],
): UnreadRow[] {
	if (conversationKeys.length === 0) return [];
	return [...sql.exec<UnreadRow>(
		`${inboxConversationCte}, reminder_keys AS (
			SELECT CAST(value AS TEXT) AS conversationKey FROM json_each(?1)
		 )
		 SELECT
			u.conversationKey,
			u.id AS latestMessageId,
			u.date AS latestMessageAt,
			u.unreadMessageCount
		 FROM unread_conversations u
		 INNER JOIN reminder_keys r ON r.conversationKey = u.conversationKey
		 ORDER BY u.conversationKey ASC`,
		JSON.stringify(conversationKeys),
	)];
}

function unreadConversationCount(sql: TodayBriefSqlReader) {
	const row = [...sql.exec<{ total: number }>(
		`${inboxConversationCte}
		 SELECT COUNT(*) AS total FROM unread_conversations`,
	)][0];
	return Math.max(0, row?.total ?? 0);
}

function candidateOrder(
	left: { conversationKey: string; reminder: ReminderReason | null; unread: UnreadReason | null },
	right: { conversationKey: string; reminder: ReminderReason | null; unread: UnreadReason | null },
) {
	const leftGroup = left.reminder?.due === "overdue"
		? 0
		: left.reminder
			? 1
			: 2;
	const rightGroup = right.reminder?.due === "overdue"
		? 0
		: right.reminder
			? 1
			: 2;
	if (leftGroup !== rightGroup) return leftGroup - rightGroup;
	if (left.reminder && right.reminder) {
		return Date.parse(left.reminder.remindAt) - Date.parse(right.reminder.remindAt) ||
			left.conversationKey.localeCompare(right.conversationKey);
	}
	if (left.unread && right.unread) {
		return Date.parse(right.unread.latestMessageAt) -
				Date.parse(left.unread.latestMessageAt) ||
			left.conversationKey.localeCompare(right.conversationKey);
	}
	return left.conversationKey.localeCompare(right.conversationKey);
}

function readEvidence(
	sql: TodayBriefSqlReader,
	conversationKeys: readonly string[],
) {
	if (conversationKeys.length === 0) {
		return new Map<string, ProjectedEvidenceMessage[]>();
	}
	const rows = [...sql.exec<EvidenceRow>(
		`WITH candidate_keys AS (
			SELECT CAST(value AS TEXT) AS conversationKey FROM json_each(?1)
		), ranked_messages AS (
			SELECT
				candidate_keys.conversationKey,
				emails.id,
				emails.folder_id AS folderId,
				SUBSTR(COALESCE(emails.sender, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.addressChars}) AS sender,
				SUBSTR(COALESCE(emails.recipient, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.addressChars}) AS recipient,
				SUBSTR(COALESCE(emails.date, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.dateChars}) AS date,
				SUBSTR(COALESCE(emails.subject, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.subjectChars}) AS subject,
				SUBSTR(COALESCE(emails.body, ''), 1, ${TODAY_BRIEF_CANDIDATE_LIMITS.rawBodyChars}) AS body,
				ROW_NUMBER() OVER (
					PARTITION BY candidate_keys.conversationKey
					ORDER BY COALESCE(unixepoch(emails.date), -1) DESC, emails.id DESC
				) AS messageRank
			FROM emails
			INNER JOIN candidate_keys
				ON ${canonicalConversationSql} = candidate_keys.conversationKey
			WHERE emails.folder_id IN (?2, ?3, ?4, ?5)
			  AND unixepoch(emails.date) IS NOT NULL
			  AND LENGTH(emails.id) BETWEEN 1 AND ${TODAY_BRIEF_CANDIDATE_LIMITS.messageIdChars}
			  AND TRIM(COALESCE(emails.sender, '')) <> ''
		)
		SELECT conversationKey, id, folderId, sender, recipient, date, subject, body, messageRank
		FROM ranked_messages
		WHERE messageRank <= ${TODAY_BRIEF_CANDIDATE_LIMITS.messagesPerCandidate}
		ORDER BY conversationKey ASC, messageRank DESC`,
		JSON.stringify(conversationKeys),
		...eligibleFolders,
	)];
	const evidence = new Map<string, ProjectedEvidenceMessage[]>();
	for (const row of rows) {
		const messages = evidence.get(row.conversationKey) ?? [];
		messages.push({
			id: row.id,
			folderId: row.folderId,
			sender: row.sender.trim(),
			recipient: row.recipient.trim(),
			date: row.date,
			subject: row.subject.trim() || "(No subject)",
			text: stripHtmlToText(row.body).slice(
				0,
				TODAY_BRIEF_CANDIDATE_LIMITS.bodyChars,
			),
		});
		evidence.set(row.conversationKey, messages);
	}
	return evidence;
}

/**
 * Build the complete authoritative model input from caller-owned reminder rows
 * and mailbox-owned mail. Only the bounded final candidates and their latest
 * eligible plain-text evidence cross the Durable Object boundary.
 */
export function readTodayBriefCandidates(
	sql: TodayBriefSqlReader,
	mailboxAddress: string,
	reminders: readonly FollowUpReminder[],
	boundaries: { now: string; tomorrowStart: string },
): TodayBriefCandidateProjection {
	const mailbox = mailboxAddress.trim().toLowerCase();
	if (mailbox.length < 3 || mailbox.length > TODAY_BRIEF_LIMITS.mailboxChars) {
		throw new Error("A valid mailbox is required for Today brief candidates");
	}
	const parsedBoundaries = parseBoundaries(boundaries);
	const reminderReasons = dueReminderReasons(reminders, parsedBoundaries);
	const eligibleKeys = eligibleReminderKeys(sql, [...reminderReasons.keys()]);
	for (const conversationKey of reminderReasons.keys()) {
		if (!eligibleKeys.has(conversationKey)) reminderReasons.delete(conversationKey);
	}

	const unreadCount = unreadConversationCount(sql);
	const reminderUnreadRows = unreadReminderConversations(
		sql,
		[...reminderReasons.keys()],
	);
	const topUnreadRows = topUnreadConversations(sql);
	const unreadByConversation = new Map<string, UnreadReason>();
	for (const row of [...reminderUnreadRows, ...topUnreadRows]) {
		unreadByConversation.set(row.conversationKey, unreadRowToReason(row));
	}

	const seeds = new Map<string, {
		conversationKey: string;
		reminder: ReminderReason | null;
		unread: UnreadReason | null;
	}>();
	for (const [conversationKey, reminder] of reminderReasons) {
		seeds.set(conversationKey, {
			conversationKey,
			reminder,
			unread: unreadByConversation.get(conversationKey) ?? null,
		});
	}
	for (const row of topUnreadRows) {
		const current = seeds.get(row.conversationKey);
		if (current) {
			current.unread = unreadRowToReason(row);
		} else {
			seeds.set(row.conversationKey, {
				conversationKey: row.conversationKey,
				reminder: null,
				unread: unreadRowToReason(row),
			});
		}
	}

	const selected = [...seeds.values()]
		.sort(candidateOrder)
		.slice(0, TODAY_BRIEF_CANDIDATE_LIMITS.candidates);
	const evidence = readEvidence(
		sql,
		selected.map((candidate) => candidate.conversationKey),
	);
	const selectedWithEvidence = selected.flatMap((candidate) => {
		const messages = evidence.get(candidate.conversationKey) ?? [];
		const latest = messages.at(-1);
		if (!latest) return [];
		return [{ candidate, messages, latest }];
	});
	const candidates = selectedWithEvidence.map(
		({ candidate, messages, latest }, index): TodayBriefCandidateInput => {
			const reasons: TodayBriefCandidateReason[] = [];
			if (candidate.reminder) {
				reasons.push(
					candidate.reminder.due === "overdue"
						? "overdue_reminder"
						: "today_reminder",
				);
			}
			if (candidate.unread) reasons.push("unread_in_mailbox");
			const counterparty = latest.sender.trim().toLowerCase() === mailbox
				? latest.recipient
				: latest.sender;
			return {
			id: `focus-${String(index + 1).padStart(2, "0")}`,
			conversationKey: candidate.conversationKey,
			sourceEmailId: latest.id,
			subject: latest.subject,
			counterparty: counterparty.trim() || "Unknown correspondent",
			reasons,
			reminder: candidate.reminder
				? {
						id: candidate.reminder.id,
						version: candidate.reminder.version,
						state: "active",
						dueAt: candidate.reminder.remindAt,
					}
				: null,
			remindAt: candidate.reminder?.remindAt ?? null,
			unreadInMailbox: candidate.unread !== null,
			messages: messages.map(({ recipient: _recipient, ...message }) => message),
		};
		},
	);
	const totalCandidateCount = reminderReasons.size + unreadCount -
		reminderUnreadRows.length;
	return {
		candidates,
		omittedCount: Math.max(0, totalCandidateCount - candidates.length),
		counts: {
			privateRemindersDue: reminderReasons.size,
			unreadConversations: unreadCount,
		},
	};
}
