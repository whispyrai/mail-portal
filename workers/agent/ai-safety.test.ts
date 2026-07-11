import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("chat uses the cost guard and labels mailbox context as untrusted data", () => {
	assert.match(source, /createAiCostController/);
	assert.match(source, /requestedTier:\s*"cheap"/);
	assert.match(source, /calculateAiUsageCostMicros/);
	assert.match(source, /controller\.startUsage/);
	assert.match(source, /onStepFinish/);
	assert.match(source, /mailboxContextAsUntrustedData/);
	assert.doesNotMatch(source, /system:\s*mailboxContext/);
});

test("autonomous chat exposes only read and reviewable draft tools", () => {
	assert.doesNotMatch(source, /mark_email_read:/);
	assert.doesNotMatch(source, /move_email:/);
	assert.doesNotMatch(source, /discard_draft:/);
	assert.match(source, /draft_email:/);
	assert.match(source, /draft_reply:/);
});
