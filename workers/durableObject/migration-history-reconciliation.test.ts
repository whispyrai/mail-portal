import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyMigrations, mailboxMigrations } from "./migrations.ts";

function sqlStorage(database: DatabaseSync): SqlStorage {
	return {
		exec(query: string, ...bindings: unknown[]) {
			const trimmed = query.trim();
			if (
				bindings.length > 0 ||
				(/^(SELECT|PRAGMA|WITH)\b/i.test(trimmed) && !trimmed.includes(";"))
			) {
				return database.prepare(query).all(...bindings) as never;
			}
			database.exec(query);
			return [] as never;
		},
	} as SqlStorage;
}

function storage(database: DatabaseSync) {
	return {
		transactionSync<T>(closure: () => T): T {
			database.exec("BEGIN");
			try {
				const result = closure();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

function apply(database: DatabaseSync, names?: Set<string>) {
	applyMigrations(
		sqlStorage(database),
		names ? mailboxMigrations.filter((migration) => names.has(migration.name)) : mailboxMigrations,
		storage(database),
	);
}

function columns(database: DatabaseSync, table: string) {
	return database
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row) => (row as { name: string }).name);
}

const DEPLOYED_MAIN_MIGRATIONS = new Set([
	"1_initial_setup",
	"2_add_email_threading",
	"3_add_draft_folder",
	"4_add_message_id",
	"5_add_raw_headers",
	"6_mark_sent_emails_as_read",
	"7_add_cc_bcc",
	"8_add_folder_date_indexes",
	"9_add_push_subscriptions",
	"10_add_inbound_delivery_ledgers",
	"11_add_external_email_bodies",
	"12_add_r2_deletion_outbox",
	"13_add_attachment_object_key",
]);

test("exact deployed-main history upgrades without collisions or data loss", () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	apply(database, DEPLOYED_MAIN_MIGRATIONS);
	database.exec(`
		INSERT INTO emails (id, folder_id, subject, sender, recipient, date, body)
		VALUES ('email-1', 'inbox', 'Subject', 'sender@example.com',
			'team@example.com', '2026-07-16T00:00:00.000Z', 'Body');
		INSERT INTO attachments (
			id, email_id, filename, mimetype, size, content_id, disposition, r2_key
		) VALUES (
			'attachment-1', 'email-1', 'file.pdf', 'application/pdf', 3,
			NULL, 'attachment', 'attachments/email-1/attachment-1/file.pdf'
		);
		INSERT INTO inbound_terminal_failures (
			id, queue_message_id, attempts, error_code, recorded_at
		) VALUES (
			'email-terminal', 'provider-queue-message-id', 11,
			'QUEUE_RETRY_EXHAUSTED', '2026-07-16T00:00:00.000Z'
		);
		INSERT INTO email_body_objects (
			id, email_id, part_index, content_type, charset, r2_key, byte_length
		) VALUES (
			'body-1', 'email-1', 0, 'text/plain', 'utf-8',
			'email-bodies/email-1/0.body', 4
		);
		INSERT INTO r2_deletion_outbox (
			r2_key, email_id, attempts, next_attempt_at, last_error, created_at
		) VALUES (
			'orphan/key', 'email-1', 2, '2026-07-16T00:00:00.000Z',
			'legacy-error', '2026-07-15T00:00:00.000Z'
		);
	`);

	apply(database);
	apply(database);

	assert.equal(
		(database.prepare("SELECT r2_key FROM attachments WHERE id = 'attachment-1'").get() as { r2_key: string }).r2_key,
		"attachments/email-1/attachment-1/file.pdf",
	);
	assert.deepEqual(
		{ ...database.prepare(`
			SELECT attempts, state, claim_generation, lease_token, lease_expires_at,
				next_attempt_at, last_error, parked_at, recovery_ref
			FROM r2_deletion_outbox WHERE r2_key = 'orphan/key'
		`).get() },
		{
			attempts: 2,
			state: "pending",
			claim_generation: 0,
			lease_token: null,
			lease_expires_at: null,
			next_attempt_at: "2026-07-16T00:00:00.000Z",
			last_error: "legacy-error",
			parked_at: null,
			recovery_ref: null,
		},
	);
	const terminal = database.prepare(`
		SELECT queue_ref, attempts, error_code, recorded_at
		FROM inbound_terminal_failures WHERE id = 'email-terminal'
	`).get() as { queue_ref: string; attempts: number };
	assert.match(terminal.queue_ref, /^[0-9a-f]{16}$/);
	assert.equal(terminal.attempts, 11);
	assert.equal(columns(database, "inbound_terminal_failures").includes("queue_message_id"), false);
	assert.equal(
		(database.prepare("SELECT COUNT(*) AS count FROM email_body_objects WHERE id = 'body-1'").get() as { count: number }).count,
		1,
	);
	for (const name of [
		"10_add_inbound_delivery_ledgers",
		"11_add_external_email_bodies",
		"12_add_r2_deletion_outbox",
		"13_add_attachment_object_key",
		"36_add_inbound_durability",
		"37_harden_outbound_reliability",
		"38_reconcile_deployed_inbound_durability",
		"39_complete_outbound_reliability",
		"40_add_cleanup_parking",
	]) {
		assert.equal(
			(database.prepare("SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?").get(name) as { count: number }).count,
			1,
		);
	}
	database.close();
});

test("fresh migration history converges to the same final contracts", () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	apply(database);
	assert.equal(columns(database, "r2_deletion_outbox").includes("parked_at"), true);
	assert.equal(columns(database, "outbound_provider_events").includes("recipient_hashes_json"), true);
	assert.equal(columns(database, "draft_save_cleanup_intents").includes("state"), true);
	assert.equal(columns(database, "outbound_acceptance_recovery").includes("generation"), true);
	apply(database);
	database.close();
});

test("branch-local databases already through committed migration 37 upgrade safely", () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	const deployedNames = new Set([
		"10_add_inbound_delivery_ledgers",
		"11_add_external_email_bodies",
		"12_add_r2_deletion_outbox",
		"13_add_attachment_object_key",
	]);
	const through37 = new Set(
		mailboxMigrations
			.slice(0, mailboxMigrations.findIndex((migration) =>
				migration.name === "37_harden_outbound_reliability") + 1)
			.map((migration) => migration.name)
			.filter((name) => !deployedNames.has(name)),
	);
	apply(database, through37);
	assert.equal(hasMigration(database, "36_add_inbound_durability"), true);
	assert.equal(hasMigration(database, "37_harden_outbound_reliability"), true);

	apply(database);
	assert.equal(hasMigration(database, "10_add_inbound_delivery_ledgers"), true);
	assert.equal(hasMigration(database, "38_reconcile_deployed_inbound_durability"), true);
	assert.equal(columns(database, "outbound_acceptance_recovery").includes("generation"), true);
	assert.equal(columns(database, "r2_deletion_outbox").includes("recovery_ref"), true);
	database.close();
});

function hasMigration(database: DatabaseSync, name: string): boolean {
	return (database.prepare(
		"SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?",
	).get(name) as { count: number }).count === 1;
}
