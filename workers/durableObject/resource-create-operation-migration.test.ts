import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { resourceCreateOperations } from "../db/schema.ts";
import { savedViewCreateOperations } from "../db/users-schema.ts";
import { mailboxMigrations } from "./migrations.ts";

test("Mailbox resource create operations retain content-free lifecycle truth", () => {
  const migration = mailboxMigrations.find(
    (item) => item.name === "35_add_resource_create_operations",
  );
  assert.ok(migration);
  assert.match(migration.sql, /CREATE TABLE resource_create_operations/);
  assert.match(
    migration.sql,
    /operation_key TEXT PRIMARY KEY CHECK\(length\(operation_key\) = 64\)/,
  );
  assert.match(
    migration.sql,
    /fingerprint TEXT NOT NULL CHECK\(length\(fingerprint\) = 64\)/,
  );
  assert.match(
    migration.sql,
    /resource_kind TEXT NOT NULL CHECK\(resource_kind IN \('folder', 'label'\)\)/,
  );
  assert.match(
    migration.sql,
    /state TEXT NOT NULL CHECK\(state IN \('active', 'superseded', 'unavailable'\)\)/,
  );
  assert.match(migration.sql, /idx_resource_create_operations_resource/);
  assert.match(migration.sql, /idx_resource_create_operations_retention/);
  assert.match(migration.sql, /WHERE state IN \('superseded', 'unavailable'\)/);
  for (const forbidden of [
    "name TEXT",
    "color TEXT",
    "payload",
    "result_json",
    "actor_id",
  ]) {
    assert.doesNotMatch(migration.sql, new RegExp(forbidden, "i"));
  }
  assert.deepEqual(
    getTableConfig(resourceCreateOperations).checks.map(
      (constraint) => constraint.name,
    ),
    [
      "resource_create_operations_key_length_check",
      "resource_create_operations_fingerprint_length_check",
      "resource_create_operations_kind_check",
      "resource_create_operations_state_check",
    ],
  );
  assert.deepEqual(
    getTableConfig(savedViewCreateOperations).checks.map(
      (constraint) => constraint.name,
    ),
    [
      "saved_view_create_operations_key_length_check",
      "saved_view_create_operations_fingerprint_length_check",
      "saved_view_create_operations_state_check",
    ],
  );
});
