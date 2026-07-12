import assert from "node:assert/strict";
import test from "node:test";
import { buildInboxTriageSuggestionsMutationOptions } from "./inbox-triage-suggestions.ts";

test("Inbox triage mutation forwards the exact request and abort signal without retry", async () => {
	const controller = new AbortController();
	let received: unknown[] = [];
	const options = buildInboxTriageSuggestionsMutationOptions(
		async (...args) => {
			received = args;
			return { state: "stale" };
		},
	);
	const variables = {
		mailboxId: "team@example.com",
		request: { page: 1, visibleEmailIds: ["message-1"] },
		signal: controller.signal,
		requestToken: 1,
	};
	assert.deepEqual(await options.mutationFn(variables), { state: "stale" });
	assert.deepEqual(received, [
		"team@example.com",
		variables.request,
		controller.signal,
	]);
	assert.equal(options.retry, false);
});
