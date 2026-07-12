import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(path: string): string {
	return readFileSync(new URL(path, import.meta.url), "utf8");
}

const folderList = read("./email-list.tsx");
const searchResults = read("./search-results.tsx");
const savedViewResults = read("./saved-view-results.tsx");

for (const [surface, source] of [
	["folder list", folderList],
	["search results", searchResults],
	["saved view results", savedViewResults],
] as const) {
	test(`${surface} applies the shared compact density and removes secondary snippets`, () => {
		assert.match(source, /mailDensity/);
		assert.match(source, /isCompact = mailDensity === "compact"/);
		assert.match(source, /!isCompact && snippet/);
	});
}

test("compact rows keep a 44 pixel primary interaction target", () => {
	assert.match(folderList, /className="flex min-h-11 min-w-0 flex-1/);
	assert.match(searchResults, /flex min-h-11 items-center/);
	assert.match(savedViewResults, /isCompact \? "min-h-11 py-1"/);
});
