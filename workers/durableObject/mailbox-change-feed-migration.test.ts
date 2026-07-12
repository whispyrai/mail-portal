import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function plain(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

test("migration 23 preserves rows and installs exact atomic coverage for all seven resources", () => {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "23_add_mailbox_change_feed",
	);
	assert.ok(migration);
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		CREATE TABLE attachments (id TEXT PRIMARY KEY, email_id TEXT NOT NULL);
		CREATE TABLE folders (id TEXT PRIMARY KEY);
		CREATE TABLE labels (id TEXT PRIMARY KEY);
		CREATE TABLE email_labels (email_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY(email_id, label_id));
		CREATE TABLE outbound_deliveries (id TEXT PRIMARY KEY, email_id TEXT NOT NULL);
		CREATE TABLE outbound_delivery_attempts (id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL);
		INSERT INTO emails VALUES ('existing-message');
	`);
	database.exec(migration.sql);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM emails").get()?.total, 1);
	assert.deepEqual(
		plain(database.prepare("PRAGMA table_info('mailbox_changes')").all()),
		[
			{ cid: 0, name: "sequence", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
			{ cid: 1, name: "schema_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 2, name: "committed_at", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 3, name: "resource", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 4, name: "entity_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
			{ cid: 5, name: "parent_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
			{ cid: 6, name: "operation", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
		],
	);
	assert.equal(
		database.prepare(
			"SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'mailbox_changes_%'",
		).get()?.total,
		21,
	);

	database.exec(`
		INSERT INTO folders VALUES ('inbox');
		UPDATE folders SET id = 'archive' WHERE id = 'inbox';
		DELETE FROM folders WHERE id = 'archive';
		INSERT INTO emails VALUES ('message-1');
		UPDATE emails SET id = 'message-2' WHERE id = 'message-1';
		DELETE FROM emails WHERE id = 'message-2';
		INSERT INTO attachments VALUES ('attachment-1', 'existing-message');
		UPDATE attachments SET email_id = 'message-parent-2' WHERE id = 'attachment-1';
		DELETE FROM attachments WHERE id = 'attachment-1';
		INSERT INTO labels VALUES ('label-1');
		UPDATE labels SET id = 'label-2' WHERE id = 'label-1';
		DELETE FROM labels WHERE id = 'label-2';
		INSERT INTO email_labels VALUES ('existing-message', 'label-3');
		UPDATE email_labels SET label_id = 'label-4' WHERE email_id = 'existing-message';
		DELETE FROM email_labels WHERE email_id = 'existing-message';
		INSERT INTO outbound_deliveries VALUES ('delivery-1', 'existing-message');
		UPDATE outbound_deliveries SET email_id = 'message-parent-3' WHERE id = 'delivery-1';
		DELETE FROM outbound_deliveries WHERE id = 'delivery-1';
		INSERT INTO outbound_delivery_attempts VALUES ('attempt-1', 'delivery-2');
		UPDATE outbound_delivery_attempts SET delivery_id = 'delivery-3' WHERE id = 'attempt-1';
		DELETE FROM outbound_delivery_attempts WHERE id = 'attempt-1';
	`);
	assert.deepEqual(
		plain(database.prepare(`
			SELECT resource, operation, COUNT(*) AS total
			FROM mailbox_changes
			GROUP BY resource, operation
			ORDER BY resource, operation
		`).all()),
		[
			{ resource: "attachment", operation: "created", total: 1 },
			{ resource: "attachment", operation: "deleted", total: 1 },
			{ resource: "attachment", operation: "updated", total: 1 },
			{ resource: "delivery", operation: "created", total: 1 },
			{ resource: "delivery", operation: "deleted", total: 1 },
			{ resource: "delivery", operation: "updated", total: 1 },
			{ resource: "delivery_attempt", operation: "created", total: 1 },
			{ resource: "delivery_attempt", operation: "deleted", total: 1 },
			{ resource: "delivery_attempt", operation: "updated", total: 1 },
			{ resource: "folder", operation: "created", total: 1 },
			{ resource: "folder", operation: "deleted", total: 1 },
			{ resource: "folder", operation: "updated", total: 1 },
			{ resource: "label", operation: "created", total: 1 },
			{ resource: "label", operation: "deleted", total: 1 },
			{ resource: "label", operation: "updated", total: 1 },
			{ resource: "message", operation: "created", total: 1 },
			{ resource: "message", operation: "deleted", total: 1 },
			{ resource: "message", operation: "updated", total: 1 },
			{ resource: "message_label", operation: "created", total: 1 },
			{ resource: "message_label", operation: "deleted", total: 1 },
			{ resource: "message_label", operation: "updated", total: 1 },
		],
	);
	assert.deepEqual(
		plain(database.prepare("SELECT sequence FROM mailbox_changes ORDER BY sequence").all()),
		Array.from({ length: 21 }, (_, index) => ({ sequence: index + 1 })),
	);
	assert.deepEqual(
		plain(database.prepare(`
			SELECT entity_id, parent_id FROM mailbox_changes
			WHERE resource = 'message_label' AND operation = 'updated'
		`).get()),
		{ entity_id: "existing-message:label-4", parent_id: "existing-message" },
	);
	const beforeRollback = database.prepare("SELECT COUNT(*) AS total FROM mailbox_changes").get()?.total;
	database.exec("BEGIN; INSERT INTO emails VALUES ('rolled-back'); ROLLBACK;");
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM mailbox_changes").get()?.total, beforeRollback);
	database.close();
});
