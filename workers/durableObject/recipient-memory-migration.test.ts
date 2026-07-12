import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "./migrations.ts";

test("migration 18 creates idempotent mailbox-local recipient interaction storage", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "18_add_recipient_memory",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		INSERT INTO emails (id) VALUES ('legacy-before-migration');
	`);
	database.exec(migration.sql);
	assert.equal(
		(database.prepare(
			"SELECT recipient_memory_origin AS origin FROM emails WHERE id = ?",
		).get("legacy-before-migration") as { origin: string | null }).origin,
		null,
	);
	assert.throws(
		() => database.prepare(
			"UPDATE emails SET recipient_memory_origin = ? WHERE id = ?",
		).run("guessed_legacy", "legacy-before-migration"),
		/check/i,
	);
	database.prepare("INSERT INTO emails (id) VALUES (?)").run("mail-1");
	const insert = database.prepare(
		`INSERT INTO recipient_interactions
		 (source_email_id, address, direction, occurred_at)
		 VALUES (?, ?, ?, ?)`,
	);
	insert.run("mail-1", "person@example.com", "sent", "2026-07-11T10:00:00.000Z");
	assert.throws(
		() => insert.run(
			"mail-1",
			"PERSON@example.com",
			"sent",
			"2026-07-11T10:00:01.000Z",
		),
		/unique/i,
	);
	assert.throws(
		() => insert.run("mail-1", "person@example.com", "other", "now"),
		/check/i,
	);
	database.prepare(
		"INSERT INTO recipient_interaction_meta (key, value) VALUES (?, ?)",
	).run("recent_seed_v1", "1");
	assert.throws(
		() => database.prepare(
			"INSERT INTO recipient_interaction_meta (key, value) VALUES (?, ?)",
		).run("recent_seed_v1", "2"),
		/unique/i,
	);
	database.prepare("DELETE FROM emails WHERE id = 'mail-1'").run();
	assert.equal(
		(database.prepare(
			"SELECT COUNT(*) AS count FROM recipient_interactions",
		).get() as { count: number }).count,
		0,
	);
	database.close();
});
