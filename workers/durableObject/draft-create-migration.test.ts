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
