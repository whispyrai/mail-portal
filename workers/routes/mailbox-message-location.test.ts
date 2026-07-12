import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { createMailboxMessageLocationRoutes } from "./mailbox-message-location.ts";

function app(input: {
	read?: () => Promise<unknown>;
	revalidate?: () => Promise<boolean>;
	withSession?: boolean;
}) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		if (input.withSession !== false) c.set("session", {
			sub: "actor-1",
			email: "actor@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		await next();
	});
	root.route("/", createMailboxMessageLocationRoutes({
		read: input.read ?? (async () => ({ emailId: "message-1", folderId: "archive" })),
		revalidateAccess: input.revalidate ?? (async () => true),
	}));
	return root;
}

test("Message location returns only the exact current coordinate", async () => {
	const response = await app({}).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/emails/message-1/location",
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		emailId: "message-1",
		folderId: "archive",
	});
});

test("post-read revocation and malformed storage disclose no coordinate", async () => {
	const revoked = await app({ revalidate: async () => false }).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/emails/message-1/location",
	);
	assert.equal(revoked.status, 403);
	assert.deepEqual(await revoked.json(), { error: "Forbidden" });
	const malformed = await app({
		read: async () => ({ emailId: "message-1", folderId: "archive", subject: "secret" }),
	}).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/emails/message-1/location",
	);
	assert.equal(malformed.status, 502);
	assert.deepEqual(await malformed.json(), { error: "Message location is unavailable" });
});

test("missing session or Message returns no location", async () => {
	const unauthorized = await app({ withSession: false }).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/emails/message-1/location",
	);
	assert.equal(unauthorized.status, 401);
	const missing = await app({ read: async () => null }).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/emails/message-1/location",
	);
	assert.equal(missing.status, 404);
});
