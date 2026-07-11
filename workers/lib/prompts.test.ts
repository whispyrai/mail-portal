// System-prompt selector tests. No framework (matches workers/routes/brand.test.ts):
//   node --experimental-strip-types workers/lib/prompts.test.ts
// Exits non-zero on the first failed assertion.

import assert from "node:assert/strict";
import { systemPromptFor, WHISPYR_SYSTEM_PROMPT, WISER_SYSTEM_PROMPT } from "./prompts.ts";

// ── whispyr → the canonical sales prompt, unchanged ──
assert.equal(systemPromptFor("whispyr"), WHISPYR_SYSTEM_PROMPT, "whispyr → whispyr prompt");
assert.match(WHISPYR_SYSTEM_PROMPT, /Whispyr/, "whispyr prompt names Whispyr");
assert.match(WHISPYR_SYSTEM_PROMPT, /prospect/i, "whispyr prompt keeps its sales framing");

// ── wiser → the neutral team prompt ──
assert.equal(systemPromptFor("wiser"), WISER_SYSTEM_PROMPT, "wiser → wiser prompt");
assert.match(WISER_SYSTEM_PROMPT, /Wiser team/, "wiser prompt is the Wiser team assistant");

// ── brand separation: the Wiser prompt must NEVER mention Whispyr or carry the
//    Whispyr sales playbook (brand-no-whispyr-association / product separation) ──
assert.ok(!/whispyr/i.test(WISER_SYSTEM_PROMPT), "wiser prompt never says Whispyr");
assert.ok(
	!/lead scoring|whatsapp|20-minute demo|cold outreach/i.test(WISER_SYSTEM_PROMPT),
	"wiser prompt drops the Whispyr sales specifics",
);

// ── the two prompts are genuinely different (env-selection is meaningful) ──
assert.notEqual(WISER_SYSTEM_PROMPT, WHISPYR_SYSTEM_PROMPT, "wiser ≠ whispyr prompt");

console.log("prompts.test.ts: all assertions passed");
