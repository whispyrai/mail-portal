import {
	canonicalAutomationRuleDefinition,
	type AutomationRuleDefinition,
} from "../../shared/automation-rules.ts";

export function automationDryRunIntent(input: {
	mailboxId: string;
	ruleId: string;
	ruleVersion: number;
	definition: AutomationRuleDefinition;
	acknowledgedZero: boolean;
}): unknown[] {
	return [
		input.mailboxId.toLowerCase(),
		"automation-dry-run",
		input.ruleId,
		input.ruleVersion,
		canonicalAutomationRuleDefinition(input.definition),
		input.acknowledgedZero,
	];
}
