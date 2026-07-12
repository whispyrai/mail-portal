import assert from "node:assert/strict";
import test from "node:test";
import { getGlobalToday } from "./global-today.ts";

test("global Today client sends only timezone and validates the response", async () => {
	const prior = globalThis.fetch;
	let requestUrl = "";
	let credentials: RequestCredentials | undefined;
	let cache: RequestCache | undefined;
	globalThis.fetch = (async (input, init) => {
		requestUrl = String(input);
		credentials = init?.credentials;
		cache = init?.cache;
		return Response.json({
			state: "ready",
			complete: true,
			accessChanged: false,
			day: { timeZone: "Africa/Cairo", localDate: "2026-07-12", startAt: "2026-07-11T21:00:00.000Z", endAt: "2026-07-12T21:00:00.000Z" },
			currentMailboxCount: 0,
			mailboxes: [],
			failures: [],
			totals: { privateRemindersDue: 0, unreadConversations: 0 },
			generatedAt: "2026-07-12T12:00:00.000Z",
		});
	}) as typeof fetch;
	try {
		assert.equal((await getGlobalToday({ timeZone: "Africa/Cairo" })).state, "ready");
		assert.equal(requestUrl, "/api/v1/today?timeZone=Africa%2FCairo");
		assert.equal(credentials, "same-origin");
		assert.equal(cache, "no-store");
	} finally {
		globalThis.fetch = prior;
	}
});

test("global Today client rejects malformed successful data before caching", async () => {
	const prior = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ state: "ready", mailboxes: [{ secret: true }] })) as typeof fetch;
	try {
		await assert.rejects(getGlobalToday({ timeZone: "UTC" }));
	} finally {
		globalThis.fetch = prior;
	}
});
