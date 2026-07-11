import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
	new URL("../../migrations/0005_auth_security.sql", import.meta.url),
	"utf8",
)
	.replace(/\s+/g, " ")
	.toLowerCase();

test("auth security migration persists login throttles without storing emails or IPs", () => {
	assert.match(migration, /create table if not exists login_throttles/);
	assert.match(migration, /throttle_key text primary key/);
	assert.match(migration, /failure_count integer not null/);
	assert.match(migration, /locked_until integer not null/);
	assert.match(migration, /idx_login_throttles_updated_at/);
	assert.match(migration, /create table if not exists login_attempt_leases/);
	assert.match(migration, /primary key \(attempt_id, throttle_key\)/);
	assert.match(migration, /idx_login_attempt_leases_expiry/);
});

test("auth security migration versions user sessions for password-reset revocation", () => {
	assert.match(
		migration,
		/alter table users add column session_version integer not null default 1/,
	);
});
