import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFollowUpReminderPreviews } from "./follow-up-reminder-previews.ts";

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE emails (
		id TEXT PRIMARY KEY,
		folder_id TEXT NOT NULL,
		subject TEXT,
		sender TEXT,
		recipient TEXT,
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

test("reminder previews derive bounded subject and directional counterparty", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?)");
	insert.run("inbound", "inbox", `  ${"S".repeat(350)}  `, "  Client <client@example.com>  ", "team@example.com", "secret body");
	insert.run("outbound", "archive", "Proposal", "team@example.com", "  Buyer <buyer@example.com>  ", "secret body");
	insert.run("blank", "archive", "", "", "team@example.com", "secret body");

	const previews = readFollowUpReminderPreviews(
		sql,
		"team@example.com",
		["inbound", "outbound", "blank", "inbound"],
	);
	assert.deepEqual(previews, [
		{
			baselineMessageId: "blank",
			subject: "(No subject)",
			counterparty: "Unknown correspondent",
		},
		{
			baselineMessageId: "inbound",
			subject: "S".repeat(300),
			counterparty: "Client <client@example.com>",
		},
		{
			baselineMessageId: "outbound",
			subject: "Proposal",
			counterparty: "Buyer <buyer@example.com>",
		},
	]);
	db.close();
});

test("reminder previews exclude Draft, Outbox, Trash, Spam, and internal mail", () => {
	const { db, sql } = fixture();
	const insert = db.prepare("INSERT INTO emails VALUES (?, ?, ?, ?, ?, ?)");
	for (const folder of ["draft", "outbox", "trash", "spam", "_cancelled_outbound"]) {
		insert.run(folder, folder, "Hidden", "hidden@example.com", "team@example.com", "secret body");
	}
	assert.deepEqual(
		readFollowUpReminderPreviews(sql, "team@example.com", ["draft", "outbox", "trash", "spam", "_cancelled_outbound", "missing"]),
		[],
	);
	db.close();
});

test("reminder preview projection rejects unbounded batches before SQL", () => {
	const { db, sql } = fixture();
	assert.throws(
		() => readFollowUpReminderPreviews(sql, "team@example.com", Array.from({ length: 101 }, (_, index) => `message-${index}`)),
		/preview batch is invalid/,
	);
	assert.throws(
		() => readFollowUpReminderPreviews(sql, "team@example.com", ["x".repeat(301)]),
		/preview batch is invalid/,
	);
	assert.deepEqual(readFollowUpReminderPreviews(sql, "team@example.com", []), []);
	db.close();
});
