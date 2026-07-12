import assert from "node:assert/strict";
import test from "node:test";
import {
	AiSearchInterpreterApiError,
	fetchAiSearchInterpretation,
} from "./ai-search-interpreter.ts";

const readyResponse = {
	state: "generated",
	query: "renewal is:unread",
	labelId: null,
	filters: {
		terms: ["renewal"],
		phrases: [],
		from: [],
		to: [],
		subject: [],
		filename: [],
		folders: [],
		isRead: false,
		isStarred: null,
		hasAttachment: false,
		after: null,
		before: null,
	},
	requiresReview: true,
} as const;

test("AI search interpretation posts only bounded intent and timezone without running search", async () => {
	let received: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const result = await fetchAiSearchInterpretation(
		"Team+Inbox@example.com",
		{ intent: "  unread   renewal  ", timezone: "Africa/Cairo" },
		new AbortController().signal,
		async (input, init) => {
			received = { input, init };
			return Response.json(readyResponse);
		},
	);

	assert.deepEqual(result, readyResponse);
	assert.equal(
		received?.input,
		"/api/v1/mailboxes/Team%2BInbox%40example.com/search/interpret",
	);
	assert.equal(received?.init?.method, "POST");
	assert.equal(received?.init?.credentials, "same-origin");
	assert.deepEqual(JSON.parse(String(received?.init?.body)), {
		intent: "unread renewal",
		timezone: "Africa/Cairo",
	});
	assert.equal(received?.init?.signal instanceof AbortSignal, true);
	assert.doesNotMatch(String(received?.input), /\/search\?/);
});

test("AI search interpretation accepts only the strict shared response contract", async () => {
	await assert.rejects(
		fetchAiSearchInterpretation(
			"mailbox-1",
			{ intent: "unread renewal", timezone: "UTC" },
			new AbortController().signal,
			async () => Response.json({ ...readyResponse, unexpected: true }),
		),
		(error: unknown) => {
			assert.equal(error instanceof AiSearchInterpreterApiError, true);
			assert.equal((error as AiSearchInterpreterApiError).status, 502);
			assert.equal(
				(error as Error).message,
				"AI search returned an invalid response.",
			);
			return true;
		},
	);

	const nonReady = await fetchAiSearchInterpretation(
		"mailbox-1",
		{ intent: "maybe renewals", timezone: "UTC" },
		new AbortController().signal,
		async () => Response.json({ state: "ambiguous" }),
	);
	assert.deepEqual(nonReady, { state: "ambiguous" });
});

test("AI search interpretation maps endpoint failures to fixed client copy", async () => {
	const cases = [
		[403, "Mailbox access changed."],
		[400, "This search request could not be interpreted."],
		[503, "AI search is temporarily unavailable."],
	] as const;
	for (const [status, message] of cases) {
		await assert.rejects(
			fetchAiSearchInterpretation(
				"mailbox-1",
				{ intent: "unread renewal", timezone: "UTC" },
				new AbortController().signal,
				async () => new Response(null, { status }),
			),
			(error: unknown) => {
				assert.equal(error instanceof AiSearchInterpreterApiError, true);
				assert.equal((error as AiSearchInterpreterApiError).status, status);
				assert.equal((error as Error).message, message);
				return true;
			},
		);
	}
});
