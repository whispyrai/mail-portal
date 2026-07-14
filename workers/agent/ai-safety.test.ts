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

test("chat forwards combined cancellation and blocks later tools after abort", () => {
	assert.match(source, /AgentActiveRunRegistry/);
	assert.match(source, /clientSignal:\s*options\?\.abortSignal/);
	assert.match(source, /abortSignal:\s*activeRun\.signal/);
	assert.match(source, /keepSettlementAlive\(settlement, "abort"\)/);
	assert.match(source, /trackAgentStreamResponse/);
	assert.match(source, /isTerminalAgentStreamFailure/);
	assert.match(source, /activeRun\.signal\.aborted[\s\S]{0,240}aborted_finish/);
	assert.match(source, /trackAgentStreamResponse\([\s\S]{0,200}activeRun\.signal/);
	assert.doesNotMatch(source, /onError:[\s\S]{0,200}activeRun\.finish/);
	assert.match(source, /"message_conversion"/);
	assert.match(source, /"provider_start"/);
	assert.match(source, /throwIfAgentRunAborted\(runSignal\)/);
	assert.match(source, /onSessionVersionResolved/);
	assert.match(source, /onAuthorizedConnectionIdsResolved/);
	assert.match(source, /ai_chat_\$\{phase\}_\$\{activeRun\.wasRevoked/);
});
