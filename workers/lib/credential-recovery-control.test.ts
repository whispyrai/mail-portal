import assert from "node:assert/strict";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { isCredentialRecoveryEnabled } from "./credential-recovery-control.ts";

class Statement {
  #values: unknown[] = [];
  readonly #statement: StatementSync;

  constructor(database: DatabaseSync, sql: string) {
    this.#statement = database.prepare(sql);
  }

  bind(...values: unknown[]) {
    this.#values = values;
    return this;
  }

  async first<T>() {
    return (this.#statement.get(...this.#values) as T | undefined) ?? null;
  }
}

function envFor(database: DatabaseSync): Env {
  return {
    DB: {
      prepare(sql: string) {
        return new Statement(database, sql);
      },
    },
  } as unknown as Env;
}

test("credential recovery control fails closed for a missing table, row, or invalid value", async () => {
  const database = new DatabaseSync(":memory:");
  const env = envFor(database);

  assert.equal(await isCredentialRecoveryEnabled(env), false);
  database.exec(`
    CREATE TABLE credential_recovery_control (
      control_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  assert.equal(await isCredentialRecoveryEnabled(env), false);
  database.exec(
    "INSERT INTO credential_recovery_control VALUES ('global', 2, 1)",
  );
  assert.equal(await isCredentialRecoveryEnabled(env), false);
  database.close();
});

test("credential recovery control enables only the exact global enabled row", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE credential_recovery_control (
      control_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO credential_recovery_control VALUES ('global', 0, 1);
  `);
  const env = envFor(database);

  assert.equal(await isCredentialRecoveryEnabled(env), false);
  database.exec(
    "UPDATE credential_recovery_control SET enabled = 1 WHERE control_id = 'global'",
  );
  assert.equal(await isCredentialRecoveryEnabled(env), true);
  database.close();
});

test("credential recovery control never logs identifier-shaped private error names", async () => {
  const privateErrorName = "PrivateSecretValue";
  const error = new Error("private message");
  error.name = privateErrorName;
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...values: unknown[]) => warnings.push(values);
  try {
    assert.equal(
      await isCredentialRecoveryEnabled({
        DB: {
          prepare() {
            throw error;
          },
        },
      } as unknown as Env),
      false,
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.match(JSON.stringify(warnings), /"errorName":"UnknownError"/);
  assert.doesNotMatch(JSON.stringify(warnings), /PrivateSecretValue|private message/);
});
