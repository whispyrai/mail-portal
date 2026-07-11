import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleBatchTriage } from "./batch-triage.ts";

function testApp() {
	const calls: unknown[][] = [];
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("session", {
			sub: "user-1",
			email: "user@example.com",
			role: "MEMBER",
			mailbox: "user@example.com",
		});
		c.set("mailboxStub", {
			async batchTriage(...args: unknown[]) {
				calls.push(args);
				return {
					requestedCount: 2,
					succeededCount: 1,
					failedCount: 1,
					results: [
						{ emailId: "email-1", status: "updated", affectedCount: 2 },
						{ emailId: "email-2", status: "outbound_delivery_active", affectedCount: 0 },
					],
				};
			},
		} as never);
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/triage-batch", handleBatchTriage);
	return { app, calls };
}

test("batch route makes one bounded mailbox call and preserves partial failures", async () => {
	const { app, calls } = testApp();
	const targets = [
		{ emailId: "email-1", folderId: "inbox", conversationId: "thread-1" },
		{ emailId: "email-2", folderId: "inbox" },
	];
	const response = await app.request("http://local/api/v1/mailboxes/team@example.com/triage-batch", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ action: "archive", targets }),
	});

	assert.equal(response.status, 200);
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], [
		{ action: "archive", targets },
		{ kind: "user", id: "user-1" },
	]);
	assert.deepEqual(await response.json(), {
		requestedCount: 2,
		succeededCount: 1,
		failedCount: 1,
		results: [
			{ emailId: "email-1", status: "updated", affectedCount: 2 },
			{ emailId: "email-2", status: "outbound_delivery_active", affectedCount: 0 },
		],
	});
});

test("batch route rejects duplicate, empty, and oversized target sets before the mailbox", async () => {
	const { app, calls } = testApp();
	const request = (targets: unknown[]) => app.request(
		"http://local/api/v1/mailboxes/team@example.com/triage-batch",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "trash", targets }),
		},
	);
	const [empty, duplicate, oversized] = await Promise.all([
		request([]),
		request([{ emailId: "same", folderId: "inbox" }, { emailId: "same", folderId: "inbox" }]),
		request(Array.from({ length: 51 }, (_, index) => ({ emailId: `email-${index}`, folderId: "inbox" }))),
	]);
	assert.equal(empty.status, 400);
	assert.equal(duplicate.status, 400);
	assert.equal(oversized.status, 400);
	assert.equal(calls.length, 0);
});
