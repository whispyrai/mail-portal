import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_MCP_SCOPES,
	MCP_SCOPES,
	mcpCredentialVersionMatches,
	quizAuthorizationFailure,
} from "./mcp-authorization.ts";

test("OAuth advertises dedicated quiz scopes but defaults to email-only access", () => {
	assert.deepEqual(DEFAULT_MCP_SCOPES, ["email.read", "email.send"]);
	assert.deepEqual(MCP_SCOPES, [
		"email.read",
		"email.send",
		"quiz.read",
		"quiz.write",
	]);
});

test("MCP credentials are revoked when the user's credential generation changes", () => {
	assert.equal(
		mcpCredentialVersionMatches(
			{ sessionVersion: 2 },
			{ session_version: 2 },
		),
		true,
	);
	assert.equal(
		mcpCredentialVersionMatches(
			{ sessionVersion: 1 },
			{ session_version: 2 },
		),
		false,
	);
	assert.equal(
		mcpCredentialVersionMatches({}, { session_version: 1 }),
		true,
	);
});

test("quiz reads require quiz.read even for a live administrator", async () => {
	const failure = await quizAuthorizationFailure(
		{ userId: "admin", scopes: ["email.read"] },
		"read",
		async () => ({ role: "ADMIN", is_active: 1, session_version: 1 }),
	);
	assert.match(failure ?? "", /quiz\.read/);
});

test("quiz writes require quiz.write rather than quiz.read", async () => {
	const failure = await quizAuthorizationFailure(
		{ userId: "admin", scopes: ["quiz.read"] },
		"write",
		async () => ({ role: "ADMIN", is_active: 1, session_version: 1 }),
	);
	assert.match(failure ?? "", /quiz\.write/);
});

test("a deactivated administrator is rejected using live identity", async () => {
	const failure = await quizAuthorizationFailure(
		{ userId: "admin", scopes: ["quiz.write"] },
		"write",
		async () => ({ role: "ADMIN", is_active: 0, session_version: 1 }),
	);
	assert.match(failure ?? "", /active administrator/);
});

test("live administrator authority permits the scoped quiz operation", async () => {
	const failure = await quizAuthorizationFailure(
		{ userId: "admin", scopes: ["quiz.read"] },
		"read",
		async () => ({ role: "ADMIN", is_active: 1, session_version: 1 }),
	);
	assert.equal(failure, null);
});
