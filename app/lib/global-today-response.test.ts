import assert from "node:assert/strict";
import test from "node:test";
import { parseGlobalTodayResponse } from "./global-today-response.ts";

const base = {
	state: "ready",
	complete: true,
	accessChanged: false,
	day: { timeZone: "Africa/Cairo", localDate: "2026-07-12", startAt: "2026-07-11T21:00:00.000Z", endAt: "2026-07-12T21:00:00.000Z" },
	currentMailboxCount: 0,
	mailboxes: [],
	failures: [],
	totals: { privateRemindersDue: 0, unreadConversations: 0 },
	generatedAt: "2026-07-12T12:00:00.000Z",
};

test("global Today response parser enforces complete versus partial totals", () => {
	assert.equal(parseGlobalTodayResponse(base).state, "ready");
	assert.throws(() => parseGlobalTodayResponse({ ...base, complete: false }), /Partial Today cannot expose totals/);
	assert.throws(() => parseGlobalTodayResponse({ ...base, totals: null }), /Complete Today requires totals/);
});

test("global Today response parser rejects duplicate Mailbox identities and unknown fields", () => {
	const failure = { mailboxId: "team@example.com", address: "team@example.com", type: "SHARED", reason: "timeout" };
	assert.throws(() => parseGlobalTodayResponse({ ...base, complete: false, totals: null, failures: [failure, failure] }), /Mailbox identities must be unique/);
	assert.throws(() => parseGlobalTodayResponse({ ...base, leaked: "secret" }));
});
