import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function migrateThrough25(database: DatabaseSync) {
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) {
		if (migration.name === "26_add_inbound_automation_rules") break;
		database.exec(migration.sql);
	}
}

test("migration 26 preserves the change-feed sequence and installs closed Automation storage", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough25(database);
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'Existing', 'sender@example.com', 'team@example.com', ?, '')
	`).run("existing-message", "2026-07-12T10:00:00.000Z");
	const oldMaximum = Number(database.prepare(
		"SELECT MAX(sequence) AS maximum FROM mailbox_changes",
	).get()?.maximum);

	const migration = mailboxMigrations.find(
		(item) => item.name === "26_add_inbound_automation_rules",
	);
	assert.ok(migration);
	database.exec(migration.sql);
	assert.equal(
		Number(database.prepare("SELECT MAX(sequence) AS maximum FROM mailbox_changes").get()?.maximum),
		oldMaximum,
	);
	const tables = database.prepare(`
		SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'automation_%'
		ORDER BY name
	`).all().map((row) => row.name);
	assert.deepEqual(tables, [
		"automation_rule_folder_refs",
		"automation_rule_label_refs",
		"automation_rule_state",
		"automation_rule_tests",
		"automation_rule_versions",
		"automation_rules",
		"automation_run_folder_refs",
		"automation_run_label_refs",
		"automation_run_results",
		"automation_run_rules",
		"automation_runs",
	]);

	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body)
		VALUES (?, 'inbox', 'New', 'sender@example.com', 'team@example.com', ?, '')
	`).run("new-message", "2026-07-12T11:00:00.000Z");
	const next = database.prepare(
		"SELECT sequence, resource, entity_id AS entityId FROM mailbox_changes ORDER BY sequence DESC LIMIT 1",
	).get();
	assert.deepEqual(JSON.parse(JSON.stringify(next)), {
		sequence: oldMaximum + 1,
		resource: "message",
		entityId: "new-message",
	});

	assert.throws(() => database.prepare(`
		INSERT INTO mailbox_changes(schema_version, committed_at, resource, entity_id, operation)
		VALUES (1, ?, 'webhook', 'external', 'created')
	`).run("2026-07-12T11:00:00.000Z"));
	database.close();
});

test("migration 26 reference rows require exact versions and block only current or pending targets", () => {
	const database = new DatabaseSync(":memory:");
	migrateThrough25(database);
	const migration = mailboxMigrations.find(
		(item) => item.name === "26_add_inbound_automation_rules",
	);
	assert.ok(migration);
	database.exec(migration.sql);
	database.exec(`
		INSERT INTO labels(id, name, normalized_name, color, created_at, updated_at)
		VALUES ('label-finance', 'Finance', 'finance', 'blue', '2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z');
		INSERT INTO automation_rules(
		 id, name, normalized_name, state, draft_version, next_version, position,
		 revision, created_by, created_at, updated_by, updated_at
		) VALUES (
		 'rule-1', 'Finance', 'finance', 'draft', 1, 2, 0, 1,
		 'user-1', '2026-07-12T10:00:00.000Z', 'user-1', '2026-07-12T10:00:00.000Z'
		);
		INSERT INTO automation_rule_versions(
		 rule_id, version, schema_version, definition_json, definition_fingerprint, created_by, created_at
		) VALUES ('rule-1', 1, 1, '{}', 'fingerprint', 'user-1', '2026-07-12T10:00:00.000Z');
	`);
	assert.throws(() => database.prepare(`
		INSERT INTO automation_rule_label_refs(rule_id, version, label_id) VALUES (?, ?, ?)
	`).run("rule-1", 2, "label-finance"));
	database.prepare(`
		INSERT INTO automation_rule_label_refs(rule_id, version, label_id) VALUES (?, ?, ?)
	`).run("rule-1", 1, "label-finance");
	assert.throws(() => database.prepare("DELETE FROM labels WHERE id = ?").run("label-finance"));
	database.prepare("DELETE FROM automation_rule_label_refs WHERE rule_id = ?").run("rule-1");
	database.prepare("DELETE FROM labels WHERE id = ?").run("label-finance");
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get()?.count, 0);
	database.close();
});

test("Drizzle mirrors migration 26 closed states, composite references, and feed resources", () => {
	const source = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
	assert.match(source, /automation_rules_state_closed/);
	assert.match(source, /automation_runs_state_closed/);
	assert.match(source, /columns: \[table\.rule_id, table\.version\][\s\S]*?automationRuleVersions\.rule_id/);
	assert.match(source, /"automation_rule"/);
	assert.match(source, /"automation_run"/);
});
