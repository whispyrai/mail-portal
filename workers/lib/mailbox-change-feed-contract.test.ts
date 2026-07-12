import assert from "node:assert/strict";
import test from "node:test";
import {
	MailboxChangeQueryError,
	decodeMailboxChangeCursor,
	encodeMailboxChangeCursor,
	normalizeMailboxChangeQuery,
	validateMailboxChangePage,
	validateNormalizedMailboxChangeQuery,
} from "../../shared/mailbox-change-feed.ts";

test("mailbox change cursors are canonical, bounded, and accept only a safe sequence", () => {
	const cursor = encodeMailboxChangeCursor(42);
	assert.equal(cursor, "eyJ2IjoxLCJzIjo0Mn0");
	assert.equal(decodeMailboxChangeCursor(cursor), 42);
	for (const invalid of [
		"",
		"eyJ2IjoxLCJzIjo0Mn0=",
		"eyJzIjo0MiwidiI6MX0",
		"eyJ2IjoxLCJzIjotMX0",
		"eyJ2IjoxLCJzIjoxLjV9",
		"eyJ2IjoxLCJzIjo5MDA3MTk5MjU0NzQwOTkyfQ",
		"eyJ2IjoxLCJzIjo0MiwiZXh0cmEiOnRydWV9",
		"a".repeat(257),
	]) {
		assert.throws(
			() => decodeMailboxChangeCursor(invalid),
			(error) =>
				error instanceof MailboxChangeQueryError &&
				error.code === "INVALID_QUERY",
		);
	}
});

test("public mailbox change pages have exact keys, closed values, and strictly ascending identity", () => {
	const page = {
		changes: [
			{
				sequence: 8,
				schemaVersion: 1,
				committedAt: "2026-07-12T12:30:00.123Z",
				resource: "attachment",
				entityId: "attachment-1",
				parentId: "message-1",
				operation: "updated",
			},
			{
				sequence: 9,
				schemaVersion: 1,
				committedAt: "2026-07-12T12:30:00.124Z",
				resource: "delivery",
				entityId: "delivery-1",
				parentId: "message-1",
				operation: "created",
			},
		],
		nextCursor: encodeMailboxChangeCursor(9),
	};
	assert.deepEqual(validateMailboxChangePage(page, 7), page);

	for (const invalid of [
		{ ...page, extra: true },
		{ ...page, nextCursor: encodeMailboxChangeCursor(8) },
		{ ...page, changes: [page.changes[1], page.changes[0]] },
		{ ...page, changes: [page.changes[0], page.changes[0]] },
		{ ...page, changes: [{ ...page.changes[0], resource: "body" }] },
		{ ...page, changes: [{ ...page.changes[0], operation: "replaced" }] },
		{ ...page, changes: [{ ...page.changes[0], subject: "must not escape" }] },
		{ ...page, changes: Array.from({ length: 101 }, (_, index) => ({
			...page.changes[0],
			sequence: index + 8,
		})) },
	]) {
		assert.throws(() => validateMailboxChangePage(invalid, 7));
	}
});

test("mailbox change query accepts one cursor and a bounded limit and rejects every extra shape", () => {
	assert.deepEqual(normalizeMailboxChangeQuery(new URLSearchParams()), {
		after: null,
		limit: 100,
	});
	assert.deepEqual(
		normalizeMailboxChangeQuery(
			new URLSearchParams({ after: encodeMailboxChangeCursor(7), limit: "25" }),
		),
		{ after: 7, limit: 25 },
	);
	for (const query of [
		"?unknown=true",
		"?after=a&after=b",
		"?limit=1&limit=2",
		"?limit=0",
		"?limit=101",
		"?limit=1.5",
		"?limit=01",
	]) {
		assert.throws(
			() => normalizeMailboxChangeQuery(new URL(`https://mail.example${query}`).searchParams),
			(error) => error instanceof MailboxChangeQueryError,
		);
	}
});

test("the Durable Object seam rejects forged normalized mailbox change options", () => {
	assert.deepEqual(validateNormalizedMailboxChangeQuery({ after: 0, limit: 25 }), {
		after: 0,
		limit: 25,
	});
	for (const invalid of [
		{ after: 0, limit: 25, extra: true },
		{ after: "0", limit: 25 },
		{ after: -1, limit: 25 },
		{ after: null, limit: "25" },
		{ after: null, limit: 0 },
		{ after: null, limit: 101 },
		{ limit: 25 },
	]) {
		assert.throws(() => validateNormalizedMailboxChangeQuery(invalid));
	}
});
