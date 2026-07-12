import assert from "node:assert/strict";
import test from "node:test";
import {
	fetchConversationActivity,
	ConversationActivityApiError,
} from "./conversation-activity.ts";

const page = {
	items: [
		{
			id: "event-1",
			code: "marked_read",
			label: "Marked read",
			actor: { kind: "person", label: "person@example.com" },
			occurredAt: "2026-07-12T08:30:00.000Z",
		},
	],
	nextCursor: "next_page_1",
};

test("conversation activity fetches one bounded cursor page without a mutation", async () => {
	let received: { input: RequestInfo | URL; init?: RequestInit } | undefined;
	const result = await fetchConversationActivity(
		"team+hello@example.com",
		"message/1",
		"cursor_1",
		new AbortController().signal,
		async (input, init) => {
			received = { input, init };
			return Response.json(page);
		},
	);

	assert.deepEqual(result, page);
	assert.equal(
		received?.input,
		"/api/v1/mailboxes/team%2Bhello%40example.com/emails/message%2F1/activity?limit=25&cursor=cursor_1",
	);
	assert.equal(received?.init?.method, "GET");
	assert.equal(received?.init?.credentials, "same-origin");
	assert.equal(received?.init?.signal instanceof AbortSignal, true);
	assert.equal(received?.init?.body, undefined);
});

test("conversation activity fails closed on malformed public projection fields", async () => {
	for (const malformed of [
		{ ...page, unexpected: true },
		{ ...page, nextCursor: "cursor with spaces" },
		{
			...page,
			items: [{ ...page.items[0], code: "internal_cleanup" }],
		},
		{
			...page,
			items: [{ ...page.items[0], label: "Arbitrary server prose" }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "user", label: "internal-id" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "system", label: "Arbitrary system" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "automation", label: "Named secret rule" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "person", label: "A Person" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "mcp", label: "person@example.com" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], actor: { kind: "assistant", label: "Helpful assistant" } }],
		},
		{
			...page,
			items: [{ ...page.items[0], occurredAt: "not-a-date" }],
		},
		{
			...page,
			items: [{ ...page.items[0], occurredAt: "2026-07-12T08:30:00Z" }],
		},
		{
			...page,
			items: [page.items[0], page.items[0]],
		},
		{
			...page,
			items: [
				{
					...page.items[0],
					id: "event-older",
					occurredAt: "2026-07-11T08:30:00.000Z",
				},
				page.items[0],
			],
		},
	]) {
		await assert.rejects(
			fetchConversationActivity(
				"team@example.com",
				"message-1",
				null,
				new AbortController().signal,
				async () => Response.json(malformed),
			),
			ConversationActivityApiError,
		);
	}
});

test("conversation activity accepts only the closed public actor label grammar", async () => {
	const items = [
		{ ...page.items[0], id: "8", actor: { kind: "person", label: "person@example.com" }, occurredAt: "2026-07-12T08:30:08.000Z" },
		{ ...page.items[0], id: "7", actor: { kind: "person", label: "Former team member" }, occurredAt: "2026-07-12T08:30:07.000Z" },
		{ ...page.items[0], id: "6", actor: { kind: "mcp", label: "person@example.com via MCP" }, occurredAt: "2026-07-12T08:30:06.000Z" },
		{ ...page.items[0], id: "5", actor: { kind: "mcp", label: "Former team member" }, occurredAt: "2026-07-12T08:30:05.000Z" },
		{ ...page.items[0], id: "4", actor: { kind: "assistant", label: "person@example.com via AI assistant" }, occurredAt: "2026-07-12T08:30:04.000Z" },
		{ ...page.items[0], id: "3", actor: { kind: "assistant", label: "Former team member" }, occurredAt: "2026-07-12T08:30:03.000Z" },
		{ ...page.items[0], id: "2", actor: { kind: "assistant", label: "AI assistant" }, occurredAt: "2026-07-12T08:30:02.000Z" },
		{ ...page.items[0], id: "1", actor: { kind: "automation", label: "Automation" }, occurredAt: "2026-07-12T08:30:01.000Z" },
		{ ...page.items[0], id: "0", actor: { kind: "system", label: "Mail portal" }, occurredAt: "2026-07-12T08:30:00.000Z" },
	];
	const result = await fetchConversationActivity(
		"team@example.com",
		"message-1",
		null,
		new AbortController().signal,
		async () => Response.json({ items, nextCursor: null }),
	);
	assert.deepEqual(result.items.map((item) => item.actor), items.map((item) => item.actor));
});

test("conversation activity uses client-owned failures without exposing server detail", async () => {
	for (const [status, serverMessage, expectedMessage] of [
		[403, "private server detail", "Mailbox access changed."],
		[404, "private server detail", "Conversation is no longer available."],
		[401, "private server detail", "Conversation activity is unavailable."],
		[500, "private server detail", "Conversation activity is unavailable."],
	] as const) {
		await assert.rejects(
			fetchConversationActivity(
				"team@example.com",
				"message-1",
				null,
				new AbortController().signal,
				async () => Response.json({ error: serverMessage }, { status }),
			),
			(error: unknown) =>
				error instanceof ConversationActivityApiError &&
				error.status === status &&
				error.message === expectedMessage,
		);
	}
});
