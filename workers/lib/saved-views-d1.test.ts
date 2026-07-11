import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { createSavedViewService, SavedViewError } from "./saved-views.ts";
import { savedViewD1Store } from "./saved-views-d1.ts";

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
  async first<T>() {
    return (this.statement().get(...this.#values) as T | undefined) ?? null;
  }
  async all<T>() {
    return {
      success: true,
      results: this.statement().all(...this.#values) as T[],
    };
  }
  async run() {
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
  } as unknown as D1Database;
}

test("D1 keeps personal saved views after shared mailbox access is revoked", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0007_create_saved_views.sql",
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
		 (id, email, password_hash, password_salt, role, is_active, mailbox_address, created_at, updated_at)
		 VALUES ('usr_1', 'one@example.com', 'hash', 'salt', 'AGENT', 1, 'one@example.com', 1, 1),
		        ('usr_2', 'two@example.com', 'hash', 'salt', 'AGENT', 1, 'two@example.com', 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailboxes (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES ('support@example.com', 'support@example.com', 'SHARED', NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    "INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('support@example.com', 'usr_1', 1), ('support@example.com', 'usr_2', 1)",
  ).run();

  const env = { DB: d1(db) } as unknown as Env;
  let access = true;
  const service = createSavedViewService({
    store: savedViewD1Store(env),
    canAccessMailbox: async () => access,
    now: () => 10,
    id: () => "view_1",
  });
  await service.create("usr_1", "support@example.com", {
    name: "Urgent",
    filters: { labelId: "label_missing", isRead: false },
    sort: { column: "date", direction: "DESC" },
  });
  assert.equal((await service.list("usr_1", "support@example.com")).length, 1);
  assert.equal((await service.list("usr_2", "support@example.com")).length, 0);

  access = false;
  await assert.rejects(
    () => service.list("usr_1", "support@example.com"),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "FORBIDDEN",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_views WHERE id = 'view_1'")
      .get()!.count,
    1,
  );
  db.close();
});
