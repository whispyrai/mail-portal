import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("saved views migration keeps personal views after mailbox access revocation", () => {
  const sql = readFileSync(
    new URL("../../migrations/0007_create_saved_views.sql", import.meta.url),
    "utf8",
  );

  assert.match(sql, /CREATE TABLE saved_views/i);
  assert.match(
    sql,
    /owner_user_id TEXT NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/i,
  );
  assert.match(sql, /mailbox_address TEXT NOT NULL/i);
  assert.doesNotMatch(sql, /mailbox_address[^\n]+REFERENCES mailboxes/i);
  assert.match(sql, /filter_json TEXT NOT NULL/i);
  assert.match(sql, /sort_column TEXT NOT NULL/i);
  assert.match(sql, /sort_direction TEXT NOT NULL/i);
  assert.match(sql, /UNIQUE \(owner_user_id, mailbox_address, name\)/i);
});
