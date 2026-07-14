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
    async drainAgentRevocations() {
      calls.push("agent");
      return { failedCount: 0, hasMore: false };
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
  assert.deepEqual(calls, ["agent", "cache:20"]);

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
