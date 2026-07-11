import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("migration 17 creates an idempotent durable follow-up reply queue", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "17_add_follow_up_reply_completion_queue",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(migration.sql);
	const insert = database.prepare(
		`INSERT INTO follow_up_reply_completion_queue
		 (inbound_message_id, mailbox_address, conversation_key,
		  inbound_message_date, attempts, next_attempt_at, created_at)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
	);
	insert.run(
		"message-1",
		"shared@example.com",
		"thread-1",
		"2026-07-11T12:00:00.000Z",
		100,
		100,
	);
	assert.throws(() => insert.run(
		"message-1",
		"shared@example.com",
		"thread-other",
		"2026-07-11T12:00:01.000Z",
		101,
		101,
	), /unique/i);
	assert.deepEqual(
		{ ...database.prepare(
			`SELECT conversation_key, attempts, next_attempt_at
			 FROM follow_up_reply_completion_queue
			 WHERE inbound_message_id = 'message-1'`,
		).get() },
		{ conversation_key: "thread-1", attempts: 0, next_attempt_at: 100 },
	);
	database.close();
});
