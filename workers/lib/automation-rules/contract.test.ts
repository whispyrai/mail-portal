import assert from "node:assert/strict";
import test from "node:test";
import {
	AutomationRuleContractError,
	canonicalAutomationRuleDefinition,
	parseAutomationRuleDefinition,
} from "../../../shared/automation-rules.ts";
import { evaluateAutomationRule } from "./index.ts";

const valid = {
	schemaVersion: 1,
	name: "  Finance   mail  ",
	match: "all",
	conditions: [
		{
			kind: "sender_domain",
			operator: "is_any_of",
			values: ["Example.COM"],
		},
	],
	actions: [{ kind: "apply_labels", labelIds: ["label_finance"] }],
	stopProcessing: false,
};

test("Automation Rule grammar canonicalizes deterministic identity fields", () => {
	const parsed = parseAutomationRuleDefinition(valid);
	assert.equal(parsed.name, "Finance mail");
	assert.deepEqual(parsed.conditions, [
		{
			kind: "sender_domain",
			operator: "is_any_of",
			values: ["example.com"],
		},
	]);
	assert.equal(canonicalAutomationRuleDefinition(valid), JSON.stringify(parsed));
});

test("Automation Rule grammar rejects forbidden or executable behavior", () => {
	for (const forbidden of [
		{ ...valid, conditions: [{ kind: "body", operator: "contains", value: "secret" }] },
		{ ...valid, conditions: [{ kind: "subject", operator: "regex", value: ".*" }] },
		{ ...valid, actions: [{ kind: "send", recipient: "x@example.com" }] },
		{ ...valid, actions: [{ kind: "trash" }] },
		{ ...valid, actions: [{ kind: "webhook", url: "https://example.com" }] },
		{ ...valid, actions: [{ kind: "ai_classify" }] },
		{ ...valid, unknown: true },
	]) {
		assert.throws(() => parseAutomationRuleDefinition(forbidden), AutomationRuleContractError);
	}
});

test("Every incoming Message is exclusive and explicit", () => {
	assert.throws(
		() => parseAutomationRuleDefinition({
			...valid,
			conditions: [
				{ kind: "every_incoming" },
				{ kind: "attachment_presence", operator: "has" },
			],
		}),
		AutomationRuleContractError,
	);
	assert.equal(
		parseAutomationRuleDefinition({ ...valid, conditions: [{ kind: "every_incoming" }] })
			.conditions[0]?.kind,
		"every_incoming",
	);
});

test("each action type is unique within a deterministic Rule", () => {
	assert.throws(() => parseAutomationRuleDefinition({
		...valid,
		actions: [{ kind: "star" }, { kind: "star" }],
	}));
});

test("dry-run and live evaluator behavior is deterministic for missing fields and attachments", () => {
	const definition = parseAutomationRuleDefinition({
		...valid,
		match: "any",
		conditions: [
			{ kind: "subject", operator: "does_not_contain", value: "invoice" },
			{ kind: "attachment_filename", operator: "ends_with_any", values: [".PDF"] },
		],
	});
	const evaluation = evaluateAutomationRule(definition, {
		messageId: "message_1",
		conversationId: "conversation_1",
		folderId: "inbox",
		senderAddress: "",
		subject: "",
		date: "2026-07-12T12:00:00.000Z",
		attachments: [
			{ filename: "Quarterly Report.pdf", disposition: "inline" },
			{ filename: "", disposition: "attachment" },
		],
	});
	assert.equal(evaluation.matched, true);
	assert.deepEqual(evaluation.matchedConditionIndexes, [0, 1]);
});
