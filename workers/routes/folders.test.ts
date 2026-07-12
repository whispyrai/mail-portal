import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleDeleteFolder } from "./folders.ts";

const mailboxId = "hello@wiserchat.ai";

function testApp(result: "deleted" | "not_found" | "protected" | "not_empty") {
	const stub = {
		async getAutomationTargetUsage() { return []; },
		async deleteFolder(id: string, actor: unknown) {
			assert.equal(id, "projects");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return result;
		},
	};
	const env = {};
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "hesham@wiserchat.ai",
			role: "AGENT",
			mailbox: "hesham@wiserchat.ai",
		});
		await next();
	});
	app.delete(
		"/api/v1/mailboxes/:mailboxId/folders/:id",
		handleDeleteFolder,
	);

	return { app, env };
}

test("deleting an empty custom folder succeeds", async () => {
	const { app, env } = testApp("deleted");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 204);
	assert.equal(await response.text(), "");
});

test("deleting a non-empty custom folder is rejected", async () => {
	const { app, env } = testApp("not_empty");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Move or delete all emails before deleting this folder",
	});
});

test("deleting a protected system folder is forbidden", async () => {
	const { app, env } = testApp("protected");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "System folders cannot be deleted",
	});
});

test("deleting an unknown folder returns not found", async () => {
	const { app, env } = testApp("not_found");

	const response = await app.request(
		`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/folders/projects`,
		{ method: "DELETE" },
		env as never,
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Folder not found" });
});
