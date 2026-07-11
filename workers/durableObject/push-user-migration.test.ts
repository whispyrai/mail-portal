import assert from "node:assert/strict";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("migration 12 removes unowned legacy capabilities before user-scoped rebind", () => {
	const migration = mailboxMigrations.find(
		(candidate) =>
			candidate.name === "12_scope_push_subscriptions_to_users",
	);
	assert.ok(migration);
	const normalized = migration.sql.replace(/\s+/g, " ").toLowerCase();
	assert.match(
		normalized,
		/alter table push_subscriptions add column user_id text/,
	);
	assert.match(
		normalized,
		/delete from push_subscriptions where user_id is null/,
	);
	assert.match(normalized, /idx_push_subscriptions_user_id/);
});
