import assert from "node:assert/strict";
import test from "node:test";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
import type { MailboxAttachmentPage } from "../../shared/mailbox-attachments.ts";
import {
	buildMailboxAttachmentsQueryOptions,
	flattenMailboxAttachmentPages,
	nextMailboxAttachmentCursor,
} from "./attachments.ts";

const page = (ids: string[], nextCursor: string | null): MailboxAttachmentPage => ({
	items: ids.map((id) => ({
		id,
		emailId: `email-${id}`,
		filename: `${id}.pdf`,
		mimetype: "application/pdf",
		size: 10,
		kind: "pdf",
		message: {
			subject: id,
			sender: "sender@example.com",
			date: "2026-07-12T00:00:00.000Z",
			folderId: "inbox",
			folderName: "Inbox",
		},
	})),
	nextCursor,
});

test("infinite attachment pages flatten in server order and reject repeated cursors", () => {
	const pages = [page(["a", "b"], "next-1"), page(["c"], "next-1")];
	assert.deepEqual(flattenMailboxAttachmentPages(pages).map((item) => item.id), ["a", "b", "c"]);
	assert.equal(nextMailboxAttachmentCursor(pages, [null, "next-1"]), undefined);
	assert.equal(nextMailboxAttachmentCursor([pages[0]], [null]), "next-1");
});

test("list query forwards normalized filters, cursor, and cancellation", async () => {
	const calls: unknown[][] = [];
	const request = async (...args: unknown[]) => {
		calls.push(args);
		return page([], null);
	};
	const options = buildMailboxAttachmentsQueryOptions(
		"mailbox-1",
		{ q: "invoice", kind: "pdf", folder: "archive" },
		request,
	);
	const controller = new AbortController();
	await options.queryFn({
		pageParam: { cursor: "cursor-2", boundary: null, seenKeys: [] },
		signal: controller.signal,
	});

	assert.deepEqual(calls[0]?.slice(0, 2), [
		"mailbox-1",
		{ limit: 25, q: "invoice", kind: "pdf", folder: "archive", cursor: "cursor-2" },
	]);
	assert.equal((calls[0]?.[2] as { signal: AbortSignal }).signal, controller.signal);
});

test("a malformed later page fails locally while preserving accepted pages", async () => {
	const first = page(["a"], "next-1");
	const malformed = page(["x"], null);
	malformed.items[0]!.message.date = "2026-07-13T00:00:00.000Z";
	const corrected = page(["b"], null);
	corrected.items[0]!.message.date = "2026-07-11T00:00:00.000Z";
	let attempts = 0;
	const request = async (
		_mailboxId: string,
		input: { cursor?: string | null },
	): Promise<MailboxAttachmentPage> => {
		if (!input.cursor) return first;
		attempts += 1;
		return attempts === 1 ? malformed : corrected;
	};
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const options = buildMailboxAttachmentsQueryOptions(
		"mailbox-1",
		{ q: "", kind: "", folder: "" },
		request,
	);
	const observer = new InfiniteQueryObserver(queryClient, options);
	const unsubscribe = observer.subscribe(() => undefined);
	try {
		await observer.refetch();
		await observer.fetchNextPage();
		const failed = observer.getCurrentResult();
		assert.equal(failed.isFetchNextPageError, true);
		assert.equal(failed.isError, true);
		assert.deepEqual(
			failed.data?.pages.flatMap((result) => result.items.map((item) => item.id)),
			["a"],
		);

		await observer.fetchNextPage();
		assert.deepEqual(
			observer.getCurrentResult().data?.pages.flatMap((result) => result.items.map((item) => item.id)),
			["a", "b"],
		);
	} finally {
		unsubscribe();
		queryClient.clear();
	}
});
