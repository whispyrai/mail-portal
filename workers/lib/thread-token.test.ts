import assert from "node:assert/strict";
import test from "node:test";
import { extractThreadToken, extractThreadTokens } from "./thread-token.ts";

test("thread token extraction accepts one unique token and rejects ambiguity", () => {
	assert.equal(
		extractThreadToken(["thread-thread_1@example.com"], "thread-thread_1@example.com"),
		"thread_1",
	);
	assert.deepEqual(
		extractThreadTokens(
			["thread-thread_1@example.com", "thread-thread_2@example.com"],
			null,
		),
		["thread_1", "thread_2"],
	);
	assert.equal(
		extractThreadToken(
			["thread-thread_1@example.com", "thread-thread_2@example.com"],
			null,
		),
		null,
	);
});
