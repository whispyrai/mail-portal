import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { Env } from "../types.ts";
import {
	createSearchRoutes,
	type SearchOperations,
	type SearchRouteContext,
} from "./search.ts";

function testApp(operations: SearchOperations) {
	const app = new Hono<SearchRouteContext>();
	app.route("/", createSearchRoutes({ operations: () => operations }));
	return app;
}

function request(app: Hono<SearchRouteContext>, query: string) {
	return app.request(
		`http://mail.example.com/api/v1/mailboxes/team%40example.com/search?${query}`,
		{},
		{} as Env,
	);
}

test("search route authoritatively parses the raw grammar and preserves explicit sort", async () => {
	let received: Record<string, unknown> | undefined;
	const operations: SearchOperations = {
		async search(options) {
			received = options;
			return [{ id: "mail-1" }];
		},
		async count() {
			return 1;
		},
	};
	const response = await request(
		testApp(operations),
		`q=${encodeURIComponent('renewal "signed proposal" from:alice from:bob filename:terms.pdf')}&page=2&limit=25&sortColumn=sender&sortDirection=ASC&label_id=vip`,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(received, {
		terms: ["renewal"],
		phrases: ["signed proposal"],
		from: ["alice", "bob"],
		filename: ["terms.pdf"],
		page: 2,
		limit: 25,
		sortColumn: "sender",
		sortDirection: "ASC",
		label_id: "vip",
	});
	assert.deepEqual(await response.json(), { emails: [{ id: "mail-1" }], totalCount: 1 });
});

test("search route returns a stable client error without calling storage", async () => {
	let called = false;
	const response = await request(
		testApp({
			async search() {
				called = true;
				return [];
			},
			async count() {
				called = true;
				return 0;
			},
		}),
		`q=${encodeURIComponent('is:read is:unread')}`,
	);
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Search cannot be both read and unread",
		code: "INVALID_QUERY",
	});
	assert.equal(called, false);
});

test("search route rejects invalid pagination and sort instead of widening", async () => {
	const operations: SearchOperations = {
		async search() {
			return [];
		},
		async count() {
			return 0;
		},
	};
	for (const query of ["q=x&page=0", "q=x&limit=101", "q=x&sortColumn=body"]) {
		const response = await request(testApp(operations), query);
		assert.equal(response.status, 400, query);
	}
});

test("search route returns a stable client error before RPC when combined filters exceed the SQL bind budget", async () => {
	let called = false;
	const terms = Array.from({ length: 32 }, (_, index) => `term${index + 1}`).join(" ");
	const params = new URLSearchParams({
		q: terms,
		from: "alice@example.com",
		to: "team@example.com",
		subject: "renewal",
		folder: "inbox",
		label_id: "vip",
		date_start: "2026-01-01",
		date_end: "2026-02-01",
		is_read: "true",
		is_starred: "true",
		has_attachment: "true",
	});
	const response = await request(
		testApp({
			async search() {
				called = true;
				return [];
			},
			async count() {
				called = true;
				return 0;
			},
		}),
		params.toString(),
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Search uses too many combined filters",
		code: "QUERY_TOO_LARGE",
	});
	assert.equal(called, false);
});

test("search route rejects an oversized UTF-8 LIKE pattern before RPC", async () => {
	let called = false;
	const response = await request(
		testApp({
			async search() {
				called = true;
				return [];
			},
			async count() {
				called = true;
				return 0;
			},
		}),
		`q=${encodeURIComponent("€".repeat(17))}`,
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Search value exceeds the mailbox pattern limit",
		code: "QUERY_TOO_LARGE",
	});
	assert.equal(called, false);
});
