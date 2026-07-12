import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchMailboxMessageLocation,
	MailboxMessageLocationApiError,
} from "./mailbox-message-location.ts";

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

test("message resolver encodes mailbox and message IDs and validates identity", async () => {
	let requested = "";
	const location = await fetchMailboxMessageLocation("team@example.test", "m/1", {
		fetcher: async (input) => {
			requested = String(input);
			return response({ emailId: "m/1", folderId: "archive" });
		},
	});
	assert.equal(requested, "/api/v1/mailboxes/team%40example.test/emails/m%2F1/location");
	assert.deepEqual(location, { emailId: "m/1", folderId: "archive" });
});

test("message resolver preserves direct 403 for immediate Mailbox exit", async () => {
	await assert.rejects(
		fetchMailboxMessageLocation("mailbox", "message", {
			fetcher: async () => response({ error: "Forbidden" }, 403),
		}),
		(error: unknown) => error instanceof MailboxMessageLocationApiError && error.status === 403,
	);
});
