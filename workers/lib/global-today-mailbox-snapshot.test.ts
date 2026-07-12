import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readGlobalTodayMailboxSnapshot } from "./global-today-mailbox-snapshot.ts";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		thread_id TEXT,
		folder_id TEXT NOT NULL,
		subject TEXT,
		sender TEXT,
		recipient TEXT,
		date TEXT,
		read INTEGER NOT NULL,
		body TEXT
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

test("global Today counts unread Conversations and returns three newest metadata previews", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	insert.run("m1", "thread-a", "inbox", "Older", "a@example.com", "team@example.com", "2026-07-12T08:00:00.000Z", 0, "secret A");
	insert.run("m2", "thread-a", "inbox", "Newest A", "a@example.com", "team@example.com", "2026-07-12T09:00:00.000Z", 1, "secret B");
	insert.run("m3", "thread-b", "inbox", "Newest B", "b@example.com", "team@example.com", "2026-07-12T10:00:00.000Z", 0, "secret C");
	insert.run("m4", "thread-c", "inbox", "Newest C", "c@example.com", "team@example.com", "2026-07-12T11:00:00.000Z", 0, "secret D");
	insert.run("m5", "thread-d", "inbox", "Newest D", "d@example.com", "team@example.com", "2026-07-12T12:00:00.000Z", 0, "secret E");

	const result = readGlobalTodayMailboxSnapshot(sql, "team@example.com", []);
	assert.equal(result.unreadConversationCount, 4);
	assert.deepEqual(result.unreadPreviews.map((row) => row.messageId), ["m5", "m4", "m3"]);
	assert.equal(JSON.stringify(result).includes("secret"), false);
	db.close();
});

test("global Today reminder previews are bounded, eligible, and body-free", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	insert.run("inbound", null, "inbox", " Hello ", "client@example.com", "team@example.com", "2026-07-12T08:00:00.000Z", 1, "private body");
	insert.run("draft", null, "draft", "Hidden", "team@example.com", "client@example.com", "2026-07-12T09:00:00.000Z", 1, "private draft");

	const result = readGlobalTodayMailboxSnapshot(sql, "team@example.com", ["inbound", "draft", "inbound"]);
	assert.deepEqual(result.reminderPreviews, [{
		baselineMessageId: "inbound",
		subject: "Hello",
		counterparty: "client@example.com",
	}]);
	assert.equal(JSON.stringify(result).includes("private"), false);
	db.close();
});

test("global Today applies the same eligibility filters to unread totals and previews", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
	insert.run("invalid-date", "invalid-thread", "inbox", "Hidden", "a@example.com", "team@example.com", "not-a-date", 0, "secret");
	assert.deepEqual(readGlobalTodayMailboxSnapshot(sql, "team@example.com", []), {
		unreadConversationCount: 0,
		unreadPreviews: [],
		reminderPreviews: [],
	});
	insert.run("valid", "valid-thread", "inbox", "Visible", "b@example.com", "team@example.com", "2026-07-12T10:00:00.000Z", 0, "secret");
	const result = readGlobalTodayMailboxSnapshot(sql, "team@example.com", []);
	assert.equal(result.unreadConversationCount, 1);
	assert.deepEqual(result.unreadPreviews.map((row) => row.messageId), ["valid"]);
	db.close();
});
