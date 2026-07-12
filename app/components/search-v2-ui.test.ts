import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("../routes/search-results.tsx", import.meta.url),
	"utf8",
);

test("Search v2 exposes an explicit error state and manual retry", () => {
	assert.match(source, /role="alert"/);
	assert.match(source, /Search unavailable/);
	assert.match(source, /Try again/);
	assert.match(source, /refetch/);
});

test("Search v2 explains filename and quoted phrase syntax", () => {
	assert.match(source, /filename:proposal\.pdf/);
	assert.match(source, /"exact phrase"/);
});
