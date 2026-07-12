import assert from "node:assert/strict";
import test from "node:test";
import {
	searchFilterSummary,
	validateAiSearchReview,
} from "./ai-search-review.ts";

test("AI search review exposes AND families and OR values from the canonical query", () => {
	const summary = searchFilterSummary(
		'renewal "signed proposal" from:alice from:bob in:inbox in:archive is:unread after:2026-07-01',
	);
	assert.deepEqual(summary, [
		{ label: "Contains all", values: ["renewal", '“signed proposal”'], mode: "all" },
		{ label: "From", values: ["alice", "bob"], mode: "any" },
		{ label: "Folder", values: ["inbox", "archive"], mode: "any" },
		{ label: "State", values: ["Unread"], mode: "all" },
		{ label: "After", values: ["2026-07-01"], mode: "all" },
	]);
});

test("AI search review rejects invalid grammar, empty review, and unknown labels", () => {
	assert.deepEqual(validateAiSearchReview("is:read is:unread", null, []), {
		ok: false,
		error: "Search cannot be both read and unread",
	});
	assert.deepEqual(validateAiSearchReview("", null, []), {
		ok: false,
		error: "Enter a search query or choose a label.",
	});
	assert.deepEqual(validateAiSearchReview("renewal", "removed", ["vip"]), {
		ok: false,
		error: "That label is no longer available. Interpret the request again.",
	});
	assert.deepEqual(validateAiSearchReview("invoice\u202Efdp.exe", null, []), {
		ok: false,
		error: "Search contains hidden directional or control characters.",
	});
});
