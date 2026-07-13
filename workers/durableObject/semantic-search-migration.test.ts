import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function migrateThrough26(database: DatabaseSync) {
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) {
		if (migration.name === "27_add_semantic_message_projection") break;
		database.exec(migration.sql);
	}
}

test("migration 27 installs a rebuildable FTS5 projection and opaque vector outbox", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough26(database);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "27_add_semantic_message_projection",
	);
	assert.ok(migration);
	database.exec(migration.sql);

	const tables = database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'table' AND name LIKE 'semantic_%'
		ORDER BY name
	`).all().map((row) => row.name);
	assert.deepEqual(tables.filter((name) => !String(name).startsWith("semantic_chunks_fts_")), [
		"semantic_chunks",
		"semantic_chunks_fts",
		"semantic_index_jobs",
		"semantic_message_versions",
		"semantic_projection_state",
		"semantic_sources",
	]);

	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Keys', 'sam@example.com', 'team@example.com', ?, ?)
	`).run("message-1", "2026-07-13T08:00:00.000Z", "Office keys arrive Tuesday");
	database.prepare(`
		INSERT INTO semantic_sources(
			source_id, message_id, source_fingerprint, source_sequence,
			folder_id, created_at, updated_at
		) VALUES (?, ?, ?, 1, 'inbox', ?, ?)
	`).run("0123456789abcdef0123456789abcdef", "message-1", "fingerprint", "now", "now");
	database.prepare(`
		INSERT INTO semantic_chunks(
			vector_id, source_id, message_id, source_fingerprint, ordinal, content, created_at
		) VALUES (?, ?, ?, ?, 0, ?, ?)
	`).run(
		"sm1_0123456789abcdef0123456789abcdef_00",
		"0123456789abcdef0123456789abcdef",
		"message-1",
		"fingerprint",
		"Office keys arrive Tuesday",
		"now",
	);
	assert.equal(
		database.prepare("SELECT operation FROM semantic_index_jobs").get()?.operation,
		"upsert",
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks_fts WHERE semantic_chunks_fts MATCH 'Tuesday'").get()?.total,
		1,
	);

	database.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = ?").run("message-1");
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks").get()?.total, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_chunks_fts").get()?.total, 0);
	assert.equal(
		database.prepare("SELECT operation FROM semantic_index_jobs").get()?.operation,
		"delete",
	);
	database.close();
});

test("migration 27 has no constraint dependency on existing Message rows", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough26(database);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Existing', 'sender@example.com', 'team@example.com', ?, '')
	`).run("existing-message", "2026-07-13T07:00:00.000Z");
	const before = Number(database.prepare("SELECT COUNT(*) AS total FROM emails").get()?.total);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "27_add_semantic_message_projection",
	);
	assert.ok(migration);
	database.exec(migration.sql);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM emails").get()?.total, before);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM semantic_sources").get()?.total, 0);
	database.close();
});
