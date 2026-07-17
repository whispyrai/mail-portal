import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
  AGENT_RECONCILIATION_CRON,
  AI_CACHE_RETENTION_CRON,
  AI_CACHE_RETENTION_LIMITS,
  pruneExpiredAiResponseCache,
  runScheduledMaintenance,
} from "./scheduled-maintenance.ts";

class Statement {
  #values: unknown[] = [];
  readonly #db: DatabaseSync;
  readonly #sql: string;
  constructor(db: DatabaseSync, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }
  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }
  async run() {
    const result = this.statement().run(...this.#values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
  }
  private statement(): StatementSync {
    return this.#db.prepare(this.#sql);
  }
}

function envFor(db: DatabaseSync): Env {
  return {
    DB: {
      prepare(sql: string) {
        return new Statement(db, sql);
      },
    },
  } as unknown as Env;
}

test("hourly cache retention deletes the exact boundary and reports bounded backlog", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../../migrations/0004_create_ai_cost_controls.sql", import.meta.url),
      "utf8",
    ),
  );
  const insert = db.prepare(
    `INSERT INTO ai_response_cache
       (cache_key, environment, mailbox_id, mailbox_scope, feature, value_json,
        created_at, expires_at)
     VALUES (?, 'wiser', NULL, ?, 'brief', '{}', 1, ?)`,
  );
  const deleteBound =
    AI_CACHE_RETENTION_LIMITS.batchSize * AI_CACHE_RETENTION_LIMITS.maxBatches;
  for (let index = 0; index < deleteBound + 3; index += 1) {
    insert.run(`expired-${index}`, `scope-${index}`, index === 0 ? 10 : 9);
  }
  insert.run("live", "live-scope", 11);

  assert.deepEqual(await pruneExpiredAiResponseCache(envFor(db), 10), {
    deletedCount: deleteBound,
    hasMore: true,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM ai_response_cache WHERE expires_at <= 10")
      .get()!.count,
    3,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM ai_response_cache WHERE cache_key = 'live'")
      .get()!.count,
    1,
  );
  db.close();
});

test("scheduled maintenance routes exact cron events and propagates incomplete security work", async () => {
  const calls: string[] = [];
  const dependencies = {
    async isRecoveryEnabled() {
      calls.push("recovery-control");
      return true;
    },
    async drainAgentRevocations() {
      calls.push("agent");
      return { failedCount: 0, hasMore: false };
    },
    async drainRecoveryRequests() {
      calls.push("recovery-requests");
      return { failedCount: 0, hasMore: false };
    },
    async drainRecoveryDeliveries() {
      calls.push("recovery-deliveries");
      return { failedCount: 0, hasMore: false };
    },
    async pruneRecoveryHistory(_env: Env, now: number) {
      calls.push(`recovery-retention:${now}`);
      return { scrubbedCount: 0, deletedCount: 0, hasMore: false };
    },
    async pruneAiCache(_env: Env, now: number) {
      calls.push(`cache:${now}`);
      return { deletedCount: 1, hasMore: false };
    },
  };
  await runScheduledMaintenance(
    {} as Env,
    { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 10 },
    dependencies,
  );
  await runScheduledMaintenance(
    {} as Env,
    { cron: AI_CACHE_RETENTION_CRON, scheduledTime: 20 },
    dependencies,
  );
  await runScheduledMaintenance(
    {} as Env,
    { cron: "unknown", scheduledTime: 30 },
    dependencies,
  );
  assert.deepEqual(calls, [
    "agent",
    "recovery-control",
    "recovery-requests",
    "recovery-retention:10",
    "recovery-deliveries",
    "cache:20",
  ]);

  await assert.rejects(() =>
    runScheduledMaintenance(
      {} as Env,
      { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 40 },
      {
        ...dependencies,
        async drainAgentRevocations() {
          return { failedCount: 1, hasMore: true };
        },
      },
    ),
  );

  const independentCalls: string[] = [];
  await assert.rejects(
    () =>
      runScheduledMaintenance(
        {} as Env,
        { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 45 },
        {
          ...dependencies,
          async drainAgentRevocations() {
            independentCalls.push("agent");
            throw new Error("agent lane unavailable");
          },
          async drainRecoveryRequests() {
            independentCalls.push("recovery-requests");
            return { failedCount: 0, hasMore: false };
          },
          async drainRecoveryDeliveries() {
            independentCalls.push("recovery-deliveries");
            return { failedCount: 0, hasMore: false };
          },
        },
      ),
    /Security maintenance failed/,
  );
  assert.deepEqual(independentCalls, [
    "agent",
    "recovery-requests",
    "recovery-deliveries",
  ]);

  const recoveryFailureCalls: string[] = [];
  await assert.rejects(
    () =>
      runScheduledMaintenance(
        {} as Env,
        { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 46 },
        {
          ...dependencies,
          async drainAgentRevocations() {
            recoveryFailureCalls.push("agent");
            return { failedCount: 0, hasMore: false };
          },
          async drainRecoveryRequests() {
            recoveryFailureCalls.push("recovery-requests");
            throw new Error("request lane unavailable");
          },
          async drainRecoveryDeliveries() {
            recoveryFailureCalls.push("recovery-deliveries");
            return { failedCount: 0, hasMore: false };
          },
        },
      ),
    /Security maintenance failed/,
  );
  assert.deepEqual(recoveryFailureCalls, [
    "agent",
    "recovery-requests",
    "recovery-deliveries",
  ]);

  await assert.rejects(() =>
    runScheduledMaintenance(
      {} as Env,
      { cron: AI_CACHE_RETENTION_CRON, scheduledTime: 50 },
      {
        ...dependencies,
        async pruneAiCache() {
          return { deletedCount: 5_000, hasMore: true };
        },
      },
    ),
    /bounded hourly limit/,
  );
});

test("disabled or unreadable recovery control skips every recovery table lane without blocking agent maintenance", async () => {
  for (const control of [
    async () => false,
    async () => {
      throw new Error("credential_recovery_control is unreadable");
    },
  ]) {
    const calls: string[] = [];
    await runScheduledMaintenance(
      {} as Env,
      { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 10 },
      {
        async isRecoveryEnabled() {
          calls.push("control");
          return control();
        },
        async drainAgentRevocations() {
          calls.push("agent");
          return { failedCount: 0, hasMore: false };
        },
        async drainRecoveryRequests() {
          calls.push("recovery-requests");
          throw new Error("must not access the recovery tables");
        },
        async drainRecoveryDeliveries() {
          calls.push("recovery-deliveries");
          throw new Error("must not access the recovery tables");
        },
        async pruneRecoveryHistory() {
          calls.push("recovery-retention");
          throw new Error("must not access the recovery tables");
        },
        async pruneAiCache() {
          return { deletedCount: 0, hasMore: false };
        },
      },
    );
    assert.deepEqual(calls.sort(), ["agent", "control"]);
  }
});

test("scheduled maintenance logs explicit privacy-safe lane and backlog summaries", async () => {
  const infos: unknown[][] = [];
  const warnings: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  const originalError = console.error;
  console.info = (...values: unknown[]) => infos.push(values);
  console.warn = (...values: unknown[]) => warnings.push(values);
  console.error = (...values: unknown[]) => errors.push(values);
  const dependencies = {
    async isRecoveryEnabled() {
      return true;
    },
    async drainAgentRevocations() {
      return { failedCount: 0, hasMore: false };
    },
    async drainRecoveryRequests() {
      return {
        issuedCount: 2,
        retryCount: 1,
        expiredCount: 0,
        parkedCount: 0,
        failedCount: 0,
        hasMore: false,
      };
    },
    async drainRecoveryDeliveries() {
      return { acceptedCount: 2, failedCount: 0, hasMore: false };
    },
    async pruneRecoveryHistory() {
      return { scrubbedCount: 1, deletedCount: 2, hasMore: false };
    },
    async pruneAiCache() {
      return { deletedCount: 0, hasMore: false };
    },
  };
  try {
    await runScheduledMaintenance(
      {} as Env,
      { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 10 },
      dependencies,
    );
    await assert.rejects(() =>
      runScheduledMaintenance(
        {} as Env,
        { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 20 },
        {
          ...dependencies,
          async drainRecoveryRequests() {
            return {
              issuedCount: 0,
              retryCount: 1,
              expiredCount: 0,
              parkedCount: 0,
              failedCount: 0,
              hasMore: true,
            };
          },
        },
      ),
    );
  } finally {
    console.info = originalInfo;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.deepEqual(
    infos
      .map((entry) => entry[1] as { lane?: string })
      .filter((entry) => entry?.lane)
      .slice(0, 4)
      .map((entry) => entry.lane),
    [
      "agent_connection_revocations",
      "credential_recovery_requests",
      "credential_recovery_retention",
      "credential_recovery_deliveries",
    ],
  );
  const requestSummary = infos
    .map((entry) => entry[1] as Record<string, unknown>)
    .find((entry) => entry?.lane === "credential_recovery_requests");
  assert.deepEqual(requestSummary, {
    operation: "security_maintenance_lane",
    lane: "credential_recovery_requests",
    outcome: "complete",
    issuedCount: 2,
    retryCount: 1,
    expiredCount: 0,
    parkedCount: 0,
    failedCount: 0,
    hasMore: false,
  });
  assert.ok(
    warnings.some(
      (entry) =>
        (entry[1] as { lane?: string; outcome?: string } | undefined)?.lane ===
          "credential_recovery_requests" &&
        (entry[1] as { outcome?: string }).outcome === "backlog",
    ),
  );
  assert.equal(errors.length, 0);
  assert.doesNotMatch(
    JSON.stringify([infos, warnings, errors]),
    /private|@|account|token|ciphertext/i,
  );
});

test("scheduled maintenance never logs identifier-shaped private error names", async () => {
  const privateError = new Error("private message");
  privateError.name = "PrivateSecretValue";
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => errors.push(values);
  try {
    await assert.rejects(() =>
      runScheduledMaintenance(
        {} as Env,
        { cron: AGENT_RECONCILIATION_CRON, scheduledTime: 10 },
        {
          async isRecoveryEnabled() {
            return false;
          },
          async drainAgentRevocations() {
            throw privateError;
          },
          async drainRecoveryRequests() {
            return {
              issuedCount: 0,
              retryCount: 0,
              expiredCount: 0,
              parkedCount: 0,
              failedCount: 0,
              hasMore: false,
            };
          },
          async drainRecoveryDeliveries() {
            return { acceptedCount: 0, failedCount: 0, hasMore: false };
          },
          async pruneRecoveryHistory() {
            return { scrubbedCount: 0, deletedCount: 0, hasMore: false };
          },
          async pruneAiCache() {
            return { deletedCount: 0, hasMore: false };
          },
        },
      ),
    );
  } finally {
    console.error = originalError;
  }
  assert.match(JSON.stringify(errors), /"errorName":"UnknownError"/);
  assert.doesNotMatch(JSON.stringify(errors), /PrivateSecretValue|private message/);
});
