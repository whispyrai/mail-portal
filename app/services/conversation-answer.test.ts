import assert from "node:assert/strict";
import test from "node:test";
import {
	ConversationAnswerApiError,
	fetchConversationAnswer,
} from "./conversation-answer.ts";

test("conversation questions are posted to the exact encoded mailbox and message", async () => {
	const controller = new AbortController();
	let received: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const response = await fetchConversationAnswer(
		"team+hello@example.com",
		"message/one",
		"What was promised?",
		controller.signal,
		async (input, init) => {
			received = { input, init };
			return Response.json({
				state: "generated",
				fingerprint: "answer-fingerprint",
				result: {
					state: "answered",
					claims: [{ text: "A promise.", messageIds: ["message/one"] }],
				},
			});
		},
	);

	assert.equal(response.state, "generated");
	assert.equal(
		received?.input,
		"/api/v1/mailboxes/team%2Bhello%40example.com/emails/message%2Fone/question",
	);
	assert.equal(received?.init?.method, "POST");
	assert.equal(received?.init?.credentials, "same-origin");
	assert.equal(received?.init?.signal, controller.signal);
	assert.deepEqual(JSON.parse(String(received?.init?.body)), {
		question: "What was promised?",
	});
});

test("conversation question failures retain safe server status and copy", async () => {
	await assert.rejects(
		fetchConversationAnswer(
			"team@example.com",
			"message-1",
			"What was promised?",
			new AbortController().signal,
			async () =>
				Response.json(
					{ error: "Mailbox access is no longer active." },
					{ status: 403 },
				),
		),
		(error: unknown) =>
			error instanceof ConversationAnswerApiError &&
			error.status === 403 &&
			error.message === "Mailbox access is no longer active.",
	);
});
