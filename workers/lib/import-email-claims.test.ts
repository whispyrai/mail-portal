import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  claimImportedEmail,
  releaseImportedEmailClaim,
  renewImportedEmailClaim,
} from "./import-email-claims.ts";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		CREATE TABLE import_generation_claims (
			message_id TEXT PRIMARY KEY,
			claim_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE import_promotion_intents (
			email_id TEXT NOT NULL,
			claim_token TEXT NOT NULL,
			state TEXT NOT NULL,
			lease_token TEXT,
			lease_expires_at INTEGER,
			reconciliation_phase TEXT,
			reconciliation_cycle INTEGER NOT NULL DEFAULT 1,
			validation_cursor INTEGER NOT NULL DEFAULT 0,
			settlement_cursor INTEGER NOT NULL DEFAULT 0,
			next_reconcile_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY(email_id, claim_token)
		);
	`);
  return {
    db,
    sql: {
      exec<T extends Record<string, string | number | null>>(
        query: string,
        ...bindings: Array<string | number | null>
      ) {
        return db.prepare(query).all(...bindings) as T[];
      },
    },
  };
}

test("import claims are exclusive, token-scoped, and recover after expiry", () => {
  const { db, sql } = database();
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "winner", 100, 200),
    { status: "claimed" },
  );
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "loser", 150, 250),
    { status: "busy" },
  );
  releaseImportedEmailClaim(sql, "scoped", "loser");
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "loser", 150, 250),
    { status: "busy" },
  );
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "recovery", 200, 300),
    { status: "claimed" },
  );
  db.close();
});

test("a committed scoped or legacy email wins over claim residue", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "token", 100, 200);
  db.prepare("INSERT INTO emails VALUES (?)").run("legacy");
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "next", 110, 210),
    {
      status: "existing",
      id: "legacy",
    },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM import_generation_claims").get()
      ?.total,
    0,
  );
  db.close();
});

test("only the live claim owner can renew its fencing lease", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "owner", 100, 200);
  assert.equal(
    renewImportedEmailClaim(sql, "scoped", "other", 150, 300),
    false,
  );
  assert.equal(renewImportedEmailClaim(sql, "scoped", "owner", 150, 300), true);
  assert.equal(
    db.prepare("SELECT expires_at FROM import_generation_claims").get()
      ?.expires_at,
    300,
  );
  assert.equal(
    renewImportedEmailClaim(sql, "scoped", "owner", 300, 400),
    false,
  );
  db.close();
});

test("expiry detaches a sealed intent and a stale release cannot touch its successor", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "old-owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES (?, ?, 'recorded', 'validation', ?, ?)`,
  ).run("scoped", "old-owner", 200, 100);
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "successor", 200, 300),
    { status: "claimed" },
  );
  assert.equal(
    db.prepare("SELECT state FROM import_promotion_intents").get()?.state,
    "abandoned_watching",
  );
  assert.equal(releaseImportedEmailClaim(sql, "scoped", "old-owner"), false);
  assert.equal(
    db.prepare("SELECT claim_token FROM import_generation_claims").get()
      ?.claim_token,
    "successor",
  );
  db.close();
});

test("release refuses a sealed non-finalized intent and renewal extends its watch deadline", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES (?, ?, 'recorded', 'validation', ?, ?)`,
  ).run("scoped", "owner", 200, 100);
  assert.equal(releaseImportedEmailClaim(sql, "scoped", "owner"), false);
  assert.equal(renewImportedEmailClaim(sql, "scoped", "owner", 150, 400), true);
  assert.equal(
    db.prepare("SELECT next_reconcile_at FROM import_promotion_intents").get()
      ?.next_reconcile_at,
    400,
  );
  db.close();
});

test("releasing an unsealed claim removes its byte-free staging intent", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, next_reconcile_at, updated_at)
     VALUES (?, ?, 'staging', ?, ?)`,
  ).run("scoped", "owner", 200, 100);
  assert.equal(releaseImportedEmailClaim(sql, "scoped", "owner"), true);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM import_promotion_intents").get()
      ?.total,
    0,
  );
  db.close();
});

test("an integrity-blocked claim stays frozen after expiry", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "blocked-owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES (?, ?, 'integrity_blocked', 'validation', ?, ?)`,
  ).run("scoped", "blocked-owner", 200, 100);

  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "successor", 200, 300),
    { status: "busy" },
  );
  assert.equal(
    db.prepare("SELECT claim_token FROM import_generation_claims").get()
      ?.claim_token,
    "blocked-owner",
  );
  db.close();
});

test("a committed email does not erase an integrity-blocked claim", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "scoped", "legacy", "blocked-owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES (?, ?, 'integrity_blocked', 'validation', ?, ?)`,
  ).run("scoped", "blocked-owner", 200, 100);
  db.prepare("INSERT INTO emails VALUES (?)").run("scoped");

  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "successor", 150, 300),
    { status: "busy" },
  );
  assert.equal(
    db.prepare("SELECT claim_token FROM import_generation_claims").get()
      ?.claim_token,
    "blocked-owner",
  );
  db.close();
});
