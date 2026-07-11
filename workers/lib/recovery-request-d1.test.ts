import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { allowRecoveryRequest } from "./recovery-request-d1.ts";

class Statement {
  readonly #db: DatabaseSync;
  readonly #sql: string;
  #values: unknown[] = [];
  constructor(db: DatabaseSync, sql: string) {
    this.#db = db;
    this.#sql = sql;
  }
  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }
  async run() {
    return this.runSync();
  }
  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.#values) as T[],
    };
  }
  runSync() {
    const result = this.statement().run(...this.#values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }
  private statement(): StatementSync {
    return this.#db.prepare(this.#sql);
  }
}

function d1(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new Statement(db, sql);
    },
    async batch(statements: Statement[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

test("self-service recovery allows three account requests per window and stores only opaque keys", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    readFileSync(
      new URL("../../migrations/0001_create_users.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../../migrations/0005_auth_security.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../../migrations/0006_credential_recovery.sql", import.meta.url),
      "utf8",
    ),
  );
  const env = { DB: d1(db), JWT_SECRET: "test-secret" } as unknown as Env;
  const input = {
    email: "member@wiserchat.ai",
    ip: "203.0.113.9",
    now: 1_000_000,
  };

  assert.equal(await allowRecoveryRequest(env, input), true);
  assert.equal(await allowRecoveryRequest(env, input), true);
  assert.equal(await allowRecoveryRequest(env, input), true);
  assert.equal(await allowRecoveryRequest(env, input), false);
  const serialized = JSON.stringify(
    db
      .prepare("SELECT throttle_key FROM credential_recovery_request_limits")
      .all(),
  );
  assert.doesNotMatch(serialized, /member@wiserchat\.ai|203\.0\.113\.9/);
  db.close();
});
