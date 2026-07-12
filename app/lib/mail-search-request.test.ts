import assert from "node:assert/strict";
import test from "node:test";
import {
	searchRequestParams,
	shouldRetrySearch,
} from "./mail-search-request.ts";

test("search request sends the exact grammar to the authoritative server parser", () => {
	assert.deepEqual(
		searchRequestParams({
			query: 'renewal "signed proposal" from:alice from:bob filename:terms.pdf',
			page: 2,
			labelId: "vip",
			sortColumn: "sender",
			sortDirection: "ASC",
		}),
		{
			q: 'renewal "signed proposal" from:alice from:bob filename:terms.pdf',
			page: "2",
			limit: "25",
			label_id: "vip",
			sortColumn: "sender",
			sortDirection: "ASC",
		},
	);
});

test("search retries transient failures but never retries a strict query error", () => {
	assert.equal(shouldRetrySearch(0, { status: 400 }), false);
	assert.equal(shouldRetrySearch(0, { status: 503 }), true);
	assert.equal(shouldRetrySearch(1, new Error("Network error")), true);
	assert.equal(shouldRetrySearch(2, new Error("Network error")), false);
});
