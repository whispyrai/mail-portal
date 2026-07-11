import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "./migrations.ts";

test("migration 11 creates the truthful outbox storage contract", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "11_add_truthful_outbox_storage",
	);
	assert.ok(migration);
	const normalized = migration.sql.replace(/\s+/g, " ").toLowerCase();

	assert.match(normalized, /create table _outbox_folder_map/);
	assert.match(normalized, /update emails set folder_id =/);
	assert.match(normalized, /where folder_id = 'outbox'/);
	assert.match(normalized, /update folders set name = .* where name = 'outbox'/);
	assert.match(normalized, /on conflict\(id\) do update set/);
	assert.match(normalized, /is_deletable = 0/);
	assert.match(normalized, /alter table emails add column draft_version integer not null default 1/);
	assert.match(normalized, /create table outbound_deliveries/);
	assert.match(normalized, /email_id text not null unique/);
	assert.match(normalized, /idempotency_key text not null unique/);
	assert.match(
		normalized,
		/foreign key\(email_id\) references emails\(id\) on delete restrict/,
	);
	assert.match(normalized, /create table outbound_delivery_attempts/);
	assert.match(
		normalized,
		/unique\(delivery_id, attempt_number\)/,
	);
	assert.match(normalized, /idx_outbound_deliveries_status_available/);
	assert.match(normalized, /idx_outbound_deliveries_status_next_attempt/);
});

test("migration 11 preserves custom Outbox ID and name collisions with their messages", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "11_add_truthful_outbox_storage",
	);
	assert.ok(migration);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			is_deletable INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
			raw_headers TEXT
		);
		INSERT INTO folders VALUES
			('outbox', 'User Queue', 1),
			('custom-name', 'Outbox', 1);
		INSERT INTO emails VALUES
			('email-by-id', 'outbox', NULL),
			('email-by-name', 'custom-name', NULL);
	`);
	db.exec(migration.sql);

	assert.deepEqual(
		{ ...db.prepare("SELECT name, is_deletable FROM folders WHERE id = ?")
			.get("outbox") },
		{ name: "Outbox", is_deletable: 0 },
	);
	const idCollision = db.prepare(
		`SELECT f.id, f.name, f.is_deletable
		 FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-id'`,
	).get() as { id: string; name: string; is_deletable: number };
	assert.match(idCollision.id, /^outbox_legacy_/);
	assert.match(idCollision.name, /^User Queue \(Legacy /);
	assert.equal(idCollision.is_deletable, 1);
	const nameCollision = db.prepare(
		`SELECT f.name FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-name'`,
	).get() as { name: string };
	assert.match(nameCollision.name, /^Outbox \(Legacy /);
	db.close();
});

test("migration 14 creates a protected storage home for retired outbound snapshots", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "14_add_retired_outbound_folder",
	);
	assert.ok(migration);
	const normalized = migration.sql.replace(/\s+/g, " ").toLowerCase();
	assert.match(normalized, /insert into folders/);
	assert.match(normalized, /'_cancelled_outbound'/);
	assert.match(normalized, /is_deletable\) values \('_cancelled_outbound', 'retired outbound snapshots', 0\)/);
	assert.match(normalized, /create table _retired_outbound_folder_map/);
	assert.match(normalized, /update emails set folder_id =/);
	assert.match(normalized, /where folder_id = '_cancelled_outbound'/);
	assert.match(normalized, /retired outbound snapshots \(legacy/);
});

test("migration 14 preserves custom folder ID and name collisions with their messages", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "14_add_retired_outbound_folder",
	);
	assert.ok(migration);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL UNIQUE,
			is_deletable INTEGER NOT NULL DEFAULT 1
		);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL REFERENCES folders(id)
		);
		INSERT INTO folders VALUES
			('_cancelled_outbound', 'User Folder', 1),
			('custom-name', 'Retired Outbound Snapshots', 1);
		INSERT INTO emails VALUES
			('email-by-id', '_cancelled_outbound'),
			('email-by-name', 'custom-name');
	`);
	db.exec(migration.sql);

	assert.deepEqual(
		{ ...db.prepare("SELECT name, is_deletable FROM folders WHERE id = ?")
			.get("_cancelled_outbound") },
		{ name: "Retired Outbound Snapshots", is_deletable: 0 },
	);
	const idCollision = db.prepare(
		`SELECT f.id, f.name, f.is_deletable
		 FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-id'`,
	).get() as { id: string; name: string; is_deletable: number };
	assert.match(idCollision.id, /^_cancelled_outbound_legacy_/);
	assert.match(idCollision.name, /^User Folder \(Legacy /);
	assert.equal(idCollision.is_deletable, 1);
	const nameCollision = db.prepare(
		`SELECT f.name FROM emails e JOIN folders f ON f.id = e.folder_id
		 WHERE e.id = 'email-by-name'`,
	).get() as { name: string };
	assert.match(nameCollision.name, /^Retired Outbound Snapshots \(Legacy /);
	db.close();
});
