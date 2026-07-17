import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("migration 41 adds retained exact import source authority without depending on existing rows", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "41_add_exact_import_source_identity",
	);
	assert.ok(migration);
	const migrationIndex = mailboxMigrations.findIndex(
		(candidate) => candidate.name === migration.name,
	);
	assert.ok(migrationIndex >= 0);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		CREATE TABLE import_generation_claims (
			message_id TEXT PRIMARY KEY,
			claim_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		INSERT INTO emails VALUES ('legacy');
	`);
	db.exec(migration.sql);
	assert.equal(
		db.prepare("SELECT COUNT(*) AS count FROM import_source_identities").get()?.count,
		0,
	);
	assert.deepEqual(
		(db.prepare("PRAGMA table_info('import_generation_claims')").all() as Array<{ name: string }>)
			.map((column) => column.name).slice(-3),
		["legacy_id", "identity_source", "raw_sha256"],
	);
	const digest = "a".repeat(64);
	db.prepare(
		"INSERT INTO import_source_identities (email_id, raw_sha256, created_at) VALUES (?, ?, ?)",
	).run("source-id", digest, 1);
	db.prepare("INSERT INTO emails VALUES (?)").run("source-id");
	db.prepare("DELETE FROM emails WHERE id = ?").run("source-id");
	assert.equal(
		db.prepare("SELECT raw_sha256 FROM import_source_identities WHERE email_id = ?").get("source-id")?.raw_sha256,
		digest,
	);
	assert.throws(
		() => db.prepare(
			"INSERT INTO import_source_identities (email_id, raw_sha256, created_at) VALUES (?, ?, ?)",
		).run("bad", "A".repeat(64), 1),
		/CHECK constraint/i,
	);
	db.close();
});

test("migration 42 adds exact archive-bound inbound deletion authority", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "42_add_exact_inbound_deletion_authority",
	);
	assert.ok(migration);
	const previousMigrationIndex = mailboxMigrations.findIndex(
		(candidate) => candidate.name === "41_add_exact_import_source_identity",
	);
	assert.equal(
		mailboxMigrations.findIndex((candidate) => candidate.name === migration.name),
		previousMigrationIndex + 1,
	);
	const db = new DatabaseSync(":memory:");
	db.exec(migration.sql);
	assert.equal(
		db.prepare("SELECT COUNT(*) AS count FROM inbound_delivery_authorities").get()?.count,
		0,
	);
	const digest = "a".repeat(64);
	db.prepare(`
		INSERT INTO inbound_delivery_authorities (
			id, schema_version, raw_key, mailbox_id, raw_size, raw_sha256,
			archived_at, archive_etag, archive_version, generation, state, deleted_at
		) VALUES (?, 1, ?, ?, 321, ?, ?, ?, ?, 1, 'projected', NULL)
	`).run(
		"inbound-id",
		"raw/2026/07/17/inbound-id.eml",
		"hello@wiserchat.ai",
		digest,
		"2026-07-17T09:00:00.000Z",
		"archive-etag",
		"archive-version",
	);
	assert.throws(
		() => db.prepare(`
			UPDATE inbound_delivery_authorities
			SET state = 'deleted', generation = 2
			WHERE id = ?
		`).run("inbound-id"),
		/CHECK constraint/i,
	);
	db.prepare(`
		UPDATE inbound_delivery_authorities
		SET state = 'deleted', generation = 2, deleted_at = ?
		WHERE id = ?
	`).run("2026-07-17T10:00:00.000Z", "inbound-id");
	const deleted = db.prepare(`
		SELECT generation, state, deleted_at
		FROM inbound_delivery_authorities
		WHERE id = ?
	`).get("inbound-id");
	assert.equal(deleted?.generation, 2);
	assert.equal(deleted?.state, "deleted");
	assert.equal(deleted?.deleted_at, "2026-07-17T10:00:00.000Z");
	db.close();
});

test("migration 43 adds a separate exact direct-inbound authority with no legacy backfill", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "43_add_direct_inbound_delivery_authority",
	);
	assert.ok(migration);
	const previousMigrationIndex = mailboxMigrations.findIndex(
		(candidate) => candidate.name === "42_add_exact_inbound_deletion_authority",
	);
	assert.equal(
		mailboxMigrations.findIndex((candidate) => candidate.name === migration.name),
		previousMigrationIndex + 1,
	);
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE inbound_delivery_authorities (id TEXT PRIMARY KEY)");
	db.prepare("INSERT INTO inbound_delivery_authorities VALUES (?)").run("archive-only");
	db.exec(migration.sql);
	assert.equal(
		db.prepare("SELECT COUNT(*) AS count FROM direct_inbound_delivery_authorities").get()?.count,
		0,
	);
	assert.equal(
		db.prepare("SELECT COUNT(*) AS count FROM inbound_delivery_authorities").get()?.count,
		1,
	);
	db.prepare(`
		INSERT INTO direct_inbound_delivery_authorities (
			id, schema_version, mailbox_id, raw_size, raw_sha256, received_at,
			generation, state, deleted_at
		) VALUES (?, 1, ?, 321, ?, ?, 1, 'projected', NULL)
	`).run(
		"direct-id",
		"hello@wiserchat.ai",
		"a".repeat(64),
		"2026-07-17T09:00:00.000Z",
	);
	assert.throws(
		() => db.prepare(`
			UPDATE direct_inbound_delivery_authorities
			SET state = 'deleted', generation = 2
			WHERE id = ?
		`).run("direct-id"),
		/CHECK constraint/i,
	);
	db.prepare(`
		UPDATE direct_inbound_delivery_authorities
		SET state = 'deleted', generation = 2, deleted_at = ?
		WHERE id = ?
	`).run("2026-07-17T10:00:00.000Z", "direct-id");
	assert.equal(
		db.prepare("SELECT state FROM direct_inbound_delivery_authorities WHERE id = ?")
			.get("direct-id")?.state,
		"deleted",
	);
	db.close();
});
