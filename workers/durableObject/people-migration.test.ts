import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

test("migration 24 preserves mail and installs the mailbox-local People projection schema without backfilling", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "24_add_mail_people_projection",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			date TEXT,
			sender TEXT,
			recipient TEXT,
			cc TEXT,
			bcc TEXT,
			thread_id TEXT,
			folder_id TEXT,
			recipient_memory_origin TEXT
		);
		INSERT INTO emails (
			id, date, sender, recipient, thread_id, folder_id, recipient_memory_origin
		) VALUES (
			'existing-message', '2026-07-12T10:00:00.000Z', 'person@example.com',
			'team@example.com', 'conversation-1', 'inbox', 'live_inbound'
		);
	`);
	database.exec(migration.sql);

	assert.deepEqual(
		plain(database.prepare("SELECT id, sender_name FROM emails").all()),
		[{ id: "existing-message", sender_name: null }],
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM mail_people").get()?.total,
		0,
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total,
		0,
	);
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM people_projection_state").get()?.total,
		0,
	);

	const indexes = database.prepare(`
		SELECT name FROM sqlite_master
		WHERE type = 'index' AND name IN (
			'idx_emails_people_backfill',
			'idx_mail_participants_person_time',
			'idx_mail_participants_conversation_person',
			'idx_mail_people_domain_address'
		)
		ORDER BY name
	`).all();
	assert.deepEqual(plain(indexes), [
		{ name: "idx_emails_people_backfill" },
		{ name: "idx_mail_participants_conversation_person" },
		{ name: "idx_mail_participants_person_time" },
		{ name: "idx_mail_people_domain_address" },
	]);

	database.prepare(`
		INSERT INTO mail_people (id, address, domain, created_at)
		VALUES (?, ?, ?, ?)
	`).run("person-1", "person@example.com", "example.com", "2026-07-12T10:00:00.000Z");
	database.prepare(`
		INSERT INTO mail_message_participants (
			source_email_id, person_id, role, direction, occurred_at,
			conversation_id, origin, observed_name
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		"existing-message",
		"person-1",
		"from",
		"received",
		"2026-07-12T10:00:00.000Z",
		"conversation-1",
		"live_inbound",
		"Person",
	);
	assert.throws(
		() => database.prepare(`
			INSERT INTO mail_message_participants (
				source_email_id, person_id, role, direction, occurred_at,
				conversation_id, origin
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`).run(
			"existing-message",
			"person-1",
			"reply-to",
			"received",
			"2026-07-12T10:00:00.000Z",
			"conversation-1",
			"live_inbound",
		),
		/check/i,
	);
	database.prepare("DELETE FROM emails WHERE id = ?").run("existing-message");
	assert.equal(
		database.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total,
		0,
	);
	database.close();
});
