import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "./migrations.ts";

test("migration 16 adds protected Snoozed state and a durable reply wake queue", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "16_add_mailbox_snooze",
	);
	assert.ok(migration);
	assert.match(migration.sql, /VALUES \('snoozed', 'Snoozed', 0\)/);
	assert.match(migration.sql, /ADD COLUMN snooze_source_folder_id TEXT/);
	assert.match(migration.sql, /ADD COLUMN snoozed_until TEXT/);
	assert.match(migration.sql, /CREATE INDEX idx_emails_snoozed_until/);
	assert.match(migration.sql, /CREATE TABLE snooze_reply_wake_queue/);
	assert.match(migration.sql, /thread_id TEXT PRIMARY KEY/);
});

test("migration 16 preserves custom Snoozed ID and name collisions with linked mail", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "16_add_mailbox_snooze",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			is_deletable INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
			previous_folder_id TEXT
		);
		INSERT INTO folders VALUES
			('snoozed', 'User Waiting Room', 1),
			('custom-name', 'Snoozed', 1),
			('inbox', 'Inbox', 0);
		INSERT INTO emails VALUES
			('email-by-id', 'snoozed', NULL),
			('email-by-name', 'custom-name', NULL),
			('trashed-from-collision', 'inbox', 'snoozed');
	`);
	database.exec(migration.sql);

	assert.deepEqual(
		{ ...database.prepare(
			"SELECT name, is_deletable FROM folders WHERE id = 'snoozed'",
		).get() },
		{ name: "Snoozed", is_deletable: 0 },
	);
	const idCollision = database.prepare(
		`SELECT f.id, f.name, f.is_deletable
		 FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-id'`,
	).get() as { id: string; name: string; is_deletable: number };
	assert.match(idCollision.id, /^snoozed_legacy_/);
	assert.match(idCollision.name, /^User Waiting Room \(Legacy /);
	assert.equal(idCollision.is_deletable, 1);
	assert.equal(
		(database.prepare(
			"SELECT previous_folder_id FROM emails WHERE id = 'trashed-from-collision'",
		).get() as { previous_folder_id: string }).previous_folder_id,
		idCollision.id,
	);
	const nameCollision = database.prepare(
		`SELECT f.id, f.name
		 FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-name'`,
	).get() as { id: string; name: string };
	assert.equal(nameCollision.id, "custom-name");
	assert.match(nameCollision.name, /^Snoozed \(Legacy /);
	assert.deepEqual(
		{ ...database.prepare(
			"SELECT snooze_source_folder_id, snoozed_until FROM emails WHERE id = 'email-by-id'",
		).get() },
		{ snooze_source_folder_id: null, snoozed_until: null },
	);
	database.close();
});
