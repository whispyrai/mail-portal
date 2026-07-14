import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("Draft save operations durably own one revision and its destination plan", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "30_add_draft_save_operations",
	);
	assert.ok(migration);
	assert.match(migration.sql, /CREATE TABLE draft_save_operations/);
	assert.match(migration.sql, /save_key TEXT PRIMARY KEY/);
	assert.match(migration.sql, /fingerprint TEXT NOT NULL/);
	assert.match(migration.sql, /expected_version INTEGER NOT NULL/);
	assert.match(migration.sql, /destination_keys TEXT NOT NULL/);
	assert.match(migration.sql, /claim_expires_at INTEGER NOT NULL/);
	assert.match(migration.sql, /idx_draft_save_operations_revision/);
	const tokenMigration = mailboxMigrations.find(
		(item) => item.name === "31_add_draft_save_claim_token",
	);
	assert.ok(tokenMigration);
	assert.match(
		tokenMigration.sql,
		/ALTER TABLE draft_save_operations ADD COLUMN claim_token TEXT/,
	);
	const retentionMigration = mailboxMigrations.find(
		(item) => item.name === "32_index_draft_save_retention",
	);
	assert.ok(retentionMigration);
	assert.match(
		retentionMigration.sql,
		/ON draft_save_operations\(updated_at, save_key\)[\s\S]*WHERE state IN \('committed', 'aborted'\)/,
	);
	const cleanupMigration = mailboxMigrations.find(
		(item) => item.name === "33_add_draft_save_cleanup_intents",
	);
	assert.ok(cleanupMigration);
	assert.match(cleanupMigration.sql, /CREATE TABLE draft_save_cleanup_intents/);
	assert.match(cleanupMigration.sql, /claim_token TEXT PRIMARY KEY/);
	assert.match(cleanupMigration.sql, /verify_until INTEGER NOT NULL/);
	assert.match(cleanupMigration.sql, /idx_draft_save_cleanup_due/);
});

test("Draft save retention pruning uses the terminal-state ordered index", () => {
	const database = new DatabaseSync(":memory:");
	const tableMigration = mailboxMigrations.find(
		(item) => item.name === "30_add_draft_save_operations",
	);
	const retentionMigration = mailboxMigrations.find(
		(item) => item.name === "32_index_draft_save_retention",
	);
	assert.ok(tableMigration);
	assert.ok(retentionMigration);
	database.exec(tableMigration.sql);
	database.exec(retentionMigration.sql);

	const plan = database
		.prepare(
			`EXPLAIN QUERY PLAN
			 DELETE FROM draft_save_operations
			 WHERE save_key IN (
				SELECT save_key
				FROM draft_save_operations
				WHERE state IN ('committed', 'aborted')
				  AND updated_at <= ?
				ORDER BY updated_at, save_key
				LIMIT ?
			 )`,
		)
		.all("2026-06-14T00:00:00.000Z", 100) as Array<{ detail: string }>;
	const details = plan.map((row) => row.detail).join("\n");

	assert.match(details, /idx_draft_save_operations_retention/);
	assert.doesNotMatch(details, /USE TEMP B-TREE/);
	database.close();
});
