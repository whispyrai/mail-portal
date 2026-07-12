import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("migration 21 indexes exact email-to-attachment paging without changing rows", () => {
	const migration = mailboxMigrations.find((candidate) => candidate.name === "21_index_mailbox_attachments");
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE attachments (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL,
			filename TEXT NOT NULL,
			mimetype TEXT NOT NULL,
			size INTEGER NOT NULL
		);
		INSERT INTO attachments VALUES ('a1', 'mail-1', 'proposal.pdf', 'application/pdf', 42);
	`);
	database.exec(migration.sql);
	const indexes = database.prepare("PRAGMA index_list('attachments')").all() as Array<{ name: string }>;
	assert.equal(indexes.some((index) => index.name === "idx_attachments_email_id_id"), true);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM attachments").get()?.total, 1);
	database.close();
});

test("migration 22 adds durable expiring import claims", () => {
	const migration = mailboxMigrations.find((candidate) => candidate.name === "22_add_import_generation_claims");
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(migration.sql);
	const columns = database.prepare("PRAGMA table_info('import_generation_claims')").all() as Array<{ name: string }>;
	assert.deepEqual(columns.map((column) => column.name), [
		"message_id", "claim_token", "expires_at", "created_at",
	]);
	const indexes = database.prepare("PRAGMA index_list('import_generation_claims')").all() as Array<{ name: string }>;
	assert.equal(indexes.some((index) => index.name === "idx_import_generation_claims_expiry"), true);
	database.close();
});
