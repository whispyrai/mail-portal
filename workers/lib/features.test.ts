// Feature-gate tests. No framework (matches workers/routes/brand.test.ts):
//   node --experimental-strip-types workers/lib/features.test.ts
// Exits non-zero on the first failed assertion. `brand` here is an already-
// resolved id (resolveBrand handles BRAND normalization + fail-safe; tested in
// workers/routes/brand.test.ts).

import assert from "node:assert/strict";
import { isQuizEnabled } from "./features.ts";

// ── explicit FEATURES wins (the per-env source of truth) ──
assert.equal(isQuizEnabled(["quiz"], "whispyr"), true, "whispyr + [quiz] → on");
assert.equal(isQuizEnabled([], "whispyr"), false, "explicit [] turns the quiz off even for whispyr");
assert.equal(isQuizEnabled(["quiz"], "wiser"), true, "explicit [quiz] turns the quiz on even for wiser");
assert.equal(isQuizEnabled([], "wiser"), false, "wiser + [] → off");

// ── unset FEATURES → the brand's baseline ──
// whispyr keeps the quiz (byte-identical: a missing var never strips it from live prod);
// wiser never shows it (brand separation: a Wiser env that forgets FEATURES still can't
// leak the Whispyr sales quiz).
assert.equal(isQuizEnabled(undefined, "whispyr"), true, "unset + whispyr → on (fail-safe)");
assert.equal(isQuizEnabled(undefined, "wiser"), false, "unset + wiser → off (no leak)");

console.log("features.test.ts: all assertions passed");
