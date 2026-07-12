import type {
	AutomationRuleAction,
	AutomationRuleCondition,
	AutomationRuleDefinition,
	AutomationRuleState,
	AutomationRunState,
} from "../../shared/automation-rules.ts";

export type AutomationTab = "rules" | "runs";

export function automationTabFromParams(params: URLSearchParams): AutomationTab {
	return params.get("tab") === "runs" ? "runs" : "rules";
}

export function paramsWithAutomationTab(
	params: URLSearchParams,
	tab: AutomationTab,
): URLSearchParams {
	const next = new URLSearchParams(params);
	if (tab === "rules") next.delete("tab");
	else next.set("tab", tab);
	next.delete("rule");
	next.delete("compose");
	return next;
}

export function paramsWithAutomationRule(
	params: URLSearchParams,
	ruleId: string | null,
	compose = false,
): URLSearchParams {
	const next = new URLSearchParams(params);
	next.delete("tab");
	if (ruleId) next.set("rule", ruleId);
	else next.delete("rule");
	if (compose) next.set("compose", "new");
	else next.delete("compose");
	return next;
}

const RULE_STATE_LABELS: Record<AutomationRuleState, string> = {
	draft: "Draft",
	enabled: "Enabled",
	disabled: "Disabled",
	needs_attention: "Needs attention",
	archived: "Archived",
};

const RUN_STATE_LABELS: Record<AutomationRunState, string> = {
	pending: "Pending",
	processing: "Processing",
	no_match: "No match",
	applied: "Applied",
	applied_with_skips: "Applied with skips",
	failed: "Failed",
};

export function automationRuleStateLabel(state: AutomationRuleState): string {
	return RULE_STATE_LABELS[state];
}

export function automationRunStateLabel(state: AutomationRunState): string {
	return RUN_STATE_LABELS[state];
}

export interface AutomationTargetNames {
	labels?: Readonly<Record<string, string>>;
	folders?: Readonly<Record<string, string>>;
}

function quotedList(values: readonly string[]): string {
	return values.map((value) => `“${value}”`).join(", ");
}

export function describeAutomationCondition(
	condition: AutomationRuleCondition,
): string {
	switch (condition.kind) {
		case "sender_address":
			return `Sender address ${condition.operator === "is_any_of" ? "is any of" : "is not any of"} ${quotedList(condition.values)}`;
		case "sender_domain":
			return `Sender domain ${condition.operator === "is_any_of" ? "is any of" : "is not any of"} ${quotedList(condition.values)}`;
		case "subject": {
			const operator = {
				equals: "equals",
				contains: "contains",
				starts_with: "starts with",
				does_not_contain: "does not contain",
			}[condition.operator];
			return `Subject ${operator} “${condition.value}”`;
		}
		case "attachment_presence":
			return condition.operator === "has"
				? "Message has an attachment"
				: "Message does not have an attachment";
		case "attachment_filename":
			return condition.operator === "contains"
				? `Attachment filename contains “${condition.value}”`
				: `Attachment filename ends with ${quotedList(condition.values)}`;
		case "every_incoming":
			return "Every incoming message";
	}
	throw new Error("Unsupported Automation condition");
}

export function describeAutomationAction(
	action: AutomationRuleAction,
	targets: AutomationTargetNames = {},
): string {
	switch (action.kind) {
		case "apply_labels":
			return `Apply ${action.labelIds.map((id) => targets.labels?.[id] ?? "Unavailable label").join(", ")}`;
		case "star":
			return "Star the incoming message";
		case "move_to_folder":
			return `Move the Inbox conversation to ${targets.folders?.[action.folderId] ?? "Unavailable folder"}`;
	}
	throw new Error("Unsupported Automation action");
}

export function describeAutomationDefinition(
	definition: AutomationRuleDefinition,
	targets: AutomationTargetNames = {},
): string {
	const joiner = definition.match === "all" ? " and " : " or ";
	const conditions = definition.conditions
		.map((condition) => describeAutomationCondition(condition))
		.join(joiner);
	const actions = definition.actions
		.map((action) => describeAutomationAction(action, targets))
		.join("; ");
	return `When ${conditions}, ${actions}.`;
}

export function relativeAutomationTime(
	value: string | null | undefined,
	now = Date.now(),
): string {
	if (!value) return "Never";
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return "Unavailable";
	const elapsed = Math.max(0, now - timestamp);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "Just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: timestamp < new Date(now).setFullYear(new Date(now).getFullYear() - 1)
			? "numeric"
			: undefined,
	}).format(timestamp);
}
