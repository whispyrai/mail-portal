import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readStoredReminderAnchor } from "./follow-up-reminder-anchor.ts";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		folder_id TEXT NOT NULL,
		thread_id TEXT,
		date TEXT
	)`);
	return {
		db,
		sql: {
			exec<T extends Record<string, ArrayBuffer | string | number | null>>(
				query: string,
				...bindings: (ArrayBuffer | string | number | null)[]
			) {
				return db.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

test("reminder anchor derives the canonical conversation and latest stored message", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?)");
	insert.run("inbox-1", "inbox", "thread-1", "2026-07-11T10:00:00.000Z");
	insert.run("sent-2", "sent", "thread-1", "2026-07-11T11:00:00.000Z");
	insert.run("draft-3", "draft", "thread-1", "2026-07-11T12:00:00.000Z");
	assert.deepEqual(readStoredReminderAnchor(sql, "inbox-1"), {
		conversationKey: "thread-1",
		baselineMessageId: "sent-2",
		baselineMessageDate: "2026-07-11T11:00:00.000Z",
	});
	db.close();
});

test("reminder anchor rejects unsupported folders and never crosses conversations", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?)");
	insert.run("trash-1", "trash", "thread-1", "2026-07-11T10:00:00.000Z");
	insert.run("inbox-2", "inbox", "thread-2", "2026-07-11T12:00:00.000Z");
	insert.run("inbox-3", "inbox", "thread-3", "2026-07-11T13:00:00.000Z");
	assert.equal(readStoredReminderAnchor(sql, "trash-1"), null);
	assert.deepEqual(readStoredReminderAnchor(sql, "inbox-2"), {
		conversationKey: "thread-2",
		baselineMessageId: "inbox-2",
		baselineMessageDate: "2026-07-11T12:00:00.000Z",
	});
	assert.equal(readStoredReminderAnchor(sql, "missing"), null);
	db.close();
});
