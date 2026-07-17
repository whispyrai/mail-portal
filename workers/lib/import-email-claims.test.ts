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
		CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT NOT NULL);
		CREATE TABLE import_generation_claims (
			message_id TEXT PRIMARY KEY,
			claim_token TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			legacy_id TEXT,
			identity_source TEXT,
			raw_sha256 TEXT
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
		CREATE TABLE import_source_identities (
			email_id TEXT PRIMARY KEY,
			raw_sha256 TEXT NOT NULL,
			created_at INTEGER NOT NULL
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
  db.prepare("INSERT INTO emails VALUES (?, ?)").run("legacy", "inbox");
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "next", 110, 210),
    {
      status: "existing",
      id: "legacy",
      folder: "inbox",
    },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM import_generation_claims").get()
      ?.total,
    0,
  );
  db.close();
});

test("scoped and legacy duplicate claims return the authoritative persisted folder", () => {
  const { db, sql } = database();
  db.prepare("INSERT INTO emails VALUES (?, ?)").run("legacy", "inbox");
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "legacy-check", 100, 200),
    { status: "existing", id: "legacy", folder: "inbox" },
  );

  db.prepare("INSERT INTO emails VALUES (?, ?)").run("scoped", "sent");
  assert.deepEqual(
    claimImportedEmail(sql, "scoped", "legacy", "scoped-check", 100, 200),
    { status: "existing", id: "scoped", folder: "sent" },
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
  db.prepare("INSERT INTO emails VALUES (?, ?)").run("scoped", "archive");

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

test("no-Message-ID duplicates require matching durable exact source evidence", () => {
  const { db, sql } = database();
  const digest = "a".repeat(64);
  db.prepare("INSERT INTO emails VALUES (?, ?)").run("scoped", "inbox");
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "exact-evidence-token",
      100,
      200,
      "raw-sha256",
      digest,
    ),
    { status: "identity_conflict", id: "scoped" },
  );
  db.prepare(
    "INSERT INTO import_source_identities (email_id, raw_sha256, created_at) VALUES (?, ?, ?)",
  ).run("scoped", digest, 100);
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "exact-evidence-token",
      100,
      200,
      "raw-sha256",
      digest,
    ),
    { status: "existing", id: "scoped", folder: "inbox", rawSha256: digest },
  );
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "different-evidence-token",
      100,
      200,
      "raw-sha256",
      "b".repeat(64),
    ),
    { status: "identity_conflict", id: "scoped" },
  );
  db.close();
});

test("exact source evidence survives Message deletion and gates reconstruction", () => {
  const { db, sql } = database();
  const digest = "c".repeat(64);
  db.prepare(
    "INSERT INTO import_source_identities (email_id, raw_sha256, created_at) VALUES (?, ?, ?)",
  ).run("scoped", digest, 100);
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "reconstruct-token",
      100,
      200,
      "raw-sha256",
      digest,
    ),
    { status: "claimed" },
  );
  releaseImportedEmailClaim(sql, "scoped", "reconstruct-token");
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "collision-token",
      100,
      200,
      "raw-sha256",
      "d".repeat(64),
    ),
    { status: "identity_conflict", id: "scoped" },
  );
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped",
      "scoped",
      "message-id-token",
      100,
      200,
      "message-id",
      null,
    ),
    { status: "identity_conflict", id: "scoped" },
  );
  db.close();
});

test("only the winning no-Message-ID claim atomically reserves permanent evidence", () => {
  const { db, sql } = database();
  claimImportedEmail(sql, "busy", "busy", "message-id-winner", 100, 300);
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "busy",
      "busy",
      "raw-busy-loser",
      110,
      310,
      "raw-sha256",
      "a".repeat(64),
    ),
    { status: "busy" },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM import_source_identities WHERE email_id = 'busy'").get()?.count,
    0,
  );

  db.prepare("INSERT INTO emails VALUES ('existing', 'sent')").run();
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "existing",
      "existing",
      "raw-existing-loser",
      100,
      200,
      "raw-sha256",
      "b".repeat(64),
    ),
    { status: "identity_conflict", id: "existing" },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM import_source_identities WHERE email_id = 'existing'").get()?.count,
    0,
  );

  claimImportedEmail(sql, "blocked", "blocked", "blocked-owner", 100, 200);
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES ('blocked', 'blocked-owner', 'integrity_blocked', 'validation', 200, 100)`,
  ).run();
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "blocked",
      "blocked",
      "raw-blocked-loser",
      110,
      210,
      "raw-sha256",
      "c".repeat(64),
    ),
    { status: "busy" },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM import_source_identities WHERE email_id = 'blocked'").get()?.count,
    0,
  );

  const digest = "d".repeat(64);
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "winner",
      "winner",
      "raw-winning-token",
      100,
      200,
      "raw-sha256",
      digest,
    ),
    { status: "claimed" },
  );
  assert.equal(
    db.prepare("SELECT raw_sha256 FROM import_source_identities WHERE email_id = 'winner'").get()?.raw_sha256,
    digest,
  );
  db.close();
});

test("claim-response loss, expiry, staging, and recorded abandonment preserve exact resumability", () => {
  const { db, sql } = database();
  const digest = "e".repeat(64);
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "source",
      "source",
      "lost-response-owner",
      100,
      200,
      "raw-sha256",
      digest,
    ),
    { status: "claimed" },
  );
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "source",
      "source",
      "early-retry",
      150,
      250,
      "raw-sha256",
      digest,
    ),
    { status: "busy" },
  );
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, next_reconcile_at, updated_at)
     VALUES ('source', 'lost-response-owner', 'staging', 200, 100)`,
  ).run();
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "source",
      "source",
      "after-staging-expiry",
      200,
      300,
      "raw-sha256",
      digest,
    ),
    { status: "claimed" },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM import_promotion_intents WHERE email_id = 'source'").get()?.count,
    0,
  );
  db.prepare(
    `INSERT INTO import_promotion_intents
     (email_id, claim_token, state, reconciliation_phase, next_reconcile_at, updated_at)
     VALUES ('source', 'after-staging-expiry', 'recorded', 'validation', 300, 200)`,
  ).run();
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "source",
      "source",
      "after-recorded-expiry",
      300,
      400,
      "raw-sha256",
      digest,
    ),
    { status: "claimed" },
  );
  assert.equal(
    db.prepare("SELECT state FROM import_promotion_intents WHERE email_id = 'source'").get()?.state,
    "abandoned_watching",
  );
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "source",
      "source",
      "different-source",
      310,
      410,
      "raw-sha256",
      "f".repeat(64),
    ),
    { status: "identity_conflict", id: "source" },
  );
  db.close();
});

test("distinct legacy identity candidates cannot suppress raw-reserved evidence", () => {
  const { db, sql } = database();
  db.prepare("INSERT INTO emails VALUES ('legacy', 'archive')").run();
  db.prepare(
    "INSERT INTO import_source_identities (email_id, raw_sha256, created_at) VALUES ('legacy', ?, 1)",
  ).run("a".repeat(64));
  assert.deepEqual(
    claimImportedEmail(
      sql,
      "scoped-message-id",
      "legacy",
      "message-id-token",
      100,
      200,
      "message-id",
      null,
    ),
    { status: "identity_conflict", id: "legacy" },
  );
  db.close();
});
