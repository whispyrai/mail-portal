import assert from "node:assert/strict";
import test from "node:test";
import {
	RECIPIENT_SUGGESTION_DEBOUNCE_MS,
	recipientSuggestionKeys,
	recipientSuggestionQueryOptions,
} from "./recipient-suggestions.ts";

test("recipient suggestion queries are mailbox, token, and limit scoped", () => {
	assert.deepEqual(recipientSuggestionKeys.list("one@example.com", "ali", 10), [
		"recipient-suggestions",
		"one@example.com",
		"ali",
		10,
	]);
	assert.notDeepEqual(
		recipientSuggestionKeys.list("one@example.com", "ali", 10),
		recipientSuggestionKeys.list("two@example.com", "ali", 10),
	);
	assert.ok(RECIPIENT_SUGGESTION_DEBOUNCE_MS >= 150);
	assert.ok(RECIPIENT_SUGGESTION_DEBOUNCE_MS <= 200);
});

test("query options pass TanStack cancellation to the typed service", async () => {
	const controller = new AbortController();
	let received: unknown;
	const options = recipientSuggestionQueryOptions(
		"team@example.com",
		"ali",
		true,
		10,
		async (...args) => {
			received = args;
			return [];
		},
	);
	await options.queryFn({ signal: controller.signal } as never);
	assert.deepEqual(received, ["team@example.com", "ali", 10, controller.signal]);
	assert.equal(options.enabled, true);
});
