import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
  AGENT_CONNECTION_REVOCATION_LIMITS,
  drainAgentConnectionRevocations,
  requireAgentConnectionReconciliation,
  type AgentConnectionRevocationOutboxDependencies,
} from "./agent-connection-revocation-outbox.ts";

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
  async run<T>() {
    const statement = this.statement();
    if (/\breturning\b/i.test(this.#sql)) {
      const results = statement.all(...this.#values) as T[];
      return { success: true, results, meta: { changes: results.length } };
    }
    const result = statement.run(...this.#values);
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

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0005_auth_security.sql",
    "0010_create_agent_connection_revocations.sql",
  ]) {
    db.exec(
      readFileSync(
        new URL(`../../migrations/${migration}`, import.meta.url),
        "utf8",
      ),
    );
  }
  db.prepare(
    `INSERT INTO users
       (id, email, password_hash, password_salt, session_version, role, is_active,
        mailbox_address, created_at, updated_at)
     VALUES ('user-1', 'one@example.com', 'hash', 'salt', 1, 'AGENT', 1,
             'one@example.com', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailboxes
       (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('one@example.com', 'one@example.com', 'PERSONAL', 'user-1', 1, 1, 1),
            ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
     VALUES ('team@example.com', 'user-1', 1)`,
  ).run();
  return db;
}

function fixture(
  db: DatabaseSync,
  input: { failMailbox?: string; stealLease?: boolean } = {},
) {
  const calls: string[] = [];
  let token = 0;
  const dependencies: AgentConnectionRevocationOutboxDependencies = {
    now: () => 2_000_000_000_000,
    createToken: () => `lease-${token += 1}`,
    revoker: {
      async reconcileActor(mailboxId, userId) {
        calls.push(`actor:${mailboxId}:${userId}`);
        if (input.stealLease) {
          db.prepare(
            "UPDATE agent_connection_revocations SET lease_token = 'new-owner'",
          ).run();
        }
        if (mailboxId === input.failMailbox) throw new Error("private RPC detail");
      },
      async reconcileMailbox(mailboxId) {
        calls.push(`mailbox:${mailboxId}`);
        if (mailboxId === input.failMailbox) throw new Error("private RPC detail");
      },
    },
  };
  const env = {
    DB: {
      prepare(sql: string) {
        return new Statement(db, sql);
      },
    },
  } as unknown as Env;
  return { calls, dependencies, env };
}

test("credential rotation reconciles every mailbox to the current session generation", async () => {
  const db = database();
  db.prepare(
    "UPDATE users SET session_version = 2 WHERE id = 'user-1'",
  ).run();
  db.prepare(
    "UPDATE agent_connection_revocations SET next_attempt_at = 1",
  ).run();
  const { calls, dependencies, env } = fixture(db);
  const result = await drainAgentConnectionRevocations(
    env,
    { userId: "user-1" },
    dependencies,
  );
  assert.deepEqual(calls.sort(), [
    "actor:one@example.com:user-1",
    "actor:team@example.com:user-1",
  ]);
  assert.deepEqual(result, {
    claimedCount: 2,
    deliveredCount: 2,
    failedCount: 0,
    hasMore: false,
  });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM agent_connection_revocations").get()!
      .count,
    0,
  );
  db.close();
});

test("failed reconciliation remains durable with content-free bounded backoff", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare(
    "UPDATE agent_connection_revocations SET next_attempt_at = 1",
  ).run();
  const { dependencies, env } = fixture(db, { failMailbox: "team@example.com" });
  const result = await drainAgentConnectionRevocations(env, {}, dependencies);
  assert.equal(result.failedCount, 1);
  assert.deepEqual(
    {
      ...db.prepare(
        `SELECT attempt_count, next_attempt_at, lease_token, lease_expires_at,
                last_error_code
         FROM agent_connection_revocations`,
      ).get(),
    },
    {
      attempt_count: 1,
      next_attempt_at:
        2_000_000_000_000 + AGENT_CONNECTION_REVOCATION_LIMITS.retryBaseMs,
      lease_token: null,
      lease_expires_at: null,
      last_error_code: "agent_rpc_failed",
    },
  );
  db.close();
});

test("delayed work delegates current-state decisions to the mailbox Agent", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare(
    "INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('team@example.com', 'user-1', 2)",
  ).run();
  db.prepare("UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'").run();
  db.prepare("UPDATE mailboxes SET is_active = 1 WHERE id = 'team@example.com'").run();
  db.prepare(
    "UPDATE agent_connection_revocations SET next_attempt_at = 1",
  ).run();
  const { calls, dependencies, env } = fixture(db);
  await drainAgentConnectionRevocations(env, {}, dependencies);
  assert.deepEqual(calls, [
    "actor:team@example.com:user-1",
    "mailbox:team@example.com",
  ]);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM agent_connection_revocations").get()!
      .count,
    0,
  );
  db.close();
});

test("synchronous reconciliation fails closed while matching work is actively leased", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare(
    `UPDATE agent_connection_revocations
     SET next_attempt_at = 1, lease_token = 'cron-owner', lease_expires_at = 2000000060000`,
  ).run();
  const { calls, dependencies, env } = fixture(db);
  await assert.rejects(
    () => requireAgentConnectionReconciliation(
      env,
      { mailboxId: "team@example.com", userId: "user-1", scope: "ACTOR" },
      dependencies,
    ),
    /could not be fully reconciled/,
  );
  assert.deepEqual(calls, []);
  db.close();
});

test("synchronous reconciliation rejects matching backoff without blocking on unrelated work", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare(
    "UPDATE agent_connection_revocations SET next_attempt_at = 2000000060000",
  ).run();
  const { calls, dependencies, env } = fixture(db);
  await assert.rejects(() => requireAgentConnectionReconciliation(
    env,
    { mailboxId: "team@example.com", userId: "user-1" },
    dependencies,
  ));
  await requireAgentConnectionReconciliation(
    env,
    { mailboxId: "one@example.com", userId: "user-1" },
    dependencies,
  );
  assert.deepEqual(calls, []);
  db.close();
});

test("a worker that loses its lease cannot report delivery", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare("UPDATE agent_connection_revocations SET next_attempt_at = 1").run();
  const { dependencies, env } = fixture(db, { stealLease: true });
  const result = await drainAgentConnectionRevocations(env, {}, dependencies);
  assert.deepEqual(result, {
    claimedCount: 1,
    deliveredCount: 0,
    failedCount: 1,
    hasMore: false,
  });
  assert.equal(
    db.prepare(
      "SELECT lease_token FROM agent_connection_revocations",
    ).get()!.lease_token,
    "new-owner",
  );
  db.close();
});

test("synchronous reconciliation rejects when its lease is stolen during Agent RPC", async () => {
  const db = database();
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
  ).run();
  db.prepare("UPDATE agent_connection_revocations SET next_attempt_at = 1").run();
  const { dependencies, env } = fixture(db, { stealLease: true });
  await assert.rejects(() => requireAgentConnectionReconciliation(
    env,
    { mailboxId: "team@example.com", userId: "user-1" },
    dependencies,
  ));
  assert.equal(
    db.prepare("SELECT lease_token FROM agent_connection_revocations").get()!
      .lease_token,
    "new-owner",
  );
  db.close();
});

test("claims are bounded and expired leases are safely reclaimed", async () => {
  const db = database();
  const insert = db.prepare(
    `INSERT INTO agent_connection_revocations
       (id, scope, mailbox_id, user_id, next_attempt_at, lease_token,
        lease_expires_at, created_at, updated_at)
     VALUES (?, 'ACTOR', 'one@example.com', 'user-1', 1, ?, ?, 1, 1)`,
  );
  for (let index = 0; index < 30; index += 1) {
    insert.run(
      `event-${String(index).padStart(2, "0")}`,
      index === 0 ? "expired-lease" : null,
      index === 0 ? 1 : null,
    );
  }
  const { calls, dependencies, env } = fixture(db);
  const result = await drainAgentConnectionRevocations(
    env,
    { maxBatches: 1 },
    dependencies,
  );
  assert.equal(calls.length, AGENT_CONNECTION_REVOCATION_LIMITS.batchSize);
  assert.equal(result.claimedCount, AGENT_CONNECTION_REVOCATION_LIMITS.batchSize);
  assert.equal(result.hasMore, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM agent_connection_revocations").get()!
      .count,
    5,
  );
  db.close();
});
