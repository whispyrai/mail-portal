import assert from "node:assert/strict";
import test from "node:test";
import { buildAiSearchInterpreterMutationOptions } from "./ai-search-interpreter.ts";

test("AI search interpretation is an explicit non-retrying mutation with cancellation", async () => {
	let received: unknown[] = [];
	const options = buildAiSearchInterpreterMutationOptions(async (...args) => {
		received = args;
		return { state: "ambiguous" };
	});
	const signal = new AbortController().signal;
	assert.equal(options.retry, false);
	assert.deepEqual(
		await options.mutationFn({
			mailboxId: "team@example.com",
			request: { intent: "recent renewal", timezone: "Africa/Cairo" },
			signal,
			requestToken: 1,
		}),
		{ state: "ambiguous" },
	);
	assert.deepEqual(received, [
		"team@example.com",
		{ intent: "recent renewal", timezone: "Africa/Cairo" },
		signal,
	]);
});
