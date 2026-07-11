import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import {
	createSnoozeRoutes,
	type SnoozeRouteContext,
	type SnoozeRouteOperations,
} from "./snooze.ts";

const session: SessionClaims = {
	sub: "usr_1",
	email: "one@example.com",
	role: "AGENT",
	mailbox: "one@example.com",
};

function appWith(operations: SnoozeRouteOperations) {
	const app = new Hono<SnoozeRouteContext>();
	app.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	app.route("/", createSnoozeRoutes({ operations: () => operations }));
	return app;
}

function request(app: Hono<SnoozeRouteContext>, path: string, body: unknown) {
	return app.request(`http://mail.example.com${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	}, {} as Env);
}

test("snooze route validates and attributes an anchored conversation", async () => {
	let received: unknown;
	const app = appWith({
		async snooze(input, actor) {
			received = { input, actor };
			return { status: "snoozed", affectedCount: 2 };
		},
		async unsnooze() {
			return { status: "unsnoozed", affectedCount: 1 };
		},
	});
	const response = await request(
		app,
		"/api/v1/mailboxes/support%40example.com/snooze",
		{
			scope: {
				kind: "conversation",
				conversationId: "conversation_1",
				emailId: "mail_1",
				folderId: "inbox",
			},
			wakeAt: new Date(Date.now() + 3_600_000).toISOString(),
		},
	);
	assert.equal(response.status, 200);
	assert.deepEqual((received as { actor: unknown }).actor, {
		kind: "user",
		id: "usr_1",
	});
});

test("unsnooze is explicit and validation errors fail before the mailbox", async () => {
	let calls = 0;
	const app = appWith({
		async snooze() {
			calls++;
			return { status: "snoozed", affectedCount: 1 };
		},
		async unsnooze(scope) {
			calls++;
			assert.deepEqual(scope, { kind: "message", emailId: "mail_1" });
			return { status: "unsnoozed", affectedCount: 1 };
		},
	});
	assert.equal((await request(
		app,
		"/api/v1/mailboxes/support%40example.com/snooze/clear",
		{ scope: { kind: "message", emailId: "mail_1" } },
	)).status, 200);
	assert.equal((await request(
		app,
		"/api/v1/mailboxes/support%40example.com/snooze",
		{ scope: { kind: "message", emailId: "" }, wakeAt: "bad" },
	)).status, 400);
	assert.equal(calls, 1);
});

test("snooze route exposes stable conflict codes", async () => {
	for (const status of [
		"ineligible",
		"too_large",
		"outbound_delivery_active",
		"not_found",
	] as const) {
		const app = appWith({
			async snooze() { return { status, affectedCount: 0 }; },
			async unsnooze() { return { status, affectedCount: 0 }; },
		});
		const response = await request(
			app,
			"/api/v1/mailboxes/support%40example.com/snooze/clear",
			{ scope: { kind: "message", emailId: "mail_1" } },
		);
		assert.equal(response.status, status === "not_found" ? 404 : 409);
		assert.deepEqual(await response.json(), {
			error: status === "not_found"
				? "Message or conversation was not found"
				: "Snooze state could not be changed",
			code: status,
		});
	}
});
