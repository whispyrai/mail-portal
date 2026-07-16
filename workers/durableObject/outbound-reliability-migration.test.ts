import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mailboxMigrations } from "./migrations.ts";

function migration37() {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "37_harden_outbound_reliability",
	);
	assert.ok(migration);
	return migration;
}

function legacyDatabase(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE outbound_deliveries (
			id TEXT PRIMARY KEY,
			idempotency_key TEXT NOT NULL UNIQUE
		);
		CREATE TABLE outbound_delivery_attempts (
			id TEXT PRIMARY KEY,
			delivery_id TEXT NOT NULL,
			attempt_number INTEGER NOT NULL,
			FOREIGN KEY(delivery_id) REFERENCES outbound_deliveries(id) ON DELETE CASCADE
		);
		INSERT INTO outbound_deliveries VALUES ('delivery-legacy', 'key-legacy');
		INSERT INTO outbound_delivery_attempts VALUES ('attempt-legacy', 'delivery-legacy', 1);
	`);
	return db;
}

test("migration 37 preserves legacy rows with safe reliability defaults", () => {
	const db = legacyDatabase();
	db.exec(migration37().sql);

	assert.deepEqual(
		{ ...db.prepare(`
			SELECT command_fingerprint, preflight_deferral_count, dispatch_phase,
				active_attempt_id, accepted_attempt_count, duplicate_acceptance_at
			FROM outbound_deliveries WHERE id = 'delivery-legacy'
		`).get() },
		{
			command_fingerprint: null,
			preflight_deferral_count: 0,
			dispatch_phase: null,
			active_attempt_id: null,
			accepted_attempt_count: 0,
			duplicate_acceptance_at: null,
		},
	);
	assert.deepEqual(
		{ ...db.prepare(`
			SELECT provider_state, provider_event_at, provider_event_id
			FROM outbound_delivery_attempts WHERE id = 'attempt-legacy'
		`).get() },
		{
			provider_state: "none",
			provider_event_at: null,
			provider_event_id: null,
		},
	);
	db.close();
});

test("migration 37 creates a content-free attempt-scoped provider event ledger", () => {
	const db = legacyDatabase();
	db.exec(migration37().sql);
	const columns = db
		.prepare("PRAGMA table_info(outbound_provider_events)")
		.all()
		.map((row) => (row as { name: string }).name);
	assert.deepEqual(columns, [
		"id",
		"attempt_id",
		"ses_message_id",
		"event_class",
		"occurred_at",
		"received_at",
	]);

	db.prepare(`
		INSERT INTO outbound_provider_events
			(id, attempt_id, ses_message_id, event_class, occurred_at, received_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`).run(
		"event-1",
		"attempt-legacy",
		"ses-1",
		"delivery",
		"2026-07-16T01:00:00.000Z",
		"2026-07-16T01:00:01.000Z",
	);
	assert.throws(
		() =>
			db.prepare(`
				INSERT INTO outbound_provider_events
					(id, attempt_id, ses_message_id, event_class, occurred_at, received_at)
				VALUES ('event-1', 'attempt-legacy', 'ses-1', 'delivery', 'now', 'now')
			`).run(),
		/UNIQUE constraint failed/,
	);
	assert.throws(
		() =>
			db.prepare(`
				INSERT INTO outbound_provider_events
					(id, attempt_id, ses_message_id, event_class, occurred_at, received_at)
				VALUES ('event-2', 'missing-attempt', 'ses-2', 'bounce', 'now', 'now')
			`).run(),
		/FOREIGN KEY constraint failed/,
	);
	db.close();
});

test("migration 37 rolls back added columns when ledger creation fails", () => {
	const db = legacyDatabase();
	db.exec("CREATE TABLE outbound_provider_events (id TEXT PRIMARY KEY)");
	assert.throws(() => db.exec(migration37().sql), /already exists/);
	db.exec("ROLLBACK");
	const deliveryColumns = db
		.prepare("PRAGMA table_info(outbound_deliveries)")
		.all()
		.map((row) => (row as { name: string }).name);
	assert.equal(deliveryColumns.includes("command_fingerprint"), false);
	db.close();
});
