import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { draftUpdateOperations } from "../db/schema.ts";
import { mailboxMigrations } from "./migrations.ts";

test("Draft update operations retain immutable content-free command results", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "34_add_draft_update_operations",
	);
	assert.ok(migration);
	assert.match(migration.sql, /CREATE TABLE draft_update_operations/);
	assert.match(migration.sql, /update_key TEXT PRIMARY KEY/);
	assert.match(migration.sql, /fingerprint TEXT NOT NULL/);
	assert.match(migration.sql, /previous_version INTEGER NOT NULL/);
	assert.match(migration.sql, /result_version INTEGER NOT NULL/);
	assert.match(migration.sql, /result_version = previous_version \+ 1/);
	assert.match(migration.sql, /idx_draft_update_operations_result/);
	assert.doesNotMatch(
		migration.sql,
		/(recipient|subject|body|attachment|actor|user_id)/i,
	);
	assert.deepEqual(
		getTableConfig(draftUpdateOperations).checks.map((constraint) => constraint.name),
		[
			"draft_update_operations_previous_version_check",
			"draft_update_operations_result_version_check",
		],
	);
});
