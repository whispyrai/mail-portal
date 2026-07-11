import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("credential recovery migration stores hashed expiring single-use tokens", () => {
	const sql = readFileSync(new URL("../../migrations/0006_credential_recovery.sql", import.meta.url), "utf8").toLowerCase();
	assert.match(sql, /recovery_email/);
	assert.match(sql, /token_hash text not null unique/);
	assert.match(sql, /expires_at integer not null/);
	assert.match(sql, /consumed_at integer/);
	assert.match(sql, /ownership_confirmed_at integer/);
	assert.match(sql, /update users set ownership_confirmed_at = updated_at/);
	assert.match(sql, /credential_recovery_audit/);
	assert.match(sql, /credential_recovery_audit_no_update/);
	assert.match(sql, /credential_recovery_audit_no_delete/);
	assert.match(sql, /credential_recovery_request_limits/);
	assert.doesNotMatch(sql, /raw_token|token_plaintext/);
});
