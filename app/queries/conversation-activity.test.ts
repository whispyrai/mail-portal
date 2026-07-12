import assert from "node:assert/strict";
import test from "node:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/query-core";
import {
	buildConversationActivityQueryOptions,
	conversationActivityKey,
	nextConversationActivityCursor,
} from "./conversation-activity.ts";
import type { ConversationActivityPage } from "../services/conversation-activity.ts";

const empty = (nextCursor: string | null): ConversationActivityPage => ({
	items: [],
	nextCursor,
});

test("conversation activity query is disabled until expanded and forwards its cursor", async () => {
	let received: unknown[] = [];
	const request = async (...args: Parameters<NonNullable<Parameters<typeof buildConversationActivityQueryOptions>[3]>>) => {
		received = args;
		return empty(null);
	};
	const options = buildConversationActivityQueryOptions(
		"team@example.com",
		"message-1",
		false,
		request,
	);
	const signal = new AbortController().signal;
	assert.deepEqual(options.queryKey, conversationActivityKey("team@example.com", "message-1"));
	assert.equal(options.enabled, false);
	assert.deepEqual(
		await options.queryFn({
			pageParam: { cursor: "cursor_1", boundary: null },
			signal,
		}),
		empty(null),
	);
	assert.deepEqual(received, [
		"team@example.com",
		"message-1",
		"cursor_1",
		signal,
	]);
});

test("conversation activity pagination stops terminal and looping cursors", () => {
	assert.equal(nextConversationActivityCursor([empty(null)], [null]), undefined);
	assert.equal(
		nextConversationActivityCursor([empty("older_1")], [null]),
		"older_1",
	);
	assert.equal(
		nextConversationActivityCursor(
			[empty("older_1"), empty("older_1")],
			[null, "older_1"],
		),
		undefined,
	);
	assert.equal(
		nextConversationActivityCursor(
			[empty("older_1"), empty("older_2"), empty("older_1")],
			[null, "older_1", "older_2"],
		),
		undefined,
	);
});

test("conversation activity rejects an older page that breaks global descending order", () => {
	const options = buildConversationActivityQueryOptions(
		"team@example.com",
		"message-1",
		true,
	);
	const newer = {
		...empty("older_1"),
		items: [{
			id: "event-2",
			code: "archived" as const,
			label: "Archived",
			actor: { kind: "system" as const, label: "Mail portal" },
			occurredAt: "2026-07-12T08:30:02.000Z",
		}],
	};
	const older = {
		...empty(null),
		items: [{
			...newer.items[0],
			id: "event-1",
			occurredAt: "2026-07-12T08:30:01.000Z",
		}],
	};
	assert.deepEqual(
		options.select?.({
			pages: [newer, older],
			pageParams: [
				{ cursor: null, boundary: null },
				{ cursor: "older_1", boundary: { id: "event-2", occurredAt: "2026-07-12T08:30:02.000Z" } },
			],
		}),
		{
			pages: [newer, older],
			pageParams: [
				{ cursor: null, boundary: null },
				{ cursor: "older_1", boundary: { id: "event-2", occurredAt: "2026-07-12T08:30:02.000Z" } },
			],
		},
	);
	assert.throws(() => options.select?.({
		pages: [older, newer],
		pageParams: [
			{ cursor: null, boundary: null },
			{ cursor: "older_1", boundary: { id: "event-1", occurredAt: "2026-07-12T08:30:01.000Z" } },
		],
	}));
});

test("pagination rejects a malformed page before cache append and retries the same cursor", async () => {
	let olderAttempts = 0;
	const first = {
		...empty("older_1"),
		items: [{
			id: "event-2",
			code: "archived" as const,
			label: "Archived",
			actor: { kind: "system" as const, label: "Mail portal" },
			occurredAt: "2026-07-12T08:30:02.000Z",
		}],
	};
	const corrected = {
		...empty(null),
		items: [{
			...first.items[0],
			id: "event-1",
			occurredAt: "2026-07-12T08:30:01.000Z",
		}],
	};
	const malformed = {
		...corrected,
		items: [{
			...corrected.items[0],
			id: "event-3",
			occurredAt: "2026-07-12T08:30:03.000Z",
		}],
	};
	const request = async (
		_mailboxId: string,
		_emailId: string,
		cursor: string | null,
	): Promise<ConversationActivityPage> => {
		if (cursor === null) return first;
		assert.equal(cursor, "older_1");
		olderAttempts += 1;
		return olderAttempts === 1 ? malformed : corrected;
	};
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const options = buildConversationActivityQueryOptions(
		"team@example.com",
		"message-1",
		true,
		request,
	);
	const observer = new InfiniteQueryObserver(queryClient, options);
	const unsubscribe = observer.subscribe(() => undefined);
	try {
		await observer.refetch();
		assert.deepEqual(
			observer.getCurrentResult().data?.pages.flatMap((page) => page.items.map(({ id }) => id)),
			["event-2"],
		);

		await observer.fetchNextPage();
		const failed = observer.getCurrentResult();
		assert.equal(failed.isFetchNextPageError, true);
		assert.deepEqual(
			failed.data?.pages.flatMap((page) => page.items.map(({ id }) => id)),
			["event-2"],
		);
		const cachedAfterFailure = queryClient.getQueryData<{
			pages: ConversationActivityPage[];
		}>(conversationActivityKey("team@example.com", "message-1"));
		assert.deepEqual(cachedAfterFailure?.pages.map((page) => page.items[0]?.id), [
			"event-2",
		]);

		await observer.fetchNextPage();
		const recovered = observer.getCurrentResult();
		assert.equal(recovered.isSuccess, true);
		assert.equal(recovered.isFetchNextPageError, false);
		assert.equal(olderAttempts, 2);
		assert.deepEqual(
			recovered.data?.pages.flatMap((page) => page.items.map(({ id }) => id)),
			["event-2", "event-1"],
		);
	} finally {
		unsubscribe();
		queryClient.clear();
	}
});
