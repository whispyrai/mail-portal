import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

function legacyDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0001_create_users.sql",
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
  return database;
}

test("migration 0012 aborts before changing a database with legacy destinations", () => {
  const database = legacyDatabase();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, mailbox_address, recovery_email,
      created_at, updated_at)
     VALUES ('legacy-user', 'legacy@wiserchat.ai', 'hash', 'salt',
             'legacy@wiserchat.ai', 'private@personal.example', 1, 1)`,
  ).run();
  const migration = readFileSync(
    new URL("../../migrations/0012_create_credential_recovery_jobs.sql", import.meta.url),
    "utf8",
  );
  database.exec("BEGIN IMMEDIATE");
  assert.throws(() => database.exec(migration), /must be reconciled and scrubbed/);
  database.exec("ROLLBACK");
  assert.equal(
    database.prepare(
      "SELECT recovery_email FROM users WHERE id = 'legacy-user'",
    ).get()!.recovery_email,
    "private@personal.example",
  );
  assert.equal(
    database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'credential_recovery_request_jobs'",
    ).get()!.count,
    0,
  );
  database.close();
});

test("credential recovery durability migration creates encrypted leased lanes after explicit scrub", () => {
  const database = legacyDatabase();
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, mailbox_address, recovery_email,
      created_at, updated_at)
     VALUES ('legacy-user', 'legacy@wiserchat.ai', 'hash', 'salt',
             'legacy@wiserchat.ai', 'private@personal.example', 1, 1)`,
  ).run();
  database.prepare(
    "UPDATE users SET recovery_email = NULL WHERE id = 'legacy-user'",
  ).run();
  database.exec(
    readFileSync(
      new URL("../../migrations/0012_create_credential_recovery_jobs.sql", import.meta.url),
      "utf8",
    ),
  );
  assert.throws(
    () =>
      database.prepare(
        "UPDATE users SET recovery_email = 'must-not-persist@personal.example' WHERE id = 'legacy-user'",
      ).run(),
    /retired/,
  );

  const tables = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'credential_recovery_%' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, [
    "credential_recovery_audit",
    "credential_recovery_control",
    "credential_recovery_delivery_attempts",
    "credential_recovery_delivery_events",
    "credential_recovery_delivery_outbox",
    "credential_recovery_request_jobs",
    "credential_recovery_request_limits",
    "credential_recovery_tokens",
  ]);
  assert.deepEqual(
    { ...database.prepare(
      "SELECT control_id, enabled, updated_at FROM credential_recovery_control",
    ).get()! },
    { control_id: "global", enabled: 0, updated_at: 0 },
  );

  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO credential_recovery_request_jobs
           (id, account_ref, payload_key_version, payload_iv, payload_ciphertext,
            state, attempt_count, next_attempt_at, created_at, updated_at)
           VALUES ('job', 'short', 1, 'AAAAAAAAAAAAAAAA', 'ciphertext',
                   'pending', 0, 1, 1, 1)`,
        )
        .run(),
    /constraint/i,
  );
  database.prepare(
    `INSERT INTO users
     (id, email, password_hash, password_salt, mailbox_address, created_at, updated_at)
     VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt', 'member@wiserchat.ai', 1, 1)`,
  ).run();
  database.prepare(
    `INSERT INTO credential_recovery_tokens
     (id, user_id, token_hash, expires_at, purpose, created_at)
     VALUES ('token-1', 'user-1', 'token-hash', 100, 'recovery', 1)`,
  ).run();
  database.prepare(
    `INSERT INTO credential_recovery_delivery_outbox
     (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
      state, next_attempt_at, created_at, updated_at)
     VALUES ('delivery-1', 'token-1', 1, 'AAAAAAAAAAAAAAAA',
             'abcdefghijklmnopqrstuvwxyz', 'pending', 1, 1, 1)`,
  ).run();
  assert.throws(
    () => database.prepare("DELETE FROM credential_recovery_tokens").run(),
    /foreign key/i,
  );
  database.close();
});
