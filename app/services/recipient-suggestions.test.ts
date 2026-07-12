import assert from "node:assert/strict";
import test from "node:test";
import { fetchRecipientSuggestions } from "./recipient-suggestions.ts";

test("recipient suggestion service scopes the encoded mailbox and forwards cancellation", async () => {
	const controller = new AbortController();
	let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const suggestions = await fetchRecipientSuggestions(
		"Team+Sales@example.com",
		"ali ce",
		7,
		controller.signal,
		async (input, init) => {
			request = { input, init };
			return new Response(JSON.stringify({ suggestions: [{ address: "alice@example.com", sentCount: 1, receivedCount: 0, lastSentAt: null, lastReceivedAt: null }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	);
	assert.equal(
		request?.input,
		"/api/v1/mailboxes/Team%2BSales%40example.com/recipient-suggestions?q=ali+ce&limit=7",
	);
	assert.equal(request?.init?.signal, controller.signal);
	assert.equal(request?.init?.credentials, "same-origin");
	assert.equal(suggestions[0]?.address, "alice@example.com");
});

test("recipient suggestion service returns a stable error without leaking response fields", async () => {
	await assert.rejects(
		fetchRecipientSuggestions("team@example.com", "a", 10, undefined, async () =>
			new Response(JSON.stringify({ error: "No access", secret: "hidden" }), { status: 403 })),
		(error: unknown) => error instanceof Error && error.message === "No access",
	);
});
