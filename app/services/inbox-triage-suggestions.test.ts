import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchInboxTriageSuggestions,
	InboxTriageSuggestionsApiError,
	type InboxTriageSuggestion,
} from "./inbox-triage-suggestions.ts";

test("Inbox triage posts only the exact visible-page contract", async () => {
	const controller = new AbortController();
	let received: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const response = await fetchInboxTriageSuggestions(
		"team+hello@example.com",
		{
			page: 2,
			labelId: "priority",
			visibleEmailIds: ["message-2", "message-1"],
		},
		controller.signal,
		async (input, init) => {
			received = { input, init };
			return Response.json({
				state: "generated",
				fingerprint: "page-fingerprint",
				result: { suggestions: [] },
			});
		},
	);

	assert.equal(response.state, "generated");
	assert.equal(
		received?.input,
		"/api/v1/mailboxes/team%2Bhello%40example.com/inbox-triage-suggestions",
	);
	assert.equal(received?.init?.method, "POST");
	assert.equal(received?.init?.credentials, "same-origin");
	assert.equal(received?.init?.signal, controller.signal);
	assert.deepEqual(JSON.parse(String(received?.init?.body)), {
		page: 2,
		labelId: "priority",
		visibleEmailIds: ["message-2", "message-1"],
	});
});

test("Inbox triage fails closed when review provenance or suggestion fields are malformed", async () => {
	for (const suggestion of [
		{
			candidateId: "candidate-1",
			emailId: "message-1",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: ["message-1"],
		},
		{
			candidateId: "candidate-1",
			emailId: "message-1",
			conversationId: null,
			action: "trash",
			explanation: "Routine update.",
			messageIds: ["message-1"],
			requiresHumanReview: true,
		},
		{
			candidateId: "candidate-1",
			emailId: "message-1",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: [],
			requiresHumanReview: true,
		},
		{
			candidateId: "candidate-1",
			emailId: "hidden-message",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: ["hidden-message"],
			requiresHumanReview: true,
		},
		{
			candidateId: "candidate-1",
			emailId: "message-1",
			conversationId: null,
			action: "archive",
			explanation: "Routine update.",
			messageIds: ["message-1"],
			requiresHumanReview: true,
			unexpected: true,
		},
	]) {
		await assert.rejects(
			fetchInboxTriageSuggestions(
				"team@example.com",
				{ page: 1, visibleEmailIds: ["message-1"] },
				new AbortController().signal,
				async () =>
					Response.json({
						state: "generated",
						fingerprint: "page-fingerprint",
						result: { suggestions: [suggestion] },
					}),
			),
			InboxTriageSuggestionsApiError,
		);
	}
});

test("Inbox triage accepts only bounded visible suggestions and preserves safe server errors", async () => {
	const suggestion = {
		candidateId: "candidate-1",
		emailId: "message-1",
		conversationId: "conversation-1",
		action: "mark_read",
		explanation: "No reply was requested.",
		messageIds: ["message-1"],
		requiresHumanReview: true,
	} satisfies InboxTriageSuggestion;
	const accepted = await fetchInboxTriageSuggestions(
		"team@example.com",
		{ page: 1, visibleEmailIds: ["message-1"] },
		new AbortController().signal,
		async () =>
			Response.json({
				state: "cached",
				fingerprint: "page-fingerprint",
				result: { suggestions: [suggestion] },
			}),
	);
	assert.deepEqual(accepted, {
		state: "cached",
		fingerprint: "page-fingerprint",
		result: { suggestions: [suggestion] },
	});

	await assert.rejects(
		fetchInboxTriageSuggestions(
			"team@example.com",
			{ page: 1, visibleEmailIds: ["message-1"] },
			new AbortController().signal,
			async () =>
				Response.json(
					{ error: "Mailbox access is no longer active." },
					{ status: 403 },
				),
		),
		(error: unknown) =>
			error instanceof InboxTriageSuggestionsApiError &&
			error.status === 403 &&
			error.message === "Mailbox access is no longer active.",
	);
});

test("Inbox triage rejects unknown response fields and duplicate candidates", async () => {
	const suggestion = {
		candidateId: "candidate-1",
		emailId: "message-1",
		conversationId: null,
		action: "archive",
		explanation: "Routine update.",
		messageIds: ["message-1"],
		requiresHumanReview: true,
	};
	for (const payload of [
		{ state: "stale", unexpected: true },
		{
			state: "generated",
			fingerprint: "page-fingerprint",
			result: { suggestions: [], unexpected: true },
		},
		{
			state: "generated",
			fingerprint: "page-fingerprint",
			result: { suggestions: [suggestion, suggestion] },
		},
	]) {
		await assert.rejects(
			fetchInboxTriageSuggestions(
				"team@example.com",
				{ page: 1, visibleEmailIds: ["message-1"] },
				new AbortController().signal,
				async () => Response.json(payload),
			),
			InboxTriageSuggestionsApiError,
		);
	}
});
