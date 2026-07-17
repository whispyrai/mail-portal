import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { pruneCredentialRecoveryHistory } from "./credential-recovery-retention.ts";

class Statement {
  #values: unknown[] = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }
  async run() {
    const result = this.database.prepare(this.sql).run(...this.#values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
}

test("credential recovery retention scrubs incidents and deletes history in bounded batches", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0012_create_credential_recovery_jobs.sql",
  ]) {
    database.exec(
      readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  const now = 400 * 24 * 60 * 60 * 1_000;
  database.prepare(
    `INSERT INTO credential_recovery_request_jobs
     (id, account_ref, payload_key_version, payload_iv, payload_ciphertext,
      state, next_attempt_at, last_error_code, completed_at, created_at, updated_at)
     VALUES ('parked-with-payload', ?, 1, 'AAAAAAAAAAAAAAAA', ?,
             'parked', 1, 'PAYLOAD_CORRUPT', ?, 1, ?)`,
  ).run("r".repeat(43), "c".repeat(24), now - 8 * 24 * 60 * 60 * 1_000, now);
  const insertTerminal = database.prepare(
    `INSERT INTO credential_recovery_request_jobs
     (id, account_ref, state, next_attempt_at, completed_at, created_at, updated_at)
     VALUES (?, ?, 'suppressed', 1, ?, 1, 1)`,
  );
  for (let index = 0; index < 101; index += 1) {
    insertTerminal.run(
      `old-${String(index).padStart(3, "0")}`,
      String(index).padStart(43, "0"),
      now - 91 * 24 * 60 * 60 * 1_000,
    );
  }
  const d1 = {
    prepare(sql: string) {
      return new Statement(database, sql);
    },
    async batch(statements: Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;

  await pruneCredentialRecoveryHistory({ DB: d1 } as Env, now);
  assert.equal(
    database.prepare(
      "SELECT payload_ciphertext FROM credential_recovery_request_jobs WHERE id = 'parked-with-payload'",
    ).get()!.payload_ciphertext,
    null,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_request_jobs WHERE id LIKE 'old-%'",
    ).get()!.count,
    1,
  );
  database.close();
});

test("retention deletes events before attempts and preserves attempts with newer evidence", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
    "0012_create_credential_recovery_jobs.sql",
  ]) {
    database.exec(
      readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
    );
  }
  const now = 500 * 24 * 60 * 60 * 1_000;
  const old = now - 366 * 24 * 60 * 60 * 1_000;
  const recent = now - 10 * 24 * 60 * 60 * 1_000;
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, mailbox_address,
      ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt',
             'member@wiserchat.ai', 1, 1, 1)`,
  ).run();
  const insertToken = database.prepare(
    `INSERT INTO credential_recovery_tokens
     (id, user_id, token_hash, expires_at, consumed_at, purpose, created_at)
     VALUES (?, 'user-1', ?, ?, ?, 'recovery', ?)`,
  );
  const insertOutbox = database.prepare(
    `INSERT INTO credential_recovery_delivery_outbox
     (id, token_id, state, attempt_count, next_attempt_at,
      provider_message_id, accepted_attempt_id, accepted_at, completed_at,
      created_at, updated_at)
     VALUES (?, ?, 'accepted', 1, 1, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAttempt = database.prepare(
    `INSERT INTO credential_recovery_delivery_attempts
     (attempt_id, outbox_id, state, provider_message_id, dispatch_started_at,
      resolved_at, created_at, updated_at)
     VALUES (?, ?, 'accepted', ?, ?, ?, ?, ?)`,
  );
  for (const suffix of ["batch", "skewed"]) {
    insertToken.run(`token-${suffix}`, `hash-${suffix}`, old, old, old);
    insertOutbox.run(
      `outbox-${suffix}`,
      `token-${suffix}`,
      `provider-${suffix}`,
      `attempt-${suffix}`,
      old,
      old,
      old,
      old,
    );
    insertAttempt.run(
      `attempt-${suffix}`,
      `outbox-${suffix}`,
      `provider-${suffix}`,
      old,
      old,
      old,
      old,
    );
  }
  const insertEvent = database.prepare(
    `INSERT INTO credential_recovery_delivery_events
     (event_id, outbox_id, attempt_id, provider_message_id,
      event_type, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, 'delivery', ?, ?)`,
  );
  for (let index = 0; index < 101; index += 1) {
    insertEvent.run(
      `old-event-${String(index).padStart(3, "0")}`,
      "outbox-batch",
      "attempt-batch",
      "provider-batch",
      old,
      old,
    );
  }
  insertEvent.run(
    "recent-event",
    "outbox-skewed",
    "attempt-skewed",
    "provider-skewed",
    recent,
    recent,
  );
  const d1 = {
    prepare(sql: string) {
      return new Statement(database, sql);
    },
    async batch(statements: Statement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const env = { DB: d1 } as Env;

  const first = await pruneCredentialRecoveryHistory(env, now);
  assert.equal(first.hasMore, true);
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_events WHERE outbox_id = 'outbox-batch'",
    ).get()!.count,
    1,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_attempts",
    ).get()!.count,
    2,
  );

  await pruneCredentialRecoveryHistory(env, now);
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_attempts WHERE attempt_id = 'attempt-batch'",
    ).get()!.count,
    0,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_attempts WHERE attempt_id = 'attempt-skewed'",
    ).get()!.count,
    1,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_events WHERE event_id = 'recent-event'",
    ).get()!.count,
    1,
  );
  database.close();
});
