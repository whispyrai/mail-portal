import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("migration 0008 stores private owner-scoped reminder state and idempotency operations", () => {
	const sql = readFileSync(
		new URL("../../migrations/0008_create_follow_up_reminders.sql", import.meta.url),
		"utf8",
	);
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
	db.exec("INSERT INTO users VALUES ('user-1'), ('user-2')");
	db.exec(sql);

	const insert = db.prepare(`INSERT INTO follow_up_reminders (
		id, owner_user_id, mailbox_address, conversation_key,
		baseline_message_id, baseline_message_date, remind_at, state,
		resolution_reason, create_idempotency_key, create_fingerprint,
		create_result_json, version, created_at, updated_at, resolved_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, 1, ?, ?, NULL)`);
	insert.run("reminder-1", "user-1", "shared@wiserchat.ai", "thread-1", "message-1", 1, 2, "create-1", "fingerprint-1", "{}", 1, 1);
	insert.run("reminder-2", "user-2", "shared@wiserchat.ai", "thread-1", "message-1", 1, 2, "create-2", "fingerprint-2", "{}", 1, 1);
	assert.throws(
		() => insert.run("reminder-3", "user-1", "shared@wiserchat.ai", "thread-1", "message-2", 1, 3, "create-3", "fingerprint-3", "{}", 1, 1),
		/unique/i,
	);

	const operation = db.prepare(`INSERT INTO follow_up_reminder_operations (
		id, owner_user_id, mailbox_address, reminder_id, operation_id,
		action, payload_fingerprint, result_json, created_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
	operation.run("operation-1", "user-1", "shared@wiserchat.ai", "reminder-1", "dismiss-1", "dismiss", "fingerprint", "{}", 3);
	assert.throws(
		() => operation.run("cross-owner", "user-2", "shared@wiserchat.ai", "reminder-1", "dismiss-2", "dismiss", "fingerprint", "{}", 3),
		/foreign key/i,
	);
	assert.throws(
		() => operation.run("operation-2", "user-1", "shared@wiserchat.ai", "reminder-1", "dismiss-1", "dismiss", "fingerprint", "{}", 3),
		/unique/i,
	);

	db.prepare("DELETE FROM users WHERE id = ?").run("user-1");
	assert.equal((db.prepare("SELECT COUNT(*) AS count FROM follow_up_reminders WHERE owner_user_id = 'user-1'").get() as { count: number }).count, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS count FROM follow_up_reminder_operations WHERE owner_user_id = 'user-1'").get() as { count: number }).count, 0);
	assert.equal((db.prepare("SELECT COUNT(*) AS count FROM follow_up_reminders WHERE owner_user_id = 'user-2'").get() as { count: number }).count, 1);
	db.close();
});

test("migration 0008 does not couple personal reminders to mailbox membership rows", () => {
	const sql = readFileSync(
		new URL("../../migrations/0008_create_follow_up_reminders.sql", import.meta.url),
		"utf8",
	);
	assert.doesNotMatch(sql, /REFERENCES mailbox/i);
	assert.match(sql, /owner_user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i);
	assert.match(sql, /WHERE state = 'active'/i);
	assert.match(sql, /CHECK \(state IN \('active', 'completed', 'dismissed'\)\)/i);
});
