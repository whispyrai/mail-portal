import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
  canonicalCredentialRecoveryIp,
  CREDENTIAL_RECOVERY_JOB_LIMITS,
  enqueueCredentialRecoveryRequest,
  leaseCredentialRecoveryRequestJobs,
} from "./credential-recovery-request-jobs.ts";
import { drainCredentialRecoveryRequests } from "./recovery-request-runtime.ts";
import { credentialRecoveryWorkflow } from "./credential-recovery-runtime.ts";
import {
  decryptCredentialRecoveryDelivery,
  leaseCredentialRecoveryDeliveries,
} from "./credential-recovery-delivery-outbox.ts";
import { encryptCredentialRecoveryPayload } from "./credential-recovery-crypto.ts";

class Statement {
  #values: unknown[] = [];
  readonly #database: DatabaseSync;
  readonly #sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.#database = database;
    this.#sql = sql;
  }
  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }
  async run() {
    const result = this.statement().run(...this.#values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  async all<T>() {
    return { success: true, results: this.statement().all(...this.#values) as T[] };
  }
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
  }
  private statement(): StatementSync {
    return this.#database.prepare(this.#sql);
  }
}

function fixture() {
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
  };
  return {
    database,
    env: {
      DB: d1,
      JWT_SECRET: "test-secret",
      CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1: "test-secret",
      BRAND: "wiser",
      DOMAINS: "wiserchat.ai",
      ACCOUNT_RECOVERY_DIRECTORY: JSON.stringify({
        "member@wiserchat.ai": "owner@personal.example",
      }),
    } as unknown as Env,
  };
}

test("recovery throttle IPs are bounded and canonical", () => {
  assert.equal(canonicalCredentialRecoveryIp("203.0.113.9"), "203.0.113.9");
  assert.equal(
    canonicalCredentialRecoveryIp("2001:0DB8:0000:0000:0000:0000:0000:0001"),
    "2001:db8::1",
  );
  assert.equal(canonicalCredentialRecoveryIp("::ffff:192.0.2.128"), "::ffff:c000:280");
  assert.equal(canonicalCredentialRecoveryIp("::::"), "unknown");
  assert.equal(canonicalCredentialRecoveryIp("x".repeat(100)), "unknown");
});

test("a valid public request is durably encrypted before it is acknowledged", async () => {
  const { database, env } = fixture();
  const result = await enqueueCredentialRecoveryRequest(env, {
    email: "MEMBER@WISERCHAT.AI",
    ip: "203.0.113.9",
    now: 1_000,
  });

  assert.equal(result.kind, "queued");
  const serialized = JSON.stringify(
    database.prepare("SELECT * FROM credential_recovery_request_jobs").all(),
  );
  assert.doesNotMatch(serialized, /member@wiserchat|203\.0\.113\.9/i);
  assert.equal(
    database.prepare("SELECT state FROM credential_recovery_request_jobs").get()!.state,
    "pending",
  );
  database.close();
});

test("invalid and rate-limited requests are intentionally suppressed without a job", async () => {
  const { database, env } = fixture();
  assert.deepEqual(
    await enqueueCredentialRecoveryRequest(env, {
      email: "not-mail",
      ip: "203.0.113.9",
      now: 1_000,
    }),
    { kind: "suppressed" },
  );
  for (let count = 0; count < 3; count += 1) {
    assert.equal(
      (
        await enqueueCredentialRecoveryRequest(env, {
          email: "member@wiserchat.ai",
          ip: "203.0.113.9",
          now: 1_000 + count,
        })
      ).kind,
      "queued",
    );
  }
  assert.deepEqual(
    await enqueueCredentialRecoveryRequest(env, {
      email: "member@wiserchat.ai",
      ip: "203.0.113.9",
      now: 1_004,
    }),
    { kind: "suppressed" },
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_request_jobs").get()!.count,
    3,
  );
  database.close();
});

test("an expired request lease becomes recoverable by exactly one drainer", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  const first = await leaseCredentialRecoveryRequestJobs(env, 1_000);
  const concurrent = await leaseCredentialRecoveryRequestJobs(env, 1_001);
  const recovered = await leaseCredentialRecoveryRequestJobs(env, 61_001);

  assert.equal(first.length, 1);
  assert.equal(concurrent.length, 0);
  assert.equal(recovered.length, 1);
  assert.notEqual(first[0]?.leaseToken, recovered[0]?.leaseToken);
  database.close();
});

test("a durable job insert failure rolls back its throttle allowance", async () => {
  const { database, env } = fixture();
  database.exec(
    `CREATE TRIGGER reject_recovery_job BEFORE INSERT ON credential_recovery_request_jobs
     BEGIN SELECT RAISE(ABORT, 'simulated durable insert failure'); END;`,
  );
  await assert.rejects(
    () =>
      enqueueCredentialRecoveryRequest(env, {
        email: "member@wiserchat.ai",
        ip: "203.0.113.9",
        now: 1_000,
      }),
    /simulated durable insert failure/,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_request_limits").get()!.count,
    0,
  );
  database.close();
});

test("unknown and ineligible accounts complete as privacy-safe suppression", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "unknown@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
    issuedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.equal(
    database.prepare("SELECT state FROM credential_recovery_request_jobs").get()!.state,
    "suppressed",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_tokens").get()!.count,
    0,
  );
  database.close();
});

test("eligibility lost after request leasing atomically suppresses without token or outbox", async () => {
  const { database, env } = fixture();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  const [job] = await leaseCredentialRecoveryRequestJobs(env, 1_000);
  assert.ok(job);
  database.prepare("UPDATE users SET is_active = 0 WHERE id = 'user-1'").run();

  const result = await credentialRecoveryWorkflow(env, { now: () => 1_001 }).issue({
    purpose: "recovery",
    userId: "user-1",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
    requestLease: { jobId: job.id, leaseToken: job.leaseToken },
  });
  assert.equal(result.issuance, "suppressed");
  assert.equal(
    database.prepare("SELECT state FROM credential_recovery_request_jobs").get()!.state,
    "suppressed",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_tokens").get()!.count,
    0,
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_delivery_outbox",
    ).get()!.count,
    0,
  );
  database.close();
});

test("issuance rate limits release the request lease at the exact oldest-window due time", async () => {
  const { database, env } = fixture();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100, 100)`,
  ).run();
  const seed = database.prepare(
    `INSERT INTO credential_recovery_tokens
     (id, user_id, token_hash, expires_at, purpose, created_at)
     VALUES (?, 'user-1', ?, 99999999, 'recovery', ?)`,
  );
  seed.run("seed-1", "seed-hash-1", 100);
  seed.run("seed-2", "seed-hash-2", 200);
  seed.run("seed-3", "seed-hash-3", 300);
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  const [job] = await leaseCredentialRecoveryRequestJobs(env, 1_000);
  assert.ok(job);
  const result = await credentialRecoveryWorkflow(env, { now: () => 1_000 }).issue({
    purpose: "recovery",
    userId: "user-1",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
    requestLease: { jobId: job.id, leaseToken: job.leaseToken },
  });
  assert.equal(result.issuance, "rate_limited");
  const pending = database.prepare(
    `SELECT state, next_attempt_at, lease_token, last_error_code
     FROM credential_recovery_request_jobs`,
  ).get()!;
  assert.equal(pending.state, "pending");
  assert.equal(pending.next_attempt_at, 900_100);
  assert.equal(pending.lease_token, null);
  assert.equal(pending.last_error_code, "ISSUE_RATE_LIMITED");
  database.close();
});

test("eligible processing atomically completes the job and creates an encrypted canonical delivery", async () => {
  const { database, env } = fixture();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, recovery_email, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', NULL, 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });

  assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
    issuedCount: 1,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.equal(
    database.prepare("SELECT state FROM credential_recovery_request_jobs").get()!.state,
    "completed",
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_tokens").get()!.count,
    1,
  );
  const persisted = JSON.stringify(
    database
      .prepare(
        `SELECT r.account_ref, r.payload_iv, r.payload_ciphertext,
                d.payload_iv, d.payload_ciphertext, t.token_hash
         FROM credential_recovery_request_jobs r
         JOIN credential_recovery_delivery_outbox d
         JOIN credential_recovery_tokens t ON t.id = d.token_id`,
      )
      .get(),
  );
  assert.doesNotMatch(
    persisted,
    /member@wiserchat|owner@personal|account\/recover|raw-secret/i,
  );
  const [leasedDelivery] = await leaseCredentialRecoveryDeliveries(env, 1_000);
  assert.ok(leasedDelivery);
  assert.deepEqual(await leaseCredentialRecoveryDeliveries(env, 1_001), []);
  const [recoveredDelivery] = await leaseCredentialRecoveryDeliveries(env, 61_001);
  assert.ok(recoveredDelivery);
  assert.notEqual(leasedDelivery.leaseToken, recoveredDelivery.leaseToken);
  const decrypted = await decryptCredentialRecoveryDelivery(env, recoveredDelivery);
  assert.equal(decrypted.to, "owner@personal.example");
  assert.match(
    decrypted.recoveryUrl,
    /^https:\/\/mail\.wiserchat\.ai\/account\/recover\?token=/,
  );
  database.close();
});

test("delivery insert failure rolls back token issuance and retries the durable request", async () => {
  const { database, env } = fixture();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, recovery_email, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', NULL, 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  database.exec(
    `CREATE TRIGGER reject_recovery_delivery
     BEFORE INSERT ON credential_recovery_delivery_outbox
     BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END;`,
  );
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => {
    logs.push(values);
  };
  try {
    assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
      issuedCount: 0,
      retryCount: 1,
      expiredCount: 0,
      parkedCount: 0,
      failedCount: 0,
      hasMore: false,
    });
  } finally {
    console.error = originalError;
  }
  assert.doesNotMatch(
    JSON.stringify(logs),
    /member@wiserchat|owner@personal|simulated outbox|token=/i,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_tokens").get()!.count,
    0,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM credential_recovery_audit").get()!.count,
    0,
  );
  assert.equal(
    database.prepare("SELECT state FROM credential_recovery_request_jobs").get()!.state,
    "pending",
  );
  assert.equal(
    database.prepare("SELECT recovery_email FROM users WHERE id = 'user-1'").get()!
      .recovery_email,
    null,
  );
  database.close();
});

test("request ciphertext corruption parks visibly without resolving an account", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  database
    .prepare(
      "UPDATE credential_recovery_request_jobs SET payload_ciphertext = ?",
    )
    .run("z".repeat(32));

  assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
    issuedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 1,
    failedCount: 1,
    hasMore: false,
  });
  const parked = database
    .prepare(
      "SELECT state, last_error_code FROM credential_recovery_request_jobs",
    )
    .get()!;
  assert.equal(parked.state, "parked");
  assert.equal(
    parked.last_error_code,
    "PAYLOAD_DECRYPT_OR_VALIDATION_FAILED",
  );
  database.close();
});

test("authenticated request payload with a wrong exact shape parks permanently", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  const job = database.prepare(
    "SELECT id FROM credential_recovery_request_jobs",
  ).get()!;
  const encrypted = await encryptCredentialRecoveryPayload(
    env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1,
    {},
    { kind: "request", id: String(job.id) },
  );
  database.prepare(
    `UPDATE credential_recovery_request_jobs
     SET payload_key_version = ?, payload_iv = ?, payload_ciphertext = ?`,
  ).run(encrypted.keyVersion, encrypted.iv, encrypted.ciphertext);

  assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
    issuedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 1,
    failedCount: 1,
    hasMore: false,
  });
  const parked = database.prepare(
    `SELECT state, last_error_code FROM credential_recovery_request_jobs`,
  ).get()!;
  assert.equal(parked.state, "parked");
  assert.equal(parked.last_error_code, "PAYLOAD_DECRYPT_OR_VALIDATION_FAILED");
  database.close();
});

test("missing V1 key retries existing ciphertext instead of parking it", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1 = "";
  assert.deepEqual(await drainCredentialRecoveryRequests(env, 1_000), {
    issuedCount: 0,
    retryCount: 1,
    expiredCount: 0,
    parkedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  const pending = database.prepare(
    `SELECT state, last_error_code, payload_ciphertext
     FROM credential_recovery_request_jobs`,
  ).get()!;
  assert.equal(pending.state, "pending");
  assert.equal(pending.last_error_code, "PAYLOAD_KEY_UNAVAILABLE");
  assert.equal(typeof pending.payload_ciphertext, "string");
  database.close();
});

test("missing V1 key prevents intake before any durable plaintext-adjacent state", async () => {
  const { database, env } = fixture();
  env.CREDENTIAL_RECOVERY_PAYLOAD_KEY_V1 = "";
  await assert.rejects(() =>
    enqueueCredentialRecoveryRequest(env, {
      email: "member@wiserchat.ai",
      ip: "203.0.113.9",
      now: 1_000,
    }),
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM credential_recovery_request_jobs",
    ).get()!.count,
    0,
  );
  database.close();
});

test("invalid directory configuration retries an eligible request as an outage", async () => {
  const { database, env } = fixture();
  env.ACCOUNT_RECOVERY_DIRECTORY = "not-json";
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, recovery_email, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', NULL, 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });

  assert.equal(
    (await drainCredentialRecoveryRequests(env, 1_000)).failedCount,
    0,
  );
  const parked = database
    .prepare(
      "SELECT state, last_error_code FROM credential_recovery_request_jobs",
    )
    .get()!;
  assert.equal(parked.state, "pending");
  assert.equal(parked.last_error_code, "RECOVERY_DIRECTORY_INVALID_CONFIG");
  database.close();
});

test("an unmapped eligible account remains a bounded retry with a distinct operator code", async () => {
  const { database, env } = fixture();
  env.ACCOUNT_RECOVERY_DIRECTORY = JSON.stringify({
    "other@wiserchat.ai": "owner@personal.example",
  });
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });

  const result = await drainCredentialRecoveryRequests(env, 1_000);
  assert.equal(result.retryCount, 1);
  assert.equal(result.failedCount, 0);
  assert.equal(
    database.prepare(
      "SELECT last_error_code FROM credential_recovery_request_jobs",
    ).get()!.last_error_code,
    "RECOVERY_DIRECTORY_UNMAPPED",
  );
  database.close();
});

test("request lifetime expiry terminalizes and scrubs ciphertext without leasing", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });

  assert.deepEqual(
    await drainCredentialRecoveryRequests(
      env,
      1_000 + CREDENTIAL_RECOVERY_JOB_LIMITS.maxAgeMs,
    ),
    {
      issuedCount: 0,
      retryCount: 0,
      expiredCount: 1,
      parkedCount: 0,
      failedCount: 0,
      hasMore: false,
    },
  );
  const expired = database.prepare(
    `SELECT state, last_error_code, payload_ciphertext
     FROM credential_recovery_request_jobs`,
  ).get()!;
  assert.equal(expired.state, "expired");
  assert.equal(expired.last_error_code, "REQUEST_LIFETIME_EXPIRED");
  assert.equal(expired.payload_ciphertext, null);
  database.close();
});

test("request retry exhaustion parks with visible evidence for bounded retention", async () => {
  const { database, env } = fixture();
  env.ACCOUNT_RECOVERY_DIRECTORY = "not-json";
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, ownership_confirmed_at, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
             'member@wiserchat.ai', 100, 100, 100)`,
  ).run();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000,
  });
  database.prepare(
    "UPDATE credential_recovery_request_jobs SET attempt_count = ?",
  ).run(CREDENTIAL_RECOVERY_JOB_LIMITS.maxAttempts - 1);

  const result = await drainCredentialRecoveryRequests(env, 1_000);
  assert.deepEqual(result, {
    issuedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 1,
    failedCount: 1,
    hasMore: false,
  });
  const parked = database.prepare(
    `SELECT state, attempt_count, last_error_code, payload_ciphertext
     FROM credential_recovery_request_jobs`,
  ).get()!;
  assert.equal(parked.state, "parked");
  assert.equal(parked.attempt_count, CREDENTIAL_RECOVERY_JOB_LIMITS.maxAttempts);
  assert.equal(
    parked.last_error_code,
    "RECOVERY_DIRECTORY_INVALID_CONFIG_EXHAUSTED",
  );
  assert.equal(typeof parked.payload_ciphertext, "string");
  database.close();
});

test("request drain logs only exact privacy-safe completion counts", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "private-person@wiserchat.ai",
    ip: "203.0.113.77",
    now: 1_000,
  });
  const logs: unknown[][] = [];
  const originalInfo = console.info;
  console.info = (...values: unknown[]) => logs.push(values);
  try {
    await drainCredentialRecoveryRequests(env, 1_000);
  } finally {
    console.info = originalInfo;
  }
  const completion = logs.find(
    (entry) =>
      (entry[1] as { operation?: string } | undefined)?.operation ===
      "credential_recovery_request_drain",
  );
  assert.deepEqual(completion?.[1], {
    operation: "credential_recovery_request_drain",
    issuedCount: 0,
    retryCount: 0,
    expiredCount: 0,
    parkedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.doesNotMatch(
    JSON.stringify(logs),
    /private-person|wiserchat\.ai|203\.0\.113\.77|ciphertext|token/i,
  );
  database.close();
});

test("request drain never logs identifier-shaped private error names", async () => {
  const { database, env } = fixture();
  await enqueueCredentialRecoveryRequest(env, {
    email: "member@wiserchat.ai",
    ip: "203.0.113.77",
    now: 1_000,
  });
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const privateError = new Error("private message");
  privateError.name = "PrivateSecretValue";
  env.DB.prepare = ((sql: string) => {
    if (sql.includes("FROM users")) throw privateError;
    return originalPrepare(sql);
  }) as typeof env.DB.prepare;
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    await drainCredentialRecoveryRequests(env, 1_000);
  } finally {
    console.error = originalError;
  }
  assert.match(JSON.stringify(errors), /"errorName":"UnknownError"/);
  assert.doesNotMatch(JSON.stringify(errors), /PrivateSecretValue|private message/);
  database.close();
});
