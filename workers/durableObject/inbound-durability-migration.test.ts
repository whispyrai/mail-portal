import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

function migration36() {
  const migration = mailboxMigrations.find(
    (candidate) => candidate.name === "36_add_inbound_durability",
  );
  assert.ok(migration);
  return migration;
}

function databaseBeforeMigration36() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      recipient_memory_origin TEXT,
      body TEXT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      email_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mimetype TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_id TEXT,
      disposition TEXT
    );
  `);
  return database;
}

function insertAttempt(
  database: DatabaseSync,
  input: {
    attemptId: string;
    expectedGeneration?: number;
    fingerprint?: string;
    outcome: string;
    resultGeneration?: number | null;
  },
) {
  database.prepare(`
    INSERT INTO inbound_derived_content_repair_attempts (
      attempt_id,
      email_id,
      expected_generation,
      marker_id,
      command_fingerprint,
      outcome,
      result_generation,
      recorded_at
    ) VALUES (?, 'email-123', ?, 'marker_12345678', ?, ?, ?, '2026-07-15T10:00:00.000Z')
  `).run(
    input.attemptId,
    input.expectedGeneration ?? 4,
    input.fingerprint ?? "a".repeat(64),
    input.outcome,
    input.resultGeneration ?? null,
  );
}

test("migration 36 accepts only complete terminal repair-attempt states", () => {
  const database = databaseBeforeMigration36();
  database.exec(migration36().sql);

  insertAttempt(database, {
    attemptId: "committed_12345678",
    outcome: "committed",
    resultGeneration: 5,
  });
  insertAttempt(database, {
    attemptId: "rejected_12345678",
    outcome: "rejected",
  });
  insertAttempt(database, {
    attemptId: "abandoned_12345678",
    outcome: "abandoned",
  });

	const attemptColumns = database
		.prepare("PRAGMA table_info(inbound_derived_content_repair_attempts)")
		.all()
		.map((column) => column.name);
	assert.equal(attemptColumns.includes("command_json"), false);

  const invalidAttempts = [
    {
      attemptId: "bad_generation_12345678",
      expectedGeneration: 0,
      outcome: "abandoned",
    },
    {
      attemptId: "bad_fingerprint_12345678",
      fingerprint: "short",
      outcome: "abandoned",
    },
    { attemptId: "pending_12345678", outcome: "pending" },
    { attemptId: "committed_no_generation_12345678", outcome: "committed" },
    {
      attemptId: "abandoned_with_generation_12345678",
      outcome: "abandoned",
      resultGeneration: 5,
    },
  ];
  for (const invalid of invalidAttempts) {
    assert.throws(() => insertAttempt(database, invalid), invalid.attemptId);
  }
});

test("migration 36 stores only validated opaque Queue references", () => {
  const database = databaseBeforeMigration36();
  database.exec(migration36().sql);
  const insert = database.prepare(`
    INSERT INTO inbound_terminal_failures (
      id, queue_ref, attempts, error_code, recorded_at
    ) VALUES (?, ?, 11, ?, '2026-07-15T10:00:00.000Z')
  `);

  insert.run("email-valid", "d06683c38d7755ce", "QUEUE_RETRY_EXHAUSTED");
  for (const [id, queueRef] of [
    ["email-short", "abc"],
    ["email-uppercase", "D06683C38D7755CE"],
    ["email-symbol", "d06683c38d7755c!"],
  ]) {
    assert.throws(() =>
      insert.run(id, queueRef, "QUEUE_RETRY_EXHAUSTED"),
    );
  }
  assert.throws(() =>
    insert.run("email-forged-code", "d06683c38d7755ce", "FORGED_CODE"),
  );

  const terminalColumns = database
    .prepare("PRAGMA table_info(inbound_terminal_failures)")
    .all()
    .map((column) => column.name);
  assert.equal(terminalColumns.includes("queue_ref"), true);
  assert.equal(terminalColumns.includes("queue_message_id"), false);
});

test("migration 36 creates a leased deletion outbox and both ownership fences", () => {
  const database = databaseBeforeMigration36();
  database.exec(migration36().sql);

  database.prepare(`
    INSERT INTO r2_deletion_outbox (
      r2_key,
      email_id,
      projection_attempt_id,
      state,
      claim_generation,
      lease_token,
      lease_expires_at,
      attempts,
      next_attempt_at,
      created_at
    ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, 0, ?, ?)
  `).run(
    "email-bodies/email-123/00000000-0000-4000-8000-000000000001/0.body",
    "email-123",
    "00000000-0000-4000-8000-000000000001",
    "2026-07-15T10:00:00.000Z",
    "2026-07-15T10:00:00.000Z",
  );
  database.prepare(`
    INSERT INTO inbound_derived_content_retired_attempts (
      attempt_id, email_id, retired_at, expires_at, reason
    ) VALUES (?, ?, ?, ?, 'r2_deletion_started')
  `).run(
    "00000000-0000-4000-8000-000000000001",
    "email-123",
    "2026-07-15T10:00:00.000Z",
    "2026-08-14T10:00:00.000Z",
  );
  database.prepare(`
    INSERT INTO r2_retired_key_fences (
      r2_key, email_id, retired_at, reason
    ) VALUES (?, ?, ?, 'r2_deletion_started')
  `).run(
    "attachments/email-123/legacy.bin",
    "email-123",
    "2026-07-15T10:00:00.000Z",
  );

  const indexes = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('r2_deletion_outbox', 'inbound_derived_content_retired_attempts') ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(indexes, [
    "idx_inbound_retired_attempts_expiry",
    "idx_r2_deletion_outbox_lease",
    "idx_r2_deletion_outbox_pending",
    "sqlite_autoindex_inbound_derived_content_retired_attempts_1",
    "sqlite_autoindex_r2_deletion_outbox_1",
  ]);
});

test("migration 36 rejects impossible deletion-outbox lease states", () => {
  const database = databaseBeforeMigration36();
  database.exec(migration36().sql);
  const insert = database.prepare(`
    INSERT INTO r2_deletion_outbox (
      r2_key,
      email_id,
      state,
      claim_generation,
      lease_token,
      lease_expires_at,
      attempts,
      next_attempt_at,
      created_at
    ) VALUES (?, 'email-123', ?, ?, ?, ?, ?, '2026-07-15T10:00:00.000Z', '2026-07-15T10:00:00.000Z')
  `);

  assert.throws(() =>
    insert.run("pending-with-lease", "pending", 0, "token", "2026-07-15T10:01:00.000Z", 0),
  );
  assert.throws(() =>
    insert.run("deleting-without-lease", "deleting", 1, null, null, 1),
  );
  assert.throws(() =>
    insert.run("unknown-state", "unknown", 0, null, null, 0),
  );
  assert.throws(() =>
    insert.run("negative-generation", "pending", -1, null, null, 0),
  );
});

test("migration 36 rolls back all earlier statements when a later statement fails", () => {
  const database = databaseBeforeMigration36();
  database.exec("CREATE TABLE inbound_terminal_failures (id TEXT PRIMARY KEY)");

  assert.throws(() => database.exec(migration36().sql));
  database.exec("ROLLBACK");
  const attachmentColumns = database
    .prepare("PRAGMA table_info(attachments)")
    .all()
    .map((column) => column.name);
  assert.equal(attachmentColumns.includes("r2_key"), false);
  const tombstoneTable = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_deletion_tombstones'",
    )
    .get();
  assert.equal(tombstoneTable, undefined);
});

test("a failed terminal attempt rolls back its projection mutation", () => {
  const database = databaseBeforeMigration36();
  database
    .prepare(
      "INSERT INTO emails (id, recipient_memory_origin, body) VALUES (?, ?, ?)",
    )
    .run("email-123", "live_inbound", "original body");
  database.exec(migration36().sql);

  database.exec("BEGIN TRANSACTION");
  assert.throws(() => {
    database
      .prepare("UPDATE emails SET body = ? WHERE id = ?")
      .run("mutated body", "email-123");
    insertAttempt(database, {
      attemptId: "rollback_12345678",
      outcome: "committed",
    });
  });
  database.exec("ROLLBACK");

  const email = database
    .prepare("SELECT body FROM emails WHERE id = ?")
    .get("email-123");
  assert.equal(email?.body, "original body");
  assert.equal(
    database
      .prepare(
        "SELECT attempt_id FROM inbound_derived_content_repair_attempts WHERE attempt_id = ?",
      )
      .get("rollback_12345678"),
    undefined,
  );
  const state = database
    .prepare(
      "SELECT generation FROM inbound_derived_content_state WHERE email_id = ?",
    )
    .get("email-123");
  assert.equal(state?.generation, 1);
});
