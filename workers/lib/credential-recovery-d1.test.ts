import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { createCredentialRecoveryWorkflow } from "./credential-recovery.ts";
import { credentialRecoveryD1 } from "./credential-recovery-d1.ts";

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
    return this.runSync();
  }
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
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

test("D1 atomically confirms first ownership and distinguishes later recovery", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0006_credential_recovery.sql",
  ]) {
    db.exec(
      readFileSync(
        new URL(`../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  for (const [id, email, claimed] of [
    ["usr_admin", "admin@wiserchat.ai", 100],
    ["usr_member", "member@wiserchat.ai", null],
  ] as const) {
    db.prepare(
      `INSERT INTO users
			 (id, email, password_hash, password_salt, session_version, role, is_active,
			  mailbox_address, recovery_email, ownership_confirmed_at, created_at, updated_at)
			 VALUES (?, ?, 'old-hash', 'old-salt', 1, ?, 1, ?, 'owner@personal.example', ?, 100, 100)`,
    ).run(id, email, id === "usr_admin" ? "ADMIN" : "AGENT", email, claimed);
  }
  const env = { DB: d1(db) } as unknown as Env;
  let now = 1_000;
  let token = "setup-token";
  const workflow = createCredentialRecoveryWorkflow({
    now: () => now,
    generateToken: () => token,
    hashToken: async (value) => `hash:${value}`,
    store: credentialRecoveryD1(env),
    async deliver() {
      return "accepted";
    },
  });

  await workflow.issue({
    purpose: "setup",
    userId: "usr_member",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    issuedBy: "usr_admin",
    origin: "https://mail.wiserchat.ai",
  });
  now = 1_100;
  assert.equal(
    (
      await workflow.consume({
        token,
        passwordHash: "claimed-hash",
        passwordSalt: "claimed-salt",
        mcpTokenHash: null,
      })
    )?.outcome,
    "claimed",
  );
  assert.equal(
    db
      .prepare(
        "SELECT ownership_confirmed_at FROM users WHERE id = 'usr_member'",
      )
      .get()!.ownership_confirmed_at,
    1_100,
  );

  now = 2_000;
  token = "recovery-token";
  await workflow.issue({
    purpose: "recovery",
    userId: "usr_member",
    loginEmail: "member@wiserchat.ai",
    recoveryEmail: "owner@personal.example",
    origin: "https://mail.wiserchat.ai",
  });
  now = 2_100;
  assert.equal(
    (
      await workflow.consume({
        token,
        passwordHash: "recovered-hash",
        passwordSalt: "recovered-salt",
        mcpTokenHash: "new-mcp",
      })
    )?.outcome,
    "recovered",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT event_type FROM credential_recovery_audit WHERE user_id = 'usr_member' ORDER BY created_at",
      )
      .all()
      .map((row) => row.event_type),
    [
      "setup_issued",
      "ownership_confirmed",
      "recovery_issued",
      "credentials_recovered",
    ],
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE credential_recovery_audit SET event_type = 'setup_issued'",
        )
        .run(),
    /immutable/,
  );
  db.close();
});
