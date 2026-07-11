import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxSendCutoffs } from "./send-rate-limit.ts";

test("mailbox send cutoffs use the same sortable ISO format as stored mail", () => {
	assert.deepEqual(mailboxSendCutoffs(Date.parse("2026-07-11T12:00:00.000Z")), {
		hour: "2026-07-11T11:00:00.000Z",
		day: "2026-07-10T12:00:00.000Z",
	});
});

test("explicit ISO cutoffs exclude old same-day messages at the hourly boundary", () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE emails (folder_id TEXT, date TEXT)");
	const insert = db.prepare("INSERT INTO emails VALUES ('sent', ?)");
	insert.run("2026-07-11T09:00:00.000Z");
	insert.run("2026-07-11T11:30:00.000Z");
	const { hour } = mailboxSendCutoffs(Date.parse("2026-07-11T12:00:00.000Z"));
	const row = db.prepare(
		"SELECT COUNT(*) AS count FROM emails WHERE folder_id = ? AND date >= ?",
	).get("sent", hour) as { count: number };
	assert.equal(row.count, 1);
	db.close();
});
