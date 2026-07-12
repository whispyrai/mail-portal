import assert from "node:assert/strict";
import test from "node:test";
import {
	SearchQueryError,
	parseSearchQuery,
} from "./search-parser.ts";

test("search parser keeps tokenized terms and quoted phrases as AND clauses", () => {
	const parsed = parseSearchQuery('renewal enterprise "signed proposal"');

	assert.deepEqual(parsed.terms, ["renewal", "enterprise"]);
	assert.deepEqual(parsed.phrases, ["signed proposal"]);
	assert.equal(parsed.query, 'renewal enterprise "signed proposal"');
});

test("search parser preserves repeated people, folder, subject, and filename filters", () => {
	const parsed = parseSearchQuery(
		'from:alice@example.com from:"Bob Smith" to:sales subject:renewal subject:"next steps" in:inbox in:archive filename:proposal filename:"signed terms.pdf"',
	);

	assert.deepEqual(parsed.from, ["alice@example.com", "Bob Smith"]);
	assert.deepEqual(parsed.to, ["sales"]);
	assert.deepEqual(parsed.subject, ["renewal", "next steps"]);
	assert.deepEqual(parsed.folder, ["inbox", "archive"]);
	assert.deepEqual(parsed.filename, ["proposal", "signed terms.pdf"]);
});

test("search parser rejects malformed, contradictory, and unbounded input", () => {
	for (const input of [
		'"unterminated',
		"from:",
		"is:read is:unread",
		"has:calendar",
		"before:not-a-date",
		"x".repeat(501),
	]) {
		assert.throws(
			() => parseSearchQuery(input),
			(error: unknown) =>
				error instanceof SearchQueryError &&
				(error.code === "INVALID_QUERY" || error.code === "QUERY_TOO_LARGE"),
			input,
		);
	}
});

test("search parser treats unknown operator-like tokens as literal terms", () => {
	const parsed = parseSearchQuery("project:apollo status:waiting");
	assert.deepEqual(parsed.terms, ["project:apollo", "status:waiting"]);
});
