// Brand-registry tests. No framework (matches workers/quiz/grading.test.ts):
//   node --experimental-strip-types workers/routes/brand.test.ts
// Exits non-zero on the first failed assertion.

import assert from "node:assert/strict";
import { resolveBrand, brandLogo, brandCss } from "./brand.ts";

// ── resolveBrand: explicit brands resolve to their own identity ──
assert.equal(resolveBrand("wiser").id, "wiser", "wiser id");
assert.equal(resolveBrand("wiser").name, "Wiser", "wiser name");
assert.equal(resolveBrand("wiser").appName, "Wiser Mail", "wiser appName");
assert.equal(resolveBrand("wiser").mark, "/wiser-mark.svg", "wiser mark");
assert.match(resolveBrand("wiser").fontFamily, /Inter/, "wiser font is Inter");

assert.equal(resolveBrand("whispyr").id, "whispyr", "whispyr id");
assert.equal(resolveBrand("whispyr").name, "Whispyr", "whispyr name");
assert.equal(resolveBrand("whispyr").appName, "Whispyr Mail", "whispyr appName");
assert.equal(resolveBrand("whispyr").mark, "/whispyr-mark.svg", "whispyr mark");
assert.match(resolveBrand("whispyr").fontFamily, /Kamerik 105/, "whispyr font is Kamerik");

// ── fail-safe default: unset/unknown → whispyr (a missing var never breaks the
//    live Whispyr portal — this is the load-bearing byte-identical guarantee) ──
assert.equal(resolveBrand(undefined).id, "whispyr", "unset → whispyr");
assert.equal(resolveBrand("").id, "whispyr", "empty → whispyr");
assert.equal(resolveBrand("bogus").id, "whispyr", "unknown → whispyr");
assert.equal(resolveBrand("WISER").id, "wiser", "case-insensitive → wiser");

// ── brandLogo: per-brand mark asset + wordmark text ──
{
	const wiser = brandLogo(resolveBrand("wiser"));
	assert.match(wiser, /\/wiser-mark\.svg/, "wiser logo uses the wiser mark");
	assert.match(wiser, />\s*Wiser/, "wiser logo wordmark says Wiser");
	const whispyr = brandLogo(resolveBrand("whispyr"));
	assert.match(whispyr, /\/whispyr-mark\.svg/, "whispyr logo uses the whispyr mark");
	assert.match(whispyr, />\s*Whispyr/, "whispyr logo wordmark says Whispyr");
}

// ── brandCss: each brand emits ONLY its own palette + font, never the other's ──
{
	const wiser = brandCss(resolveBrand("wiser"));
	assert.match(wiser, /Inter/, "wiser css declares Inter");
	assert.match(wiser, /70 28% 38%/, "wiser css uses the olive accent");
	const whispyr = brandCss(resolveBrand("whispyr"));
	assert.match(whispyr, /Kamerik 105/, "whispyr css declares Kamerik");
	assert.match(whispyr, /#1a1a1a/, "whispyr css uses charcoal");
	assert.ok(!whispyr.includes("70 28% 38%"), "whispyr css contains no olive");
	assert.ok(!wiser.includes("Kamerik"), "wiser css contains no Kamerik");
}

console.log("brand.test.ts: all assertions passed");
