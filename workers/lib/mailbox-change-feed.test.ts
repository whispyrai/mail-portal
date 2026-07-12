import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { decodeMailboxChangeCursor } from "../../shared/mailbox-change-feed.ts";
import { readMailboxChanges } from "./mailbox-change-feed.ts";

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE mailbox_changes (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			schema_version INTEGER NOT NULL,
			committed_at TEXT NOT NULL,
			resource TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			parent_id TEXT,
			operation TEXT NOT NULL
		);
		INSERT INTO mailbox_changes
			(schema_version, committed_at, resource, entity_id, parent_id, operation)
		VALUES
			(1, '2026-07-12T10:00:00.001Z', 'message', 'message-1', NULL, 'created'),
			(1, '2026-07-12T10:00:00.002Z', 'attachment', 'attachment-1', 'message-1', 'created'),
			(1, '2026-07-12T10:00:00.003Z', 'message', 'message-1', NULL, 'updated');
	`);
	return {
		db,
		sql: {
			exec<T extends Record<string, string | number | null>>(
				query: string,
				...bindings: Array<string | number | null>
			): Iterable<T> {
				return db.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

test("mailbox changes baseline at the current sequence and replay in strict ascending pages", () => {
	const { db, sql } = database();
	const baseline = readMailboxChanges(sql, { after: null, limit: 2 });
	assert.deepEqual(baseline.changes, []);
	assert.equal(decodeMailboxChangeCursor(baseline.nextCursor), 3);

	const first = readMailboxChanges(sql, { after: 0, limit: 2 });
	assert.deepEqual(first.changes.map((change) => change.sequence), [1, 2]);
	assert.equal(decodeMailboxChangeCursor(first.nextCursor), 2);
	assert.deepEqual(Object.keys(first.changes[0]!).sort(), [
		"committedAt",
		"entityId",
		"operation",
		"parentId",
		"resource",
		"schemaVersion",
		"sequence",
	]);

	const second = readMailboxChanges(sql, { after: 2, limit: 2 });
	assert.deepEqual(second.changes.map((change) => change.sequence), [3]);
	assert.equal(decodeMailboxChangeCursor(second.nextCursor), 3);
	const empty = readMailboxChanges(sql, { after: 3, limit: 2 });
	assert.deepEqual(empty.changes, []);
	assert.equal(decodeMailboxChangeCursor(empty.nextCursor), 3);
	assert.throws(
		() => readMailboxChanges(sql, { after: 4, limit: 2 }),
		/Future mailbox change cursor/,
	);
	db.close();
});

test("mailbox change reads reject forged RPC options before querying rows", () => {
	const { db, sql } = database();
	let rowReads = 0;
	const guardedSql = {
		exec<T extends Record<string, string | number | null>>(
			query: string,
			...bindings: Array<string | number | null>
		): Iterable<T> {
			if (query.includes("FROM mailbox_changes") && query.includes("WHERE sequence")) {
				rowReads += 1;
			}
			return sql.exec<T>(query, ...bindings);
		},
	};
	const forged = { after: 0, limit: 25, extra: true };
	assert.throws(() => readMailboxChanges(guardedSql, forged), /query is invalid/i);
	assert.equal(rowReads, 0);
	db.close();
});
