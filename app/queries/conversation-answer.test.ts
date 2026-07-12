import assert from "node:assert/strict";
import test from "node:test";
import {
	buildConversationAnswerMutationOptions,
	isCurrentConversationAnswerRequest,
} from "./conversation-answer.ts";

test("conversation answer request identity is pinned to mailbox, message, and token", () => {
	const request = {
		mailboxId: "team@example.com",
		emailId: "message-1",
		requestToken: 4,
	};
	assert.equal(
		isCurrentConversationAnswerRequest(
			request,
			"team@example.com",
			"message-1",
			4,
		),
		true,
	);
	assert.equal(
		isCurrentConversationAnswerRequest(
			request,
			"other@example.com",
			"message-1",
			4,
		),
		false,
	);
	assert.equal(
		isCurrentConversationAnswerRequest(
			request,
			"team@example.com",
			"message-2",
			4,
		),
		false,
	);
	assert.equal(
		isCurrentConversationAnswerRequest(
			request,
			"team@example.com",
			"message-1",
			5,
		),
		false,
	);
});

test("conversation answer mutation forwards its abort signal and never retries", async () => {
	const controller = new AbortController();
	let received: unknown;
	const options = buildConversationAnswerMutationOptions(
		async (mailboxId, emailId, question, signal) => {
			received = { mailboxId, emailId, question, signal };
			return { state: "stale" };
		},
	);
	assert.equal(options.retry, false);
	assert.deepEqual(
		await options.mutationFn({
			mailboxId: "team@example.com",
			emailId: "message-1",
			question: "What was promised?",
			signal: controller.signal,
			requestToken: 1,
		}),
		{ state: "stale" },
	);
	assert.deepEqual(received, {
		mailboxId: "team@example.com",
		emailId: "message-1",
		question: "What was promised?",
		signal: controller.signal,
	});
});
