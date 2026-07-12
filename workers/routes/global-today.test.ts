import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { createGlobalTodayRoutes, type GlobalTodayRouteContext } from "./global-today.ts";

function app(session?: SessionClaims) {
	const root = new Hono<GlobalTodayRouteContext>();
	root.use("*", async (c, next) => {
		if (session) c.set("session", session);
		await next();
	});
	root.route("/", createGlobalTodayRoutes({
		operations: () => ({
			listAccessibleMailboxes: async () => [],
			canAccessMailbox: async () => false,
			listReminderPage: async () => ({ reminders: [], nextCursor: null }),
			readMailbox: async () => ({ unreadConversationCount: 0, unreadPreviews: [], reminderPreviews: [] }),
			now: () => Date.parse("2026-07-12T12:00:00.000Z"),
		}),
	}));
	return root;
}

const session = { sub: "user-a", email: "user@example.com", mailbox: "user@example.com", role: "AGENT", sessionVersion: 1 } satisfies SessionClaims;

test("global Today requires authentication before aggregate work", async () => {
	const response = await app().request("http://mail.example.com/api/v1/today?timeZone=Africa%2FCairo");
	assert.equal(response.status, 401);
});

test("global Today accepts only one valid timezone query", async () => {
	for (const query of ["", "?timeZone=Mars%2FOlympus", "?timeZone=UTC&mailboxId=secret@example.com", "?timeZone=UTC&timeZone=Africa%2FCairo"]) {
		const response = await app(session).request(`http://mail.example.com/api/v1/today${query}`);
		assert.equal(response.status, 400);
	}
	const response = await app(session).request("http://mail.example.com/api/v1/today?timeZone=Africa%2FCairo");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal((await response.json() as { state: string }).state, "ready");
});
