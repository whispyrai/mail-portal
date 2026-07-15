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
    if (/^\s*SELECT\b/i.test(this.#sql)) {
      return {
        success: true,
        results: this.statement().all(...this.#values),
        meta: { changes: 0 },
      };
    }
    const result = this.statement().run(...this.#values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
  private statement(): StatementSync {
    return this.#db.prepare(this.#sql);
  }
}

type D1Controls = {
  failBatchStatementIndex?: number;
  beforeBatch?: () => void | Promise<void>;
};

function d1(db: DatabaseSync, controls: D1Controls = {}): D1Database {
  let batchTail = Promise.resolve();
  return {
    prepare(sql: string) {
      return new Statement(db, sql);
    },
    async batch(statements: Statement[]) {
      const execute = async () => {
        const beforeBatch = controls.beforeBatch;
        delete controls.beforeBatch;
        await beforeBatch?.();
        db.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const [index, statement] of statements.entries()) {
            if (controls.failBatchStatementIndex === index) {
              delete controls.failBatchStatementIndex;
              throw new Error("Injected D1 batch failure");
            }
            results.push(await statement.run());
          }
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      };
      const result = batchTail.then(execute, execute);
      batchTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  } as unknown as D1Database;
}

function savedViewDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0007_create_saved_views.sql",
    "0011_create_saved_view_create_operations.sql",
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
    `INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
     VALUES ('support@example.com', 'usr_1', 1), ('support@example.com', 'usr_2', 1)`,
  ).run();
  return db;
}

const definition = (name = "Urgent") => ({
  name,
  filters: { isRead: false as const },
  sort: { column: "date" as const, direction: "DESC" as const },
});

test("Saved View create-operation migration enforces hash, state, and terminal retention contracts", () => {
  const db = savedViewDatabase();
  const validHash = "a".repeat(64);
  const insert = db.prepare(
    `INSERT INTO saved_view_create_operations
     (operation_key, fingerprint, owner_user_id, mailbox_address, view_id, state, updated_at)
     VALUES (?, ?, 'usr_1', 'support@example.com', 'view_1', ?, 1)`,
  );
  assert.throws(
    () => insert.run("a".repeat(63), validHash, "active"),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run(null, validHash, "active"),
    /NOT NULL constraint failed/,
  );
  assert.throws(
    () => insert.run(validHash, "b".repeat(63), "active"),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insert.run(validHash, validHash, "unknown"),
    /CHECK constraint failed/,
  );
  const retentionIndex = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_view_create_operations_retention'",
    )
    .get() as { sql: string } | undefined;
  assert.match(
    retentionIndex?.sql ?? "",
    /WHERE state IN \('superseded', 'unavailable'\)/,
  );
  db.close();
});

test("D1 replays one authoritative Saved View and follows its lifecycle", async () => {
  const db = savedViewDatabase();
  let nextId = 0;
  let clock = 100;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => ++clock,
    id: () => `view_${++nextId}`,
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const first = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  const replay = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.id, first.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    1,
  );

  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        definition("Changed intent"),
        operationId,
      ),
    (error: unknown) =>
      error instanceof SavedViewError &&
      error.code === "CREATE_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        definition("urgent"),
        "92e968b7-3120-41a7-b839-f42b77c477bc",
      ),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "CONFLICT",
  );

  await service.update(
    first.id,
    "usr_1",
    "support@example.com",
    definition("Renamed"),
  );
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "CREATION_SUPERSEDED",
  );
  await service.delete(first.id, "usr_1", "support@example.com");
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "CREATION_UNAVAILABLE",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    0,
  );
  db.close();
});

test("D1 commit-time access loss rolls back Saved View creation", async () => {
  const db = savedViewDatabase();
  const baseStore = savedViewD1Store({ DB: d1(db) });
  const store = {
    ...baseStore,
    async createOrReplay(
      input: Parameters<NonNullable<typeof baseStore.createOrReplay>>[0],
    ) {
      db.prepare(
        "DELETE FROM mailbox_memberships WHERE mailbox_id = 'support@example.com' AND user_id = 'usr_1'",
      ).run();
      return baseStore.createOrReplay!(input);
    },
  };
  const service = createSavedViewService({
    store,
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => "view_revoked",
  });
  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        definition(),
        "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
      ),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "FORBIDDEN",
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    0,
  );
  db.close();
});

test("D1 isolates the same operation identity by actor and mailbox", async () => {
  const db = savedViewDatabase();
  db.prepare(
    `INSERT INTO mailboxes (id, address, type, owner_user_id, is_active, created_at, updated_at)
     VALUES ('research@example.com', 'research@example.com', 'SHARED', NULL, 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
     VALUES ('research@example.com', 'usr_1', 1)`,
  ).run();
  let nextId = 0;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => `view_scope_${++nextId}`,
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const scopes = [
    ["usr_1", "support@example.com"],
    ["usr_2", "support@example.com"],
    ["usr_1", "research@example.com"],
  ] as const;
  const created = [];
  for (const [ownerUserId, mailboxAddress] of scopes) {
    created.push(
      await service.create(
        ownerUserId,
        mailboxAddress,
        definition("Same scoped operation"),
        operationId,
      ),
    );
  }
  assert.equal(new Set(created.map((view) => view.id)).size, 3);
  for (const [index, [ownerUserId, mailboxAddress]] of scopes.entries()) {
    const replay = await service.create(
      ownerUserId,
      mailboxAddress,
      definition("Same scoped operation"),
      operationId,
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, created[index]!.id);
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    3,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    3,
  );
  assert.equal(
    db
      .prepare(
        `SELECT COUNT(DISTINCT owner_user_id || ':' || mailbox_address) AS count
         FROM saved_view_create_operations`,
      )
      .get()!.count,
    3,
  );
  db.close();
});

test("D1 keeps personal saved views after shared mailbox access is revoked", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
    "0003_create_mailbox_access.sql",
    "0007_create_saved_views.sql",
    "0011_create_saved_view_create_operations.sql",
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
  await service.create(
    "usr_1",
    "support@example.com",
    {
      name: "Urgent",
      filters: { labelId: "label_missing", isRead: false },
      sort: { column: "date", direction: "DESC" },
    },
    "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
  );
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

test("D1 serializes concurrent Saved View creates without duplicate resources", async () => {
  const db = savedViewDatabase();
  let nextId = 0;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => `view_${++nextId}`,
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const results = await Promise.all([
    service.create("usr_1", "support@example.com", definition(), operationId),
    service.create("usr_1", "support@example.com", definition(), operationId),
  ]);
  assert.deepEqual(results.map((row) => row.replayed).sort(), [false, true]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    1,
  );
  db.close();
});

test("D1 distinguishes concurrent idempotency and natural-name conflicts", async () => {
  const db = savedViewDatabase();
  let nextId = 0;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => `view_${++nextId}`,
  });
  const sameOperation = await Promise.allSettled([
    service.create(
      "usr_1",
      "support@example.com",
      definition("One intent"),
      "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
    ),
    service.create(
      "usr_1",
      "support@example.com",
      definition("Another intent"),
      "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
    ),
  ]);
  assert.equal(
    sameOperation.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const idempotencyFailure = sameOperation.find(
    (result) => result.status === "rejected",
  );
  assert.ok(idempotencyFailure?.status === "rejected");
  assert.ok(idempotencyFailure.reason instanceof SavedViewError);
  assert.equal(idempotencyFailure.reason.code, "CREATE_IDEMPOTENCY_CONFLICT");

  const sameName = await Promise.allSettled([
    service.create(
      "usr_1",
      "support@example.com",
      definition("Case conflict"),
      "92e968b7-3120-41a7-b839-f42b77c477bc",
    ),
    service.create(
      "usr_1",
      "support@example.com",
      definition("case conflict"),
      "49994555-bcd9-4c72-862f-8203464e11d8",
    ),
  ]);
  assert.equal(
    sameName.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const nameFailure = sameName.find((result) => result.status === "rejected");
  assert.ok(nameFailure?.status === "rejected");
  assert.ok(nameFailure.reason instanceof SavedViewError);
  assert.equal(nameFailure.reason.code, "CONFLICT");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    2,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    2,
  );
  db.close();
});

test("D1 rolls back a Saved View when the operation ledger write fails", async () => {
  const db = savedViewDatabase();
  const controls = { failBatchStatementIndex: 2 };
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db, controls) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => "view_rollback",
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    /Injected D1 batch failure/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    0,
  );
  const retry = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  assert.equal(retry.replayed, false);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    1,
  );
  db.close();
});

test("D1 does not misreport a generated view ID collision as a name conflict", async () => {
  const db = savedViewDatabase();
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => "view_collision",
  });
  await service.create(
    "usr_1",
    "support@example.com",
    definition("Existing ID"),
    "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
  );
  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        definition("Unique name"),
        "92e968b7-3120-41a7-b839-f42b77c477bc",
      ),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof SavedViewError) &&
      /unique constraint failed:\s*saved_views\.id/i.test(error.message),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS count FROM saved_view_create_operations")
      .get()!.count,
    1,
  );
  db.close();
});

test("D1 fences no-op updates, changed updates, and deletes at commit time", async () => {
  for (const operation of [
    "no-op update",
    "changed update",
    "delete",
  ] as const) {
    const db = savedViewDatabase();
    const database = d1(db);
    const baseStore = savedViewD1Store({ DB: database });
    const createService = createSavedViewService({
      store: baseStore,
      canAccessMailbox: async () => true,
      now: () => 100,
      id: () => "view_revocation",
    });
    await createService.create(
      "usr_1",
      "support@example.com",
      definition(),
      "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
    );
    const revoke = () =>
      db
        .prepare(
          "DELETE FROM mailbox_memberships WHERE mailbox_id = 'support@example.com' AND user_id = 'usr_1'",
        )
        .run();
    const store = {
      ...baseStore,
      async update(input: Parameters<typeof baseStore.update>[0]) {
        revoke();
        return baseStore.update(input);
      },
      async delete(...input: Parameters<typeof baseStore.delete>) {
        revoke();
        return baseStore.delete(...input);
      },
    };
    const service = createSavedViewService({
      store,
      canAccessMailbox: async () => true,
      now: () => 200,
    });
    const action =
      operation === "delete"
        ? () =>
            service.delete("view_revocation", "usr_1", "support@example.com")
        : () =>
            service.update(
              "view_revocation",
              "usr_1",
              "support@example.com",
              definition(operation === "no-op update" ? "Urgent" : "Changed"),
            );
    await assert.rejects(
      action,
      (error: unknown) =>
        error instanceof SavedViewError && error.code === "FORBIDDEN",
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM saved_views").get()!.count,
      1,
    );
    assert.equal(
      db.prepare("SELECT state FROM saved_view_create_operations").get()!.state,
      "active",
    );
    db.close();
  }
});

test("D1 no-op updates preserve active replay and return the authoritative row", async () => {
  const db = savedViewDatabase();
  let clock = 100;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => ++clock,
    id: () => "view_noop",
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const created = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  const unchanged = await service.update(
    created.id,
    "usr_1",
    "support@example.com",
    definition(),
  );
  assert.equal(unchanged.updatedAt, created.updatedAt);
  assert.equal(
    db.prepare("SELECT state FROM saved_view_create_operations").get()!.state,
    "active",
  );
  const replay = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  assert.equal(replay.replayed, true);
  assert.equal(replay.updatedAt, created.updatedAt);
  db.close();
});

test("D1 reclassifies an apparent no-op after an intervening edit", async () => {
  const db = savedViewDatabase();
  const controls: D1Controls = {};
  let clock = 100;
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db, controls) }),
    canAccessMailbox: async () => true,
    now: () => ++clock,
    id: () => "view_intervening_edit",
  });
  const created = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  controls.beforeBatch = () => {
    db.prepare(
      "UPDATE saved_views SET name = 'Intervening edit', updated_at = 150 WHERE id = ?",
    ).run(created.id);
  };
  const restored = await service.update(
    created.id,
    "usr_1",
    "support@example.com",
    definition(),
  );
  assert.equal(restored.name, "Urgent");
  assert.ok(restored.updatedAt > created.updatedAt);
  assert.equal(
    db.prepare("SELECT state FROM saved_view_create_operations").get()!.state,
    "superseded",
  );
  await assert.rejects(
    () =>
      service.create(
        "usr_1",
        "support@example.com",
        definition(),
        operationId,
      ),
    (error: unknown) =>
      error instanceof SavedViewError && error.code === "CREATION_SUPERSEDED",
  );
  db.close();
});

test("D1 classifies an active orphan without mutating or disclosing it after revocation", async () => {
  const db = savedViewDatabase();
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => 100,
    id: () => "view_orphan",
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  db.prepare("DELETE FROM saved_views WHERE id = 'view_orphan'").run();
  const operationBefore = db
    .prepare("SELECT state, updated_at FROM saved_view_create_operations")
    .get()!;
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    (error: unknown) =>
      error instanceof SavedViewError &&
      error.code === "CREATION_UNAVAILABLE" &&
      error.resourceId === "view_orphan",
  );
  assert.deepEqual(
    db
      .prepare("SELECT state, updated_at FROM saved_view_create_operations")
      .get(),
    operationBefore,
  );
  db.prepare(
    "DELETE FROM mailbox_memberships WHERE mailbox_id = 'support@example.com' AND user_id = 'usr_1'",
  ).run();
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    (error: unknown) =>
      error instanceof SavedViewError &&
      error.code === "FORBIDDEN" &&
      error.resourceId === undefined,
  );
  assert.deepEqual(
    db
      .prepare("SELECT state, updated_at FROM saved_view_create_operations")
      .get(),
    operationBefore,
  );
  db.close();
});

test("D1 superseded retries report the resource's latest revision", async () => {
  const db = savedViewDatabase();
  let clock = 100;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => ++clock,
    id: () => "view_revision",
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  await service.update(
    "view_revision",
    "usr_1",
    "support@example.com",
    definition("Renamed"),
  );
  const latest = await service.update(
    "view_revision",
    "usr_1",
    "support@example.com",
    definition("Renamed again"),
  );
  await assert.rejects(
    () =>
      service.create("usr_1", "support@example.com", definition(), operationId),
    (error: unknown) =>
      error instanceof SavedViewError &&
      error.code === "CREATION_SUPERSEDED" &&
      error.currentRevision === latest.updatedAt,
  );
  db.close();
});

test("D1 expires the exact terminal operation even beyond the bounded prune batch", async () => {
  const db = savedViewDatabase();
  let nextId = 0;
  let clock = 2_000_000_000_000;
  const service = createSavedViewService({
    store: savedViewD1Store({ DB: d1(db) }),
    canAccessMailbox: async () => true,
    now: () => ++clock,
    id: () => `view_expiry_${++nextId}`,
  });
  const operationId = "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147";
  const first = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  await service.update(
    first.id,
    "usr_1",
    "support@example.com",
    definition("Renamed old view"),
  );
  db.prepare("UPDATE saved_view_create_operations SET updated_at = 1").run();
  const seed = db.prepare(
    `INSERT INTO saved_view_create_operations
     (operation_key, fingerprint, owner_user_id, mailbox_address, view_id, state, updated_at)
     VALUES (?, ?, 'usr_1', 'support@example.com', ?, 'unavailable', 1)`,
  );
  for (let index = 0; index < 101; index++) {
    seed.run(
      `old-${index}`.padEnd(64, "x"),
      "f".repeat(64),
      `missing_${index}`,
    );
  }
  const retry = await service.create(
    "usr_1",
    "support@example.com",
    definition(),
    operationId,
  );
  assert.equal(retry.replayed, false);
  assert.notEqual(retry.id, first.id);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM saved_view_create_operations WHERE operation_key LIKE 'old-%'",
      )
      .get()!.count,
    2,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM saved_view_create_operations WHERE state = 'active'",
      )
      .get()!.count,
    1,
  );
  db.close();
});
