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
	`);
	return {
		db,
		sql: {
			exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>) {
				return db.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

test("import claims are exclusive, token-scoped, and recover after expiry", () => {
	const { db, sql } = database();
	assert.deepEqual(claimImportedEmail(sql, "scoped", "legacy", "winner", 100, 200), { status: "claimed" });
	assert.deepEqual(claimImportedEmail(sql, "scoped", "legacy", "loser", 150, 250), { status: "busy" });
	releaseImportedEmailClaim(sql, "scoped", "loser");
	assert.deepEqual(claimImportedEmail(sql, "scoped", "legacy", "loser", 150, 250), { status: "busy" });
	assert.deepEqual(claimImportedEmail(sql, "scoped", "legacy", "recovery", 200, 300), { status: "claimed" });
	db.close();
});

test("a committed scoped or legacy email wins over claim residue", () => {
	const { db, sql } = database();
	claimImportedEmail(sql, "scoped", "legacy", "token", 100, 200);
	db.prepare("INSERT INTO emails VALUES (?)").run("legacy");
	assert.deepEqual(claimImportedEmail(sql, "scoped", "legacy", "next", 110, 210), {
		status: "existing",
		id: "legacy",
	});
	assert.equal(db.prepare("SELECT COUNT(*) AS total FROM import_generation_claims").get()?.total, 0);
	db.close();
});

test("only the live claim owner can renew its fencing lease", () => {
	const { db, sql } = database();
	claimImportedEmail(sql, "scoped", "legacy", "owner", 100, 200);
	assert.equal(renewImportedEmailClaim(sql, "scoped", "other", 150, 300), false);
	assert.equal(renewImportedEmailClaim(sql, "scoped", "owner", 150, 300), true);
	assert.equal(
		db.prepare("SELECT expires_at FROM import_generation_claims").get()?.expires_at,
		300,
	);
	assert.equal(renewImportedEmailClaim(sql, "scoped", "owner", 300, 400), false);
	db.close();
});
