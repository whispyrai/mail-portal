import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  importPromotionIntentObjects,
  importPromotionIntents,
} from "../db/schema.ts";
import { mailboxMigrations } from "../durableObject/migrations.ts";
import {
  advanceImportPromotionFingerprint,
  appendImportPromotionIntent,
  beginImportPromotionIntent,
  importPromotionFingerprint,
  importPromotionInitialFingerprint,
  readImportPromotionAppendSnapshot,
  sealImportPromotionIntent,
  type ImportPromotionObject,
  type ImportPromotionSql,
} from "./import-promotion-intent.ts";

const identity = {
  emailId: "0123456789abcdef0123456789abcdef",
  claimToken: "123e4567-e89b-42d3-a456-426614174000",
};

function state(expiresAt = 10_000) {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE attachments (id TEXT PRIMARY KEY)");
  for (const migrationName of [
    "22_add_import_generation_claims",
    "36_add_inbound_durability",
  ]) {
    const migration = mailboxMigrations.find(
      ({ name }) => name === migrationName,
    );
    assert.ok(migration);
    if (migrationName === "36_add_inbound_durability") {
      const intentSql = migration.sql.slice(
        migration.sql.indexOf("CREATE TABLE import_promotion_intents"),
        migration.sql.lastIndexOf("COMMIT;"),
      );
      database.exec(intentSql);
    } else {
      database.exec(migration.sql);
    }
  }
  database
    .prepare("INSERT INTO import_generation_claims VALUES (?, ?, ?, ?)")
    .run(identity.emailId, identity.claimToken, expiresAt, 1);
  const sql: ImportPromotionSql = {
    exec<T extends Record<string, string | number | null>>(
      query: string,
      ...bindings: Array<string | number | null>
    ) {
      return database.prepare(query).all(...bindings) as T[];
    },
  };
  return { database, sql };
}

function object(
  ordinal: number,
  byteLength = ordinal + 1,
): ImportPromotionObject {
  return {
    ordinal,
    r2Key: `attachments/${identity.emailId}/${identity.emailId}-${identity.claimToken.replaceAll("-", "")}-${ordinal}/file-${ordinal}.txt`,
    byteLength,
  };
}

async function begin(
  sql: ImportPromotionSql,
  objectCount: number,
  totalByteLength: number,
  now: number,
) {
  return beginImportPromotionIntent(
    sql,
    identity,
    objectCount,
    totalByteLength,
    await importPromotionInitialFingerprint(identity),
    now,
  );
}

async function append(
  sql: ImportPromotionSql,
  objects: readonly ImportPromotionObject[],
  now: number,
) {
  const snapshot = readImportPromotionAppendSnapshot(sql, identity);
  const next = await advanceImportPromotionFingerprint(
    identity,
    snapshot.rollingFingerprint,
    objects,
  );
  return {
    result: appendImportPromotionIntent(
      sql,
      identity,
      objects,
      snapshot,
      next,
      now,
    ),
    snapshot,
    next,
  };
}

test("begin, append, and seal are exact replay-safe and reject changed replays", async () => {
  const { database, sql } = state();
  assert.deepEqual(await begin(sql, 2, 3, 100), { status: "begun" });
  assert.deepEqual(await begin(sql, 2, 3, 100), { status: "replayed" });
  await assert.rejects(() => begin(sql, 3, 3, 100));

  const objects = [object(0), object(1)];
  const first = await append(sql, objects, 101);
  assert.deepEqual(first.result, { status: "appended" });
  assert.deepEqual(
    appendImportPromotionIntent(
      sql,
      identity,
      objects,
      first.snapshot,
      first.next,
      102,
    ),
    { status: "replayed" },
  );
  const changed = [{ ...object(1), byteLength: 2_000 }];
  const changedFingerprint = await advanceImportPromotionFingerprint(
    identity,
    first.next,
    changed,
  );
  assert.throws(() =>
    appendImportPromotionIntent(
      sql,
      identity,
      changed,
      readImportPromotionAppendSnapshot(sql, identity),
      changedFingerprint,
      103,
    ),
  );

  const fingerprint = await importPromotionFingerprint(identity, objects);
  assert.equal(first.next, fingerprint);
  assert.deepEqual(sealImportPromotionIntent(sql, identity, 104), {
    status: "sealed",
    proofFingerprint: fingerprint,
  });
  assert.deepEqual(sealImportPromotionIntent(sql, identity, 105), {
    status: "replayed",
    proofFingerprint: fingerprint,
  });
  database.close();
});

test("an empty intent seals and more than 512 objects use constant-space commitment state", async () => {
  const empty = state();
  await begin(empty.sql, 0, 0, 100);
  const emptyFingerprint = await importPromotionFingerprint(identity, []);
  assert.deepEqual(sealImportPromotionIntent(empty.sql, identity, 101), {
    status: "sealed",
    proofFingerprint: emptyFingerprint,
  });
  empty.database.close();

  const large = state();
  const objects = Array.from({ length: 513 }, (_, ordinal) => object(ordinal, 0));
  await begin(large.sql, objects.length, 0, 100);
  for (let offset = 0; offset < objects.length; offset += 20) {
    await append(large.sql, objects.slice(offset, offset + 20), 101);
  }
  const expectedFingerprint = await importPromotionFingerprint(identity, objects);
  assert.deepEqual(sealImportPromotionIntent(large.sql, identity, 102), {
    status: "sealed",
    proofFingerprint: expectedFingerprint,
  });
  assert.deepEqual(
    {
      ...large.database
      .prepare(
        `SELECT recorded_count, recorded_byte_length, rolling_fingerprint
         FROM import_promotion_intents`,
      )
      .get(),
    },
    {
      recorded_count: 513,
      recorded_byte_length: 0,
      rolling_fingerprint: expectedFingerprint,
    },
  );
  large.database.close();
});

test("the rolling commitment is independent of append batch boundaries", async () => {
  const objects = Array.from({ length: 41 }, (_, ordinal) => object(ordinal, 1));
  const expected = await importPromotionFingerprint(identity, objects);
  for (const batchSize of [1, 7, 20]) {
    const current = state();
    await begin(current.sql, objects.length, objects.length, 100);
    for (let offset = 0; offset < objects.length; offset += batchSize) {
      await append(current.sql, objects.slice(offset, offset + batchSize), 101);
    }
    assert.equal(
      readImportPromotionAppendSnapshot(current.sql, identity).rollingFingerprint,
      expected,
    );
    current.database.close();
  }
});

test("only the exact most-recent append batch is replayable", async () => {
  const { database, sql } = state();
  await begin(sql, 3, 6, 100);
  await append(sql, [object(0), object(1)], 101);
  const latest = await append(sql, [object(2)], 102);

  assert.deepEqual((await append(sql, [object(2)], 103)).result, {
    status: "replayed",
  });
  await assert.rejects(() => append(sql, [object(0), object(1)], 104));
  const changedBoundary = [object(1), object(2)];
  const changedBoundaryFingerprint = await advanceImportPromotionFingerprint(
    identity,
    latest.next,
    changedBoundary,
  );
  assert.throws(() =>
    appendImportPromotionIntent(
      sql,
      identity,
      changedBoundary,
      readImportPromotionAppendSnapshot(sql, identity),
      changedBoundaryFingerprint,
      105,
    ),
  );
  database.close();
});

test("a failed append transaction rolls back the entire batch", async () => {
  const { database, sql } = state();
  await begin(sql, 2, 3, 100);
  const objects = [object(0), object(1)];
  const snapshot = readImportPromotionAppendSnapshot(sql, identity);
  const next = await advanceImportPromotionFingerprint(
    identity,
    snapshot.rollingFingerprint,
    objects,
  );
  assert.throws(() => {
    database.exec("BEGIN");
    try {
      appendImportPromotionIntent(
        sql,
        identity,
        objects,
        snapshot,
        next,
        101,
      );
      throw new Error("controlled failure");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  });
  assert.equal(
    database
      .prepare("SELECT COUNT(*) AS count FROM import_promotion_intent_objects")
      .get()?.count,
    0,
  );
  database.close();
});

test("validation rejects non-v4 claims, escaped keys, gaps, and oversized totals", async () => {
  const { database, sql } = state();
  await assert.rejects(() => begin(sql, 1, 25 * 1024 * 1024 + 1, 100));
  await begin(sql, 2, 2, 100);
  await assert.rejects(() => append(sql, [object(0, 1), object(2, 1)], 101));
  await assert.rejects(() =>
    append(sql, [{ ...object(0), r2Key: "attachments/elsewhere" }], 101),
  );
  database.close();
});

test("the import ledger rejects invalid lifecycle and observation rows", async () => {
  const { database, sql } = state();
  await begin(sql, 1, 1, 100);
  assert.throws(() =>
    database
      .prepare(
        `UPDATE import_promotion_intents
         SET state = 'finalized', writer_closed = 1, finalized_at = 1,
             retained_count = 0, outboxed_count = 0, absent_count = 0`,
      )
      .run(),
  );
  await append(sql, [object(0, 1)], 101);
  sealImportPromotionIntent(sql, identity, 102);
  assert.throws(() =>
    database
      .prepare(
        `UPDATE import_promotion_intents
         SET state = 'finalized', writer_closed = 0,
             reconciliation_phase = NULL, finalized_at = 1,
             retained_count = 0, outboxed_count = 1, absent_count = 0`,
      )
      .run(),
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO import_promotion_intent_objects
         (email_id, claim_token, ordinal, r2_key, byte_length, resolution,
          observation_state, observation_cycle, observed_byte_length)
         VALUES (?, ?, 0, ?, 1, 'pending', 'authoritative', 1, NULL)`,
      )
      .run(identity.emailId, identity.claimToken, object(0).r2Key),
  );
  assert.throws(() =>
    database
      .prepare(
        `INSERT INTO import_promotion_intent_objects
         (email_id, claim_token, ordinal, r2_key, byte_length, resolution,
          observation_state, observation_cycle, observed_byte_length)
         VALUES (?, ?, 0, ?, 1, 'pending', 'absent', -1, NULL)`,
      )
      .run(identity.emailId, identity.claimToken, object(0).r2Key),
  );
  assert.throws(() =>
    database
      .prepare(
        `UPDATE import_promotion_intents
         SET reconciliation_phase = 'invalid'`,
      )
      .run(),
  );
  database.close();
});

test("Drizzle declares every durable import-ledger invariant", () => {
  assert.deepEqual(
    new Set(getTableConfig(importPromotionIntents).checks.map(({ name }) => name)),
    new Set([
      "import_promotion_intents_object_count",
      "import_promotion_intents_total_bytes",
      "import_promotion_intents_recorded_count",
      "import_promotion_intents_recorded_bytes",
      "import_promotion_intents_state",
      "import_promotion_intents_phase",
      "import_promotion_intents_fingerprint",
      "import_promotion_intents_last_append",
      "import_promotion_intents_writer",
      "import_promotion_intents_generations",
      "import_promotion_intents_cursors",
      "import_promotion_intents_lease_state",
      "import_promotion_intents_finalized_metadata",
      "import_promotion_intents_lifecycle",
      "import_promotion_intents_phase_cursor",
    ]),
  );
  assert.ok(
    [
      "import_promotion_objects_observation_state",
      "import_promotion_objects_observation_bounds",
      "import_promotion_objects_observation",
    ].every((name) =>
      getTableConfig(importPromotionIntentObjects).checks.some(
        (constraint) => constraint.name === name,
      ),
    ),
  );
});

test("only explicit finalizer closure may promote writer_closed", () => {
  const source = readFileSync(
    new URL("../durableObject/index.ts", import.meta.url),
    "utf8",
  );
  assert.deepEqual(source.match(/writer_closed\s*=(?!=)\s*[^,\n]+/g), [
    "writer_closed = CASE WHEN ? = 1 THEN 1 ELSE writer_closed END",
  ]);
});
