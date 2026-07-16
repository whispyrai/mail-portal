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

function migration39() {
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "39_complete_outbound_reliability",
	);
	assert.ok(migration);
	return migration;
}

function applyOutboundReliability(db: DatabaseSync) {
	db.exec(migration37().sql);
	db.exec(migration39().sql);
}

function legacyDatabase(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE outbound_deliveries (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL,
			source_draft_id TEXT,
			source_draft_version INTEGER,
			idempotency_key TEXT NOT NULL UNIQUE
			,actor_kind TEXT NOT NULL,
			actor_id TEXT,
			status TEXT NOT NULL,
			ses_message_id TEXT,
			sent_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE outbound_delivery_attempts (
			id TEXT PRIMARY KEY,
			delivery_id TEXT NOT NULL,
			attempt_number INTEGER NOT NULL,
			status TEXT NOT NULL,
			FOREIGN KEY(delivery_id) REFERENCES outbound_deliveries(id) ON DELETE CASCADE
		);
			CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, draft_version INTEGER);
			CREATE TABLE draft_save_operations (
				save_key TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				claim_expires_at INTEGER NOT NULL
			);
			CREATE TABLE draft_save_cleanup_intents (
				claim_token TEXT PRIMARY KEY,
				draft_id TEXT NOT NULL,
				destination_keys TEXT NOT NULL,
				next_attempt_at INTEGER NOT NULL,
				verify_until INTEGER NOT NULL,
				attempts INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			);
			CREATE INDEX idx_draft_save_cleanup_due
				ON draft_save_cleanup_intents(next_attempt_at, claim_token);
		INSERT INTO emails VALUES ('email-legacy', 'sent', NULL);
		INSERT INTO outbound_deliveries VALUES (
			'delivery-legacy', 'email-legacy', NULL, NULL, 'key-legacy',
			'user', 'user-1', 'queued', NULL, NULL,
			'2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z'
		);
		INSERT INTO outbound_delivery_attempts VALUES (
			'attempt-legacy', 'delivery-legacy', 1, 'sending'
		);
	`);
	return db;
}

test("migration 37 preserves legacy rows with safe reliability defaults", () => {
	const db = legacyDatabase();
	applyOutboundReliability(db);

	assert.deepEqual(
		{ ...db.prepare(`
			SELECT command_fingerprint, preflight_deferral_count,
				cancellation_recovery_attempt_count, retry_origin_status, dispatch_phase,
				active_attempt_id, accepted_attempt_count, duplicate_acceptance_at
			FROM outbound_deliveries WHERE id = 'delivery-legacy'
		`).get() },
		{
			command_fingerprint: null,
			preflight_deferral_count: 0,
			cancellation_recovery_attempt_count: 0,
			retry_origin_status: null,
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
	applyOutboundReliability(db);
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
		"recipient_hashes_json",
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

test("migration 37 creates a bounded acceptance recovery owner", () => {
	const db = legacyDatabase();
	applyOutboundReliability(db);
	const columns = db
		.prepare("PRAGMA table_info(outbound_acceptance_recovery)")
		.all()
		.map((row) => (row as { name: string }).name);
	assert.deepEqual(columns, [
		"delivery_id",
		"email_id",
		"attempt_id",
		"ses_message_id",
		"accepted_at",
		"source_draft_id",
		"source_draft_version",
		"actor_kind",
		"actor_id",
		"state",
		"generation",
		"attempt_count",
		"next_attempt_at",
		"message_projected_at",
		"draft_consumed_at",
		"last_error_code",
		"created_at",
		"updated_at",
		"completed_at",
	]);
	assert.throws(
		() => db.prepare(`
			INSERT INTO outbound_acceptance_recovery (
				delivery_id, email_id, actor_kind, state, generation,
				attempt_count, created_at, updated_at
			) VALUES ('delivery-legacy', 'email-legacy', 'system', 'pending', 0, -1, 'now', 'now')
		`).run(),
		/CHECK constraint failed/,
	);
	db.close();
});

test("migration 37 indexes the bounded draft-save expiry sweep", () => {
	const db = legacyDatabase();
	applyOutboundReliability(db);
	const details = db
		.prepare(`
			EXPLAIN QUERY PLAN
			SELECT save_key
			FROM draft_save_operations
			WHERE state = 'claimed' AND claim_expires_at <= ?
			ORDER BY claim_expires_at, save_key
			LIMIT ?
		`)
		.all(Date.now(), 100)
		.map((row) => (row as { detail: string }).detail)
		.join("\n");
	assert.match(details, /idx_draft_save_operations_expiry/);
	assert.doesNotMatch(details, /USE TEMP B-TREE/);
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
