import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { listUsers } from "./users.ts";

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

  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.#values) as T[],
    };
  }

  async raw() {
    return this.statement()
      .all(...this.#values)
      .map((row) => Object.values(row));
  }

  private statement(): StatementSync {
    return this.#database.prepare(this.#sql);
  }
}

function d1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      return new Statement(database, sql);
    },
  } as unknown as D1Database;
}

test("user administration omits inactive Shared Mailbox tombstones", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
  ]) {
    database.exec(
      readFileSync(
        new URL(`../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  database.exec(`
    INSERT INTO users (
      id, email, password_hash, password_salt, session_version, role, is_active,
      mailbox_address, mcp_token_hash, recovery_email, ownership_confirmed_at,
      created_at, updated_at
    ) VALUES
      ('usr_active', 'active@wiserchat.ai', 'hash', 'salt', 1, 'AGENT', 1,
       'active@wiserchat.ai', NULL, NULL, 1, 1, 1),
      ('usr_inactive', 'inactive@wiserchat.ai', 'hash', 'salt', 2, 'AGENT', 0,
       'inactive@wiserchat.ai', NULL, NULL, 1, 1, 1),
      ('usr_tombstone', 'hello@wiserchat.ai', 'hash', 'salt', 2, 'AGENT', 0,
       'hello@wiserchat.ai', NULL, NULL, 1, 1, 1);

    INSERT INTO mailboxes (
      id, address, type, owner_user_id, is_active, created_at, updated_at
    ) VALUES
      ('active@wiserchat.ai', 'active@wiserchat.ai', 'PERSONAL', 'usr_active', 1, 1, 1),
      ('inactive@wiserchat.ai', 'inactive@wiserchat.ai', 'PERSONAL', 'usr_inactive', 0, 1, 1),
      ('hello@wiserchat.ai', 'hello@wiserchat.ai', 'SHARED', NULL, 1, 1, 1);
  `);

  const users = await listUsers({
    DB: d1(database),
  } as unknown as Env);
  assert.deepEqual(
    users.map((user) => user.id).sort(),
    ["usr_active", "usr_inactive"],
  );
  database.close();
});
