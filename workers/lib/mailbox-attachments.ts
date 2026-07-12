import {
	ATTACHMENT_KINDS,
	encodeMailboxAttachmentCursor,
	mailboxAttachmentFilenameLikePattern,
	mailboxAttachmentKindSql,
	type MailboxAttachmentItem,
	type MailboxAttachmentPage,
	type NormalizedMailboxAttachmentListOptions,
} from "../../shared/mailbox-attachments.ts";

type SqlValue = ArrayBuffer | string | number | null;

export interface MailboxAttachmentSqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

export interface MailboxAttachmentByteMetadata {
	id: string;
	email_id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id: string | null;
	disposition: string | null;
}

type AttachmentProjectionRow = {
	id: string;
	emailId: string;
	filename: string;
	mimetype: string;
	size: number;
	kind: string;
	subject: string;
	sender: string;
	date: string;
	sortDate: string;
	folderId: string;
	folderName: string;
};

const ELIGIBLE_WHERE = `
	e.folder_id NOT IN ('draft', 'outbox', '_cancelled_outbound')
	AND COALESCE(a.disposition, 'attachment') <> 'inline'`;

function projectionSql(where: string): string {
	return `SELECT
		a.id AS id,
		e.id AS emailId,
		SUBSTR(COALESCE(a.filename, ''), 1, 255) AS filename,
		SUBSTR(COALESCE(a.mimetype, ''), 1, 100) AS mimetype,
		MAX(0, a.size) AS size,
		${mailboxAttachmentKindSql("a")} AS kind,
		SUBSTR(COALESCE(e.subject, ''), 1, 500) AS subject,
		SUBSTR(COALESCE(e.sender, ''), 1, 320) AS sender,
		SUBSTR(COALESCE(e.date, ''), 1, 64) AS date,
		COALESCE(e.date, '') AS sortDate,
		SUBSTR(COALESCE(e.folder_id, ''), 1, 200) AS folderId,
		SUBSTR(COALESCE(f.name, e.folder_id, ''), 1, 200) AS folderName
	FROM attachments a
	INNER JOIN emails e ON e.id = a.email_id
	LEFT JOIN folders f ON f.id = e.folder_id
	WHERE ${where}`;
}

function item(row: AttachmentProjectionRow): MailboxAttachmentItem {
	const kind = ATTACHMENT_KINDS.find((candidate) => candidate === row.kind) ?? "other";
	return {
		id: row.id,
		emailId: row.emailId,
		filename: row.filename,
		mimetype: row.mimetype,
		size: Number(row.size),
		kind,
		message: {
			subject: row.subject,
			sender: row.sender,
			date: row.date,
			folderId: row.folderId,
			folderName: row.folderName,
		},
	};
}

export function readMailboxAttachmentPage(
	sql: MailboxAttachmentSqlReader,
	options: NormalizedMailboxAttachmentListOptions,
): MailboxAttachmentPage {
	const conditions = [ELIGIBLE_WHERE];
	const bindings: SqlValue[] = [];
	if (options.q) {
		conditions.push(`a.filename LIKE ? ESCAPE '\\' COLLATE NOCASE`);
		bindings.push(mailboxAttachmentFilenameLikePattern(options.q));
	}
	if (options.kind) {
		conditions.push(`${mailboxAttachmentKindSql("a")} = ?`);
		bindings.push(options.kind);
	}
	if (options.folder) {
		conditions.push("e.folder_id = ?");
		bindings.push(options.folder);
	}
	if (options.cursor) {
		conditions.push(`(
			COALESCE(e.date, '') < ? OR
			(COALESCE(e.date, '') = ? AND e.id > ?) OR
			(COALESCE(e.date, '') = ? AND e.id = ? AND a.id > ?)
		)`);
		bindings.push(
			options.cursor.date,
			options.cursor.date,
			options.cursor.emailId,
			options.cursor.date,
			options.cursor.emailId,
			options.cursor.attachmentId,
		);
	}
	bindings.push(options.limit + 1);
	const rows = [
		...sql.exec<AttachmentProjectionRow>(
			`${projectionSql(conditions.join(" AND "))}
			ORDER BY COALESCE(e.date, '') DESC, e.id ASC, a.id ASC
			LIMIT ?`,
			...bindings,
		),
	];
	const hasMore = rows.length > options.limit;
	const visibleRows = rows.slice(0, options.limit);
	const items = visibleRows.map(item);
	const last = hasMore ? visibleRows.at(-1) : undefined;
	return {
		items,
		nextCursor: last
			? encodeMailboxAttachmentCursor(
				{
					date: last.sortDate,
					emailId: last.emailId,
					attachmentId: last.id,
				},
				options,
			)
			: null,
	};
}

export function readMailboxAttachmentDetail(
	sql: MailboxAttachmentSqlReader,
	attachmentId: string,
): MailboxAttachmentItem | null {
	const row = [
		...sql.exec<AttachmentProjectionRow>(
			`${projectionSql(`${ELIGIBLE_WHERE} AND a.id = ?`)} LIMIT 1`,
			attachmentId,
		),
	][0];
	return row ? item(row) : null;
}

export function readMailboxAttachmentForEmail(
	sql: MailboxAttachmentSqlReader,
	emailId: string,
	attachmentId: string,
): MailboxAttachmentByteMetadata | null {
	if (!emailId || !attachmentId || emailId.length > 300 || attachmentId.length > 300) {
		return null;
	}
	return [
		...sql.exec<MailboxAttachmentByteMetadata & Record<string, SqlValue>>(
			`SELECT a.id, a.email_id, a.filename, a.mimetype, a.size, a.content_id, a.disposition
			 FROM attachments a
			 INNER JOIN emails e ON e.id = a.email_id
			 WHERE a.id = ? AND a.email_id = ? AND e.folder_id <> '_cancelled_outbound'
			 LIMIT 1`,
			attachmentId,
			emailId,
		),
	][0] ?? null;
}
