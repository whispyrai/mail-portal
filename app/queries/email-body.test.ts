import assert from "node:assert/strict";
import test from "node:test";
import { QueriesObserver, QueryClient } from "@tanstack/react-query";
import { buildEmailBodyQueryOptions } from "./email-body.ts";
import { queryKeys } from "./keys.ts";

test("email body query options pin the cache identity, signal, and explicit recovery", async () => {
	let observedSignal: AbortSignal | undefined;
	const options = buildEmailBodyQueryOptions(
		"team@example.com",
		"message-1",
		async (_mailboxId, _emailId, requestOptions) => {
			observedSignal = requestOptions?.signal;
			return "complete body";
		},
	);
	assert.deepEqual(options.queryKey, queryKeys.emails.body("team@example.com", "message-1"));
	assert.equal(options.retry, false);
	assert.equal(await options.queryFn({ signal: AbortSignal.timeout(1_000) }), "complete body");
	assert.ok(observedSignal);
});

test("removing a nonselected body observer aborts only that consumed request", async () => {
	const calls = new Map<string, number>();
	const signals = new Map<string, AbortSignal>();
	const aborted: string[] = [];
	const request = async (
		_mailboxId: string,
		emailId: string,
		requestOptions?: { signal?: AbortSignal },
	) => new Promise<string>((_resolve, reject) => {
		calls.set(emailId, (calls.get(emailId) ?? 0) + 1);
		const signal = requestOptions?.signal;
		assert.ok(signal);
		signals.set(emailId, signal);
		signal.addEventListener("abort", () => {
			aborted.push(emailId);
			reject(signal.reason);
		}, { once: true });
	});
	const selected = buildEmailBodyQueryOptions("team@example.com", "selected", request);
	const nonselected = buildEmailBodyQueryOptions("team@example.com", "reply", request);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const observer = new QueriesObserver(client, [selected, nonselected]);
	const unsubscribe = observer.subscribe(() => undefined);
	try {
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual([...calls.entries()].sort(), [["reply", 1], ["selected", 1]]);
		observer.setQueries([selected]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(aborted, ["reply"]);
		assert.equal(signals.get("selected")?.aborted, false);
	} finally {
		unsubscribe();
		client.clear();
	}
});
