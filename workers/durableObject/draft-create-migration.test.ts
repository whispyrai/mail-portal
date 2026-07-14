import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mailboxMigrations } from "./migrations.ts";

test("migration 19 stores one indexed authoritative replay identity per first draft create", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "19_add_draft_create_replay",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec("CREATE TABLE emails (id TEXT PRIMARY KEY)");
	database.exec(migration.sql);
	const insert = database.prepare(
		`INSERT INTO emails
		 (id, draft_create_key, draft_create_fingerprint)
		 VALUES (?, ?, ?)`,
	);
	insert.run("draft-1", "create-once", "fingerprint-1");
	assert.throws(
		() => insert.run("draft-2", "create-once", "fingerprint-2"),
		/unique/i,
	);
	database.close();
});

test("first draft insert persists its replay identity and later updates preserve it", () => {
	const source = readFileSync(
		new URL("./index.ts", import.meta.url),
		"utf8",
	);
	const updateBranch = source.slice(
		source.indexOf("if (existing) {", source.indexOf("async upsertDraft(")),
		source.indexOf("} else {", source.indexOf("async upsertDraft(")),
	);
	const insertBranch = source.slice(
		source.indexOf("} else {", source.indexOf("async upsertDraft(")),
		source.indexOf("if (attachments.length > 0)", source.indexOf("async upsertDraft(")),
	);

	assert.doesNotMatch(updateBranch, /draft_create_(?:key|fingerprint):/);
	assert.match(insertBranch, /draft_create_key: input\.createKey \?\? null/);
	assert.match(
		insertBranch,
		/draft_create_fingerprint: input\.createFingerprint \?\? null/,
	);
});

test("migration 29 backfills durable Draft creation operations from the already-unique identity", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "29_retain_draft_create_operations",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			date TEXT,
			draft_version INTEGER NOT NULL,
			draft_create_key TEXT,
			draft_create_fingerprint TEXT
		);
		CREATE UNIQUE INDEX idx_emails_draft_create_key
			ON emails(draft_create_key)
			WHERE draft_create_key IS NOT NULL;
		INSERT INTO emails VALUES
			('draft-1', 'draft', '2026-07-14T08:00:00Z', 1, 'key-1', 'fingerprint-1'),
			('moved-1', 'trash', '2026-07-14T09:00:00Z', 2, 'key-2', 'fingerprint-2');
	`);
	database.exec(migration.sql);
	assert.deepEqual(
		database.prepare(
			`SELECT create_key, draft_id, draft_version, state
			 FROM draft_create_operations ORDER BY create_key`,
		).all().map((row) => ({ ...row })),
		[
			{ create_key: "key-1", draft_id: "draft-1", draft_version: 1, state: "active" },
			{ create_key: "key-2", draft_id: "moved-1", draft_version: 2, state: "unavailable" },
		],
	);
	database.close();
});
