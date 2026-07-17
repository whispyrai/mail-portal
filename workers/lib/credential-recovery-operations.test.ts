import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { readCredentialRecoveryOperationalSnapshot } from "./credential-recovery-operations.ts";

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
  async all<T>() {
    return { success: true, results: this.statement().all(...this.#values) as T[] };
  }
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
  }
  private statement(): StatementSync {
    return this.database.prepare(this.sql);
  }
}

test("operator snapshot exposes only aggregate durability evidence", async () => {
  const database = new DatabaseSync(":memory:");
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
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, mailbox_address,
      ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'private@wiserchat.ai', 'hash', 'salt',
             'private@wiserchat.ai', 1, 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO credential_recovery_request_jobs
     (id, account_ref, payload_key_version, payload_iv, payload_ciphertext,
      state, attempt_count, next_attempt_at, created_at, updated_at)
     VALUES ('private-request-id', ?, 1, 'AAAAAAAAAAAAAAAA', ?, 'pending', 0, 1, 100, 100)`,
  ).run("a".repeat(43), "private-request-ciphertext");
  database.prepare(
    `INSERT INTO credential_recovery_tokens
     (id, user_id, token_hash, expires_at, purpose, created_at)
     VALUES ('private-token-id', 'user-1', 'private-token-hash', 999999,
             'recovery', 1)`,
  ).run();
  database.prepare(
    `INSERT INTO credential_recovery_delivery_outbox
     (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
      state, attempt_count, next_attempt_at, created_at, updated_at,
      ambiguous_dispatch_count, last_ambiguity_at)
     VALUES ('private-delivery-id', 'private-token-id', 1, 'AAAAAAAAAAAAAAAA', ?,
             'pending', 1, 1, 200, 200, 1, 250)`,
  ).run("private-delivery-ciphertext");
  database.prepare(
    `INSERT INTO credential_recovery_delivery_attempts
     (attempt_id, outbox_id, state, dispatch_started_at, resolved_at,
      created_at, updated_at)
     VALUES ('private-attempt-id', 'private-delivery-id', 'ambiguous', 210, 250, 210, 250)`,
  ).run();
  database
    .prepare(
      `INSERT INTO credential_recovery_delivery_attempts
       (attempt_id, outbox_id, state, dispatch_started_at, resolved_at,
        created_at, updated_at)
       VALUES (?, 'private-delivery-id', 'http_rejected', ?, ?, ?, ?)`,
    )
    .run("private-rejection-1", 300, 310, 300, 310);
  database
    .prepare(
      `INSERT INTO credential_recovery_delivery_attempts
       (attempt_id, outbox_id, state, dispatch_started_at, resolved_at,
        created_at, updated_at)
       VALUES (?, 'private-delivery-id', 'http_rejected', ?, ?, ?, ?)`,
    )
    .run("private-rejection-2", 400, 410, 400, 410);
  database
    .prepare(
      `UPDATE credential_recovery_request_jobs
       SET last_error_code = 'RECOVERY_DIRECTORY_INVALID_CONFIG'`,
    )
    .run();
  database
    .prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET last_error_code = 'SES_HTTP_503'`,
    )
    .run();

  const env = {
    DB: {
      prepare(sql: string) {
        assert.doesNotMatch(
          sql,
          /SELECT\s+(?:email|payload_ciphertext|provider_message_id|attempt_id|id)\b/i,
        );
        return new Statement(database, sql);
      },
    },
  } as unknown as Env;
  const snapshot = await readCredentialRecoveryOperationalSnapshot(env, 1_000);
  assert.equal(snapshot.requestStates.pending, 1);
  assert.equal(snapshot.deliveryStates.pending, 1);
  assert.equal(snapshot.attempts.ambiguous, 1);
  assert.equal(snapshot.oldestPendingRequestAgeMs, 900);
  assert.equal(snapshot.oldestActiveDeliveryAgeMs, 800);
  assert.deepEqual(snapshot.monitoringConditions, {
    pendingRequestsOverFiveMinutes: 0,
    pendingDeliveriesOverFiveMinutes: 0,
    activeRequestNonAmbiguousErrors: 1,
    activeDeliveryNonAmbiguousErrors: 1,
    activeDeliveriesWithRepeatedHttpRejections: 1,
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private|wiserchat|ciphertext|token-hash/,
  );

  const agedSnapshot = await readCredentialRecoveryOperationalSnapshot(
    env,
    301_000,
  );
  assert.equal(agedSnapshot.monitoringConditions.pendingRequestsOverFiveMinutes, 1);
  assert.equal(
    agedSnapshot.monitoringConditions.pendingDeliveriesOverFiveMinutes,
    1,
  );

  database
    .prepare(
      `UPDATE credential_recovery_request_jobs
       SET state = 'suppressed', payload_key_version = NULL, payload_iv = NULL,
           payload_ciphertext = NULL, completed_at = 301001, updated_at = 301001`,
    )
    .run();
  database
    .prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET state = 'cancelled', payload_key_version = NULL, payload_iv = NULL,
           payload_ciphertext = NULL, completed_at = 301001, updated_at = 301001`,
    )
    .run();
  const recoveredSnapshot = await readCredentialRecoveryOperationalSnapshot(
    env,
    301_002,
  );
  assert.deepEqual(recoveredSnapshot.monitoringConditions, {
    pendingRequestsOverFiveMinutes: 0,
    pendingDeliveriesOverFiveMinutes: 0,
    activeRequestNonAmbiguousErrors: 0,
    activeDeliveryNonAmbiguousErrors: 0,
    activeDeliveriesWithRepeatedHttpRejections: 0,
  });
  database.close();
});
