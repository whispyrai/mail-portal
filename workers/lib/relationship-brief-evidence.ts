import { RELATIONSHIP_BRIEF_LIMITS } from "../../shared/relationship-brief.ts";
import { stripHtmlToText } from "./email-helpers.ts";

type SqlValue = ArrayBuffer | string | number | null;

export type RelationshipBriefSqlReader = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
};

export type RelationshipBriefEvidenceMessage = {
	id: string;
	conversationId: string;
	folderId: string;
	direction: "sent" | "received";
	role: "from" | "to" | "cc" | "bcc";
	sentAt: string;
	subject: string;
	text: string;
};

export type RelationshipBriefEvidenceProjection =
	| { state: "not_found" }
	| {
			state: "ready";
			person: { id: string; address: string; displayName: string | null };
			messages: RelationshipBriefEvidenceMessage[];
	  };

type PersonRow = { id: string; address: string; displayName: string | null };
type MessageRow = Omit<RelationshipBriefEvidenceMessage, "text"> & { body: string };

const UNSAFE_UNICODE_GLOBAL =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/gu;

const HTML_QUOTE_TAILS = [
	/<blockquote\b/iu,
	/<[^>]+class\s*=\s*["'][^"']*\bgmail_quote\b/iu,
	/<[^>]+id\s*=\s*["'](?:divRplyFwdMsg|appendonsend)["']/iu,
	/<[^>]+class\s*=\s*["'][^"']*\bOutlookMessageHeader\b/iu,
	/<!--\s*(?:original message|forwarded message)\s*-->/iu,
	/<(?:div|p)\b[^>]*>\s*On\s[\s\S]{1,500}?\swrote:\s*<\/(?:div|p)>/iu,
	/<(?:div|p)\b[^>]*>\s*(?:-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}|Begin forwarded message:)/iu,
	/<(?:div|p)\b[^>]*>\s*(?:>|&gt;)/iu,
	/(?:<br\b[^>]*>|<\/(?:div|p)>)(?:\s|&nbsp;)*(?:-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}|Begin forwarded message:)/iu,
	/(?:<br\b[^>]*>|<\/(?:div|p)>)(?:\s|&nbsp;)*(?:>|&gt;)/iu,
	/(?:^|\n)\s*(?:-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}|Begin forwarded message:|On\s[\s\S]{1,500}?\swrote:\s*|>)/imu,
] as const;

const PLAIN_QUOTE_TAIL = /(?:^|\n)\s*(?:-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}|Begin forwarded message:|On\s[\s\S]{1,500}?\swrote:\s*|>)/imu;

function earliestMatch(value: string, patterns: readonly RegExp[]): number | null {
	let earliest: number | null = null;
	for (const pattern of patterns) {
		const index = value.search(pattern);
		if (index >= 0 && (earliest === null || index < earliest)) earliest = index;
	}
	return earliest;
}

/** Keep only text authored in this Message, excluding quoted reply/forward history. */
export function authoredRelationshipBriefText(body: string): string {
	const htmlTail = earliestMatch(body, HTML_QUOTE_TAILS);
	const withoutHtmlTail = htmlTail === null ? body : body.slice(0, htmlTail);
	// This second pass handles a plain body after structural/raw markers have been
	// removed. HTML bodies have already been fenced before their tags are folded.
	const plainTail = withoutHtmlTail.search(PLAIN_QUOTE_TAIL);
	const withoutPlainTail = /<[^>]+>/u.test(withoutHtmlTail) || plainTail < 0
		? withoutHtmlTail
		: withoutHtmlTail.slice(0, plainTail);
	return stripHtmlToText(withoutPlainTail);
}

function safeProjectionText(value: string, maximum: number): string {
	return Array.from(value.normalize("NFC").replace(UNSAFE_UNICODE_GLOBAL, " ").trim())
		.slice(0, maximum)
		.join("");
}

export function readRelationshipBriefEvidence(
	sql: RelationshipBriefSqlReader,
	personId: string,
): RelationshipBriefEvidenceProjection {
	const person = [...sql.exec<PersonRow>(`
		SELECT p.id, p.address,
			(
				SELECT named.observed_name
				FROM mail_message_participants named
				WHERE named.person_id = p.id AND named.observed_name IS NOT NULL
				ORDER BY CASE WHEN named.origin = 'live_inbound' THEN 0 ELSE 1 END,
					named.occurred_at DESC, named.source_email_id DESC
				LIMIT 1
			) AS displayName
		FROM mail_people p
		WHERE p.id = ?1
		  AND EXISTS (SELECT 1 FROM mail_message_participants mp WHERE mp.person_id = p.id)
		LIMIT 1
	`, personId)][0];
	if (!person) return { state: "not_found" };

	const rows = [...sql.exec<MessageRow>(`
		WITH person_evidence AS (
			SELECT mp.source_email_id AS id, mp.conversation_id AS conversationId,
				mp.occurred_at AS sentAt, mp.direction, mp.role,
				e.folder_id AS folderId,
				SUBSTR(COALESCE(e.subject, ''), 1, 1000) AS subject,
				SUBSTR(COALESCE(e.body, ''), 1, 9000) AS body
			FROM mail_message_participants mp
			JOIN emails e ON e.id = mp.source_email_id
			WHERE mp.person_id = ?1
		), conversation_recency AS (
			SELECT conversationId, MAX(sentAt) AS latestAt
			FROM person_evidence
			GROUP BY conversationId
		), selected_conversations AS (
			SELECT conversationId
			FROM conversation_recency
			ORDER BY latestAt DESC, conversationId ASC
			LIMIT ${RELATIONSHIP_BRIEF_LIMITS.conversations}
		), recent_messages AS (
			SELECT pe.*
			FROM person_evidence pe
			JOIN selected_conversations selected
				ON selected.conversationId = pe.conversationId
			ORDER BY pe.sentAt DESC, pe.id ASC, pe.role ASC
			LIMIT ${RELATIONSHIP_BRIEF_LIMITS.messages}
		)
		SELECT id, conversationId, folderId, direction, role, sentAt, subject, body
		FROM recent_messages
		ORDER BY sentAt ASC, id ASC, role ASC
	`, personId)];
	if (rows.length === 0) return { state: "not_found" };
	return {
		state: "ready",
		person,
		messages: rows.map(({ body, ...row }) => ({
			...row,
			subject: safeProjectionText(row.subject, 1_000),
			text: safeProjectionText(
				authoredRelationshipBriefText(body),
				RELATIONSHIP_BRIEF_LIMITS.messageTextChars,
			),
		})),
	};
}
