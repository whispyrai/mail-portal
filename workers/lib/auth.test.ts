import assert from "node:assert/strict";
import test from "node:test";
import {
	sessionMatchesUserVersion,
	signSession,
	verifySession,
} from "./auth.ts";

test("signed sessions carry the credential version used to revoke them", async () => {
	const token = await signSession(
		{
			sub: "usr_member",
			email: "member@wiserchat.ai",
			role: "AGENT",
			mailbox: "member@wiserchat.ai",
			sessionVersion: 3,
		},
		"test-secret",
	);

	assert.equal((await verifySession(token, "test-secret"))?.sessionVersion, 3);
});

test("a password reset revokes old sessions while preserving pre-migration version-one sessions", () => {
	assert.equal(
		sessionMatchesUserVersion({ sessionVersion: 1 }, { session_version: 2 }),
		false,
	);
	assert.equal(
		sessionMatchesUserVersion({}, { session_version: 1 }),
		true,
	);
	assert.equal(
		sessionMatchesUserVersion({}, { session_version: 2 }),
		false,
	);
});
