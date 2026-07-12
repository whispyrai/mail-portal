import assert from "node:assert/strict";
import test from "node:test";
import { bypassMailboxContentAuthorization } from "./mailbox.ts";

test("only the exact typed signature settings methods bypass mailbox content authorization", () => {
	assert.equal(bypassMailboxContentAuthorization("GET", "/api/v1/mailboxes/team@example.com/settings"), true);
	assert.equal(bypassMailboxContentAuthorization("PATCH", "/api/v1/mailboxes/team@example.com/settings/signature"), true);
	for (const [method, path] of [
		["GET", "/api/v1/mailboxes/team@example.com/emails"],
		["PATCH", "/api/v1/mailboxes/team@example.com/settings"],
		["GET", "/api/v1/mailboxes/team@example.com/settings/signature"],
		["PUT", "/api/v1/mailboxes/team@example.com"],
	]) assert.equal(bypassMailboxContentAuthorization(method, path), false, `${method} ${path}`);
});
