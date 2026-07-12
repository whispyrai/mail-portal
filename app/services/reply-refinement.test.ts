import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchReplyRefinement,
	ReplyRefinementApiError,
} from "./reply-refinement.ts";

test("reply refinement posts only the exact contract to the encoded source message", async () => {
	const controller = new AbortController();
	let received: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const response = await fetchReplyRefinement(
		"team+hello@example.com",
		"message/one",
		{
			mode: "reply-all",
			prompt: "Make the commitment clearer.",
			currentBody: "<p>We can deliver Friday.</p>",
			preserveSignature: true,
		},
		controller.signal,
		async (input, init) => {
			received = { input, init };
			return Response.json({
				state: "generated",
				fingerprint: "reply-fingerprint",
				result: {
					body: "<p>We will deliver this Friday.</p>",
					requiresHumanReview: true,
				},
			});
		},
	);

	assert.equal(response.state, "generated");
	assert.equal(
		received?.input,
		"/api/v1/mailboxes/team%2Bhello%40example.com/emails/message%2Fone/reply-refinement",
	);
	assert.equal(received?.init?.method, "POST");
	assert.equal(received?.init?.credentials, "same-origin");
	assert.equal(received?.init?.signal, controller.signal);
	assert.deepEqual(JSON.parse(String(received?.init?.body)), {
		mode: "reply-all",
		prompt: "Make the commitment clearer.",
		currentBody: "<p>We can deliver Friday.</p>",
		preserveSignature: true,
	});
});

test("reply refinement failures retain safe server status and copy", async () => {
	await assert.rejects(
		fetchReplyRefinement(
			"team@example.com",
			"message-1",
			{ mode: "reply", prompt: "Draft a response." },
			new AbortController().signal,
			async () =>
				Response.json(
					{ error: "Mailbox access is no longer active." },
					{ status: 403 },
				),
		),
		(error: unknown) =>
			error instanceof ReplyRefinementApiError &&
			error.status === 403 &&
			error.message === "Mailbox access is no longer active.",
	);
});

test("reply refinement fails closed on a malformed success response", async () => {
	await assert.rejects(
		fetchReplyRefinement(
			"team@example.com",
			"message-1",
			{ mode: "reply", prompt: "Draft a response." },
			new AbortController().signal,
			async () => Response.json({ state: "generated", result: { to: "other@example.com" } }),
		),
		(error: unknown) =>
			error instanceof ReplyRefinementApiError &&
			error.status === 502 &&
			error.message === "The writing assistant returned an invalid reply",
	);
});

test("reply refinement requires the fixed review flag and non-empty authored content", async () => {
	for (const result of [
		{ body: "<p>Valid reply.</p>" },
		{ body: "<p>Valid reply.</p>", requiresHumanReview: false },
		{ body: "", requiresHumanReview: true },
		{ body: "   ", requiresHumanReview: true },
		{
			body: '<div data-mail-signature="v1">Team</div>',
			requiresHumanReview: true,
		},
		{
			body: '<div data-mail-forwarded-message="v1"><p>Quoted</p></div>',
			requiresHumanReview: true,
		},
	]) {
		await assert.rejects(
			fetchReplyRefinement(
				"team@example.com",
				"message-1",
				{ mode: "reply", prompt: "Draft a response." },
				new AbortController().signal,
				async () =>
					Response.json({
						state: "generated",
						fingerprint: "reply-fingerprint",
						result,
					}),
			),
			ReplyRefinementApiError,
		);
	}
});
