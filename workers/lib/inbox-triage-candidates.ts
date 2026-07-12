import {
	INBOX_TRIAGE_SUGGESTION_LIMITS,
	type NormalizedInboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";
import { Folders } from "../../shared/folders.ts";
import { stripHtmlToText } from "./email-helpers.ts";

export type InboxTriageCandidateMessage = {
	id: string;
	date: string;
	sender: string;
	subject: string;
	text: string;
};

export type InboxTriageCandidate = {
	candidateId: string;
	emailId: string;
	conversationId: string | null;
	subject: string;
	counterparty: string;
	latestAt: string;
	read: boolean;
	threadUnreadCount: number;
	starred: boolean;
	hasDraft: boolean;
	messages: InboxTriageCandidateMessage[];
};

export type InboxTriageCandidateSnapshot = {
	version: 1;
	page: number;
	labelId: string | null;
	visibleEmailIds: string[];
	candidates: InboxTriageCandidate[];
};

export type InboxTriageCandidateProjection =
	| { state: "stale" }
	| { state: "ready"; snapshot: InboxTriageCandidateSnapshot };

export type InboxThreadedEmailRow = {
	id: unknown;
	conversation_id?: unknown;
	subject?: unknown;
	sender?: unknown;
	recipient?: unknown;
	date?: unknown;
	read?: unknown;
	thread_unread_count?: unknown;
	starred?: unknown;
	has_draft?: unknown;
	folder_id?: unknown;
};

type SqlValue = ArrayBuffer | string | number | null;

export interface InboxTriageSqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

type EvidenceRow = {
	candidateId: string;
	id: string;
	date: string;
	sender: string;
	subject: string;
	body: string;
};

function boundedPlainText(value: unknown, maxChars: number): string {
	const raw = typeof value === "string" ? value : "";
	return Array.from(stripHtmlToText(raw).normalize("NFC"))
		.slice(0, maxChars)
		.join("");
}

function text(value: unknown, maxChars: number): string {
	return Array.from(typeof value === "string" ? value.normalize("NFC") : "")
		.slice(0, maxChars)
		.join("");
}

function nonNegativeInteger(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function booleanValue(value: unknown): boolean {
	return value === true || value === 1;
}

function normalizedAddress(value: unknown): string {
	const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
	const bracketed = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
	return (bracketed?.[1] ?? raw).replace(/^mailto:/, "");
}

function counterpartyForRow(row: InboxThreadedEmailRow, mailboxId: string): string {
	const sender = normalizedAddress(row.sender);
	const mailbox = normalizedAddress(mailboxId);
	return text(sender === mailbox ? row.recipient : row.sender, 320);
}

function readRecentEvidence(
	sql: InboxTriageSqlReader,
	rows: InboxThreadedEmailRow[],
): Map<string, InboxTriageCandidateMessage[]> {
	const bindings: SqlValue[] = [];
	const tuples = rows.map((row) => {
		bindings.push(String(row.id), String(row.conversation_id ?? row.id));
		const offset = bindings.length - 1;
		return `(?${offset}, ?${offset + 1})`;
	});
	const evidence = [
		...sql.exec<EvidenceRow>(
			`WITH requested(candidate_id, conversation_id) AS (
				VALUES ${tuples.join(", ")}
			), ranked AS (
				SELECT
					r.candidate_id AS candidateId,
					SUBSTR(e.id, 1, 300) AS id,
					SUBSTR(COALESCE(e.date, ''), 1, 64) AS date,
					SUBSTR(COALESCE(e.sender, ''), 1, 320) AS sender,
					SUBSTR(COALESCE(e.subject, ''), 1, 500) AS subject,
					SUBSTR(COALESCE(e.body, ''), 1, 4000) AS body,
					ROW_NUMBER() OVER (
						PARTITION BY r.candidate_id
						ORDER BY e.date DESC, e.id DESC
					) AS evidence_rank
				FROM requested r
				INNER JOIN emails e ON (
					(e.thread_id IS NOT NULL AND e.thread_id = r.conversation_id)
					OR (e.thread_id IS NULL AND e.id = r.conversation_id)
				)
				WHERE e.folder_id NOT IN ('draft', 'outbox', '_cancelled_outbound', '_retired_outbound')
			)
			SELECT candidateId, id, date, sender, subject, body
			FROM ranked
			WHERE evidence_rank <= ${INBOX_TRIAGE_SUGGESTION_LIMITS.messagesPerCandidate}
			ORDER BY candidateId ASC, date ASC, id ASC`,
			...bindings,
		),
	];
	const byCandidate = new Map<string, InboxTriageCandidateMessage[]>();
	for (const message of evidence) {
		const messages = byCandidate.get(message.candidateId) ?? [];
		messages.push({
			id: text(message.id, 300),
			date: text(message.date, 64),
			sender: text(message.sender, 320),
			subject: text(message.subject, 500),
			text: boundedPlainText(
				message.body,
				INBOX_TRIAGE_SUGGESTION_LIMITS.messageTextChars,
			),
		});
		byCandidate.set(message.candidateId, messages);
	}
	return byCandidate;
}

export function projectInboxTriageCandidates(
	sql: InboxTriageSqlReader,
	rows: InboxThreadedEmailRow[],
	request: NormalizedInboxTriageSuggestionRequest,
	mailboxId: string,
): InboxTriageCandidateProjection {
	if (rows.length > INBOX_TRIAGE_SUGGESTION_LIMITS.candidates) {
		return { state: "stale" };
	}
	const actualIds = rows.map((row) => String(row.id ?? ""));
	if (
		actualIds.length !== request.visibleEmailIds.length ||
		actualIds.some((id, index) => id !== request.visibleEmailIds[index])
	) {
		return { state: "stale" };
	}
	if (
		rows.some(
			(row) => !String(row.id ?? "") || row.folder_id !== Folders.INBOX,
		)
	) {
		return { state: "stale" };
	}

	const evidenceByCandidate = readRecentEvidence(sql, rows);
	const candidates: InboxTriageCandidate[] = [];
	for (const row of rows) {
		const emailId = String(row.id ?? "");
		const recent = evidenceByCandidate.get(emailId) ?? [];
		if (recent.length === 0) return { state: "stale" };
		candidates.push({
			candidateId: emailId,
			emailId,
			conversationId:
				typeof row.conversation_id === "string" && row.conversation_id
					? text(row.conversation_id, 300)
					: null,
			subject: text(row.subject, 500),
			counterparty: counterpartyForRow(row, mailboxId),
			latestAt: text(row.date, 64),
			read: booleanValue(row.read),
			threadUnreadCount: nonNegativeInteger(row.thread_unread_count),
			starred: booleanValue(row.starred),
			hasDraft: booleanValue(row.has_draft),
			messages: recent,
		});
	}

	return {
		state: "ready",
		snapshot: {
			version: 1,
			page: request.page,
			labelId: request.labelId,
			visibleEmailIds: [...request.visibleEmailIds],
			candidates,
		},
	};
}
