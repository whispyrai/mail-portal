import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AutomationWorkspace.tsx", import.meta.url), "utf8");
const route = await readFile(new URL("../../routes/automations.tsx", import.meta.url), "utf8");

test("Automations exposes URL-owned Rules and Run history without action replay", () => {
	assert.match(source, /automationTabFromParams\(searchParams\)/);
	assert.match(source, /role="tablist"/);
	assert.match(source, /Run history/);
	assert.doesNotMatch(source, /Replay|Apply to existing|Run again/);
	assert.match(source, /useAutomationRun\(mailboxId, selectedRunId/);
	assert.match(source, /Ruleset generation/);
	assert.match(source, /version \{result\.ruleVersion\}/);
	assert.match(source, /fetchNextPage/);
	assert.match(source, /Load older runs/);
	assert.match(source, /Older runs could not be loaded/);
	assert.match(source, /Loaded results remain available/);
	assert.match(source, /cancelRefetch: false/);
});

test("Shared read-only and safety copy remain visible product contracts", () => {
	assert.match(source, /They never send messages or contact external services/);
	assert.match(source, /These rules are shared by everyone with access/);
	assert.match(source, /You have read-only access/);
	assert.match(source, /Nothing will change/);
});

test("direct 403 suppresses the complete Automation surface before exit", () => {
	assert.match(route, /setRevoked\(true\)/);
	assert.match(route, /if \(revoked\) return/);
	assert.match(route, /exitRevokedMailbox/);
});

test("create uses order concurrency and zero-result acknowledgment is stored by re-test", () => {
	assert.match(source, /expectedOrderRevision: orderRevision/);
	assert.match(source, /void runTest\(true\)/);
	assert.match(source, /Zero-result acknowledgment stored/);
	assert.match(source, /Save draft before testing\./);
	assert.match(source, /definition: rule\.draftDefinition/);
	assert.match(source, /ruleVersion: rule\.draftVersion/);
});

test("supporting resource revocation exits before the workspace mounts", () => {
	assert.match(route, /failureReason/);
	assert.match(route, /error instanceof ApiError && error\.status === 403/);
	assert.match(route, /if \(supportingAccessRevoked\) return/);
});
