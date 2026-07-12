import {
	MailboxChangeQueryError,
	encodeMailboxChangeCursor,
	validateMailboxChangePage,
	validateNormalizedMailboxChangeQuery,
	type MailboxChangePage,
	type NormalizedMailboxChangeQuery,
} from "../../shared/mailbox-change-feed.ts";

type SqlValue = string | number | null;

export interface MailboxChangeSqlReader {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

type CurrentSequenceRow = { currentSequence: number };
type MailboxChangeRow = {
	sequence: number;
	schemaVersion: number;
	committedAt: string;
	resource: string;
	entityId: string;
	parentId: string | null;
	operation: string;
};

function currentSequence(sql: MailboxChangeSqlReader): number {
	const current = [...sql.exec<CurrentSequenceRow>(
		"SELECT COALESCE(MAX(sequence), 0) AS currentSequence FROM mailbox_changes",
	)][0]?.currentSequence ?? 0;
	if (!Number.isSafeInteger(current) || current < 0) {
		throw new MailboxChangeQueryError("Mailbox change sequence is invalid");
	}
	return current;
}

export function readMailboxChanges(
	sql: MailboxChangeSqlReader,
	options: NormalizedMailboxChangeQuery,
): MailboxChangePage {
	const validated = validateNormalizedMailboxChangeQuery(options);
	const current = currentSequence(sql);
	if (validated.after === null) {
		return validateMailboxChangePage(
			{ changes: [], nextCursor: encodeMailboxChangeCursor(current) },
			null,
		);
	}
	if (validated.after > current) {
		throw new MailboxChangeQueryError("Future mailbox change cursor is invalid");
	}
	const rows = [...sql.exec<MailboxChangeRow>(
		`SELECT
			sequence AS sequence,
			schema_version AS schemaVersion,
			committed_at AS committedAt,
			resource AS resource,
			entity_id AS entityId,
			parent_id AS parentId,
			operation AS operation
		 FROM mailbox_changes
		 WHERE sequence > ?
		 ORDER BY sequence ASC
		 LIMIT ?`,
		validated.after,
		validated.limit,
	)];
	const lastSequence = rows.at(-1)?.sequence ?? validated.after;
	return validateMailboxChangePage(
		{
			changes: rows,
			nextCursor: encodeMailboxChangeCursor(lastSequence),
		},
		validated.after,
	);
}
