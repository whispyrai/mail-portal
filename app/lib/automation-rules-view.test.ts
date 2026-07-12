import assert from "node:assert/strict";
import test from "node:test";
import {
	automationTabFromParams,
	describeAutomationDefinition,
	paramsWithAutomationRule,
	paramsWithAutomationTab,
	relativeAutomationTime,
} from "./automation-rules-view.ts";

test("automation tabs are URL-owned and invalid values safely select Rules", () => {
	assert.equal(automationTabFromParams(new URLSearchParams("tab=runs")), "runs");
	assert.equal(automationTabFromParams(new URLSearchParams("tab=unknown")), "rules");
	assert.equal(paramsWithAutomationTab(new URLSearchParams("rule=r1&compose=new"), "runs").toString(), "tab=runs");
});

test("opening and closing a rule preserves unrelated URL state", () => {
	const opened = paramsWithAutomationRule(new URLSearchParams("q=keep"), "r1");
	assert.equal(opened.get("q"), "keep");
	assert.equal(opened.get("rule"), "r1");
	assert.equal(paramsWithAutomationRule(opened, null).toString(), "q=keep");
});

test("plain-language definitions resolve target names without exposing IDs", () => {
	const description = describeAutomationDefinition({
		schemaVersion: 1,
		name: "Invoices",
		match: "all",
		conditions: [{ kind: "sender_domain", operator: "is_any_of", values: ["vendor.test"] }],
		actions: [{ kind: "apply_labels", labelIds: ["label-1"] }, { kind: "star" }],
		stopProcessing: false,
	}, { labels: { "label-1": "Finance" } });
	assert.equal(description, "When Sender domain is any of “vendor.test”, Apply Finance; Star the incoming message.");
	assert.doesNotMatch(description, /label-1/);
});

test("relative time is bounded and handles absent or invalid values", () => {
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	assert.equal(relativeAutomationTime(null, now), "Never");
	assert.equal(relativeAutomationTime("bad", now), "Unavailable");
	assert.equal(relativeAutomationTime("2026-07-12T11:45:00.000Z", now), "15m ago");
});
