import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "./migrations.ts";

test("migration 15 upgrades an existing mailbox without touching mail", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "15_add_mailbox_labels",
	);
	assert.ok(migration);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (id TEXT PRIMARY KEY);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE
		);
		INSERT INTO folders VALUES ('inbox');
		INSERT INTO emails VALUES ('email-1', 'inbox');
	`);
	db.exec(migration.sql);
	db.prepare(
		"INSERT INTO labels VALUES (?, ?, ?, ?, ?, ?)",
	).run("label-1", "Waiting", "waiting", "blue", "now", "now");
	db.prepare(
		"INSERT INTO email_labels VALUES (?, ?, ?)",
	).run("email-1", "label-1", "now");
	assert.equal(
		(db.prepare("SELECT COUNT(*) AS count FROM emails").get() as { count: number }).count,
		1,
	);
	assert.throws(
		() => db.prepare(
			"INSERT INTO labels VALUES (?, ?, ?, ?, ?, ?)",
		).run("label-2", "WAITING", "waiting", "red", "now", "now"),
		/unique/i,
	);
	db.prepare("DELETE FROM labels WHERE id = ?").run("label-1");
	assert.equal(
		(db.prepare("SELECT COUNT(*) AS count FROM email_labels").get() as { count: number }).count,
		0,
	);
	assert.equal(
		(db.prepare("SELECT COUNT(*) AS count FROM emails").get() as { count: number }).count,
		1,
	);
	db.close();
});

test("migration 15 constrains persisted color tokens", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "15_add_mailbox_labels",
	);
	assert.ok(migration);
	assert.match(migration.sql, /CHECK \(color IN \(/);
});
