import assert from "node:assert/strict";
import test from "node:test";
import { fetchTodayBrief } from "./today-brief.ts";

test("Today brief request sends only the local timezone to the mailbox-scoped route", async () => {
	let requestedUrl = "";
	let requestedInit: RequestInit | undefined;
	const response = await fetchTodayBrief(
		"team+sales@example.com",
		{ timeZone: "Africa/Cairo" },
		async (input, init) => {
			requestedUrl = String(input);
			requestedInit = init;
			return Response.json({
				state: "generated",
				fingerprint: "fingerprint-1",
				generatedAt: "2026-07-12T06:00:00.000Z",
				counts: { privateRemindersDue: 1, unreadConversations: 2 },
				omittedCount: 0,
				items: [],
			});
		},
	);

	assert.equal(
		requestedUrl,
		"/api/v1/mailboxes/team%2Bsales%40example.com/today-brief",
	);
	assert.equal(requestedInit?.method, "POST");
	assert.equal(requestedInit?.credentials, "same-origin");
	assert.equal(requestedInit?.body, JSON.stringify({ timeZone: "Africa/Cairo" }));
	assert.deepEqual(response.counts, {
		privateRemindersDue: 1,
		unreadConversations: 2,
	});
});

test("Today brief forwards cancellation and preserves a recoverable API error", async () => {
	const controller = new AbortController();
	let receivedSignal: AbortSignal | null | undefined;
	await assert.rejects(
		fetchTodayBrief(
			"team@example.com",
			{ timeZone: "UTC" },
			async (_input, init) => {
				receivedSignal = init?.signal;
				return Response.json(
					{ error: "Today brief could not be prepared" },
					{ status: 503 },
				);
			},
			controller.signal,
		),
		(error) => {
			assert.ok(error instanceof Error);
			assert.equal(error.name, "TodayBriefApiError");
			assert.ok("status" in error);
			assert.equal(error.status, 503);
			assert.equal(error.message, "Today brief could not be prepared");
			return true;
		},
	);
	assert.equal(receivedSignal, controller.signal);
});
