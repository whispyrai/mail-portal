import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationRuleDefinition } from "../../shared/automation-rules.ts";
import { CreateOperationIdentity } from "./create-operation-identity.ts";
import { automationDryRunIntent } from "./automation-dry-run-identity.ts";

const definition: AutomationRuleDefinition = {
	schemaVersion: 1,
	name: "Invoices",
	match: "all",
	conditions: [{ kind: "subject", operator: "contains", value: "invoice" }],
	actions: [{ kind: "star" }],
	stopProcessing: false,
};

test("an ambiguous Automation test retry keeps identity until semantic intent changes", () => {
	let sequence = 0;
	const identity = new CreateOperationIdentity(() => `operation-${++sequence}`);
	const intent = (overrides: Partial<Parameters<typeof automationDryRunIntent>[0]> = {}) =>
		automationDryRunIntent({
			mailboxId: "TEAM@EXAMPLE.COM",
			ruleId: "rule-1",
			ruleVersion: 1,
			definition,
			acknowledgedZero: false,
			...overrides,
		});
	assert.equal(identity.operationIdFor(intent()), "operation-1");
	assert.equal(identity.operationIdFor(intent({ mailboxId: "team@example.com" })), "operation-1");
	for (const changed of [
		intent({ ruleVersion: 2 }),
		intent({ acknowledgedZero: true }),
		intent({ definition: { ...definition, name: "Receipts" } }),
	]) {
		assert.equal(identity.invalidateIfIntentChanged(changed), true);
		identity.operationIdFor(changed);
	}
	identity.invalidate();
	assert.equal(identity.operationIdFor(intent()), "operation-5");
});
