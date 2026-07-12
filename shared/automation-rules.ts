import { z } from "zod";

export const AUTOMATION_RULE_LIMITS = {
	definitionBytes: 16 * 1024,
	nameChars: 80,
	conditionCount: 10,
	actionCount: 5,
	addressValues: 20,
	labelIds: 20,
	filenameSuffixes: 10,
	conditionValueChars: 320,
	dryRunMessages: 100,
	dryRunSamples: 20,
	liveRuns: 5_000,
	dryRuns: 500,
} as const;

export const AUTOMATION_RULE_STATES = [
	"draft",
	"enabled",
	"disabled",
	"needs_attention",
	"archived",
] as const;

export const AUTOMATION_RUN_STATES = [
	"pending",
	"processing",
	"no_match",
	"applied",
	"applied_with_skips",
	"failed",
] as const;

export const AUTOMATION_RUN_RESULT_OUTCOMES = [
	"not_matched",
	"applied",
	"already_satisfied",
	"skipped_conflict",
	"skipped_invalid_target",
	"skipped_scope_changed",
	"stopped",
] as const;

export type AutomationRuleState = (typeof AUTOMATION_RULE_STATES)[number];
export type AutomationRunState = (typeof AUTOMATION_RUN_STATES)[number];
export type AutomationRunResultOutcome =
	(typeof AUTOMATION_RUN_RESULT_OUTCOMES)[number];

const CONTROL_TEXT = /[\u0000-\u001F\u007F]/u;
const ADDRESS = /^[^\s@]+@[^\s@]+$/u;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/u;

function normalizeText(value: string): string {
	return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

const identifier = z.string().trim().min(1).max(300).refine(
	(value) => !CONTROL_TEXT.test(value) && value === value.normalize("NFC"),
);

const boundedText = z.string().transform(normalizeText).pipe(
	z.string().min(1).max(AUTOMATION_RULE_LIMITS.conditionValueChars).refine(
		(value) => !CONTROL_TEXT.test(value),
	),
);

const address = z.string().transform((value) => normalizeText(value).toLowerCase()).pipe(
	z.string().max(320).refine((value) => ADDRESS.test(value)),
);

const domain = z.string().transform((value) => normalizeText(value).toLowerCase()).pipe(
	z.string().max(253).refine((value) => DOMAIN.test(value)),
);

function uniqueValues<T>(values: T[]): boolean {
	return new Set(values).size === values.length;
}

const addressValues = z.array(address).min(1).max(AUTOMATION_RULE_LIMITS.addressValues)
	.refine(uniqueValues, "Address values must be unique");
const domainValues = z.array(domain).min(1).max(AUTOMATION_RULE_LIMITS.addressValues)
	.refine(uniqueValues, "Domain values must be unique");

const SenderAddressCondition = z.object({
	kind: z.literal("sender_address"),
	operator: z.enum(["is_any_of", "is_not_any_of"]),
	values: addressValues,
}).strict();

const SenderDomainCondition = z.object({
	kind: z.literal("sender_domain"),
	operator: z.enum(["is_any_of", "is_not_any_of"]),
	values: domainValues,
}).strict();

const SubjectCondition = z.object({
	kind: z.literal("subject"),
	operator: z.enum(["equals", "contains", "starts_with", "does_not_contain"]),
	value: boundedText,
}).strict();

const AttachmentPresenceCondition = z.object({
	kind: z.literal("attachment_presence"),
	operator: z.enum(["has", "does_not_have"]),
}).strict();

const AttachmentFilenameContainsCondition = z.object({
	kind: z.literal("attachment_filename"),
	operator: z.literal("contains"),
	value: boundedText,
}).strict();

const AttachmentFilenameSuffixCondition = z.object({
	kind: z.literal("attachment_filename"),
	operator: z.literal("ends_with_any"),
	values: z.array(boundedText)
		.min(1)
		.max(AUTOMATION_RULE_LIMITS.filenameSuffixes)
		.refine(uniqueValues, "Filename suffixes must be unique"),
}).strict();

const EveryIncomingCondition = z.object({
	kind: z.literal("every_incoming"),
}).strict();

export const AutomationRuleConditionSchema = z.union([
	SenderAddressCondition,
	SenderDomainCondition,
	SubjectCondition,
	AttachmentPresenceCondition,
	AttachmentFilenameContainsCondition,
	AttachmentFilenameSuffixCondition,
	EveryIncomingCondition,
]);

const ApplyLabelsAction = z.object({
	kind: z.literal("apply_labels"),
	labelIds: z.array(identifier)
		.min(1)
		.max(AUTOMATION_RULE_LIMITS.labelIds)
		.refine(uniqueValues, "Label IDs must be unique"),
}).strict();

const StarAction = z.object({ kind: z.literal("star") }).strict();
const MoveAction = z.object({
	kind: z.literal("move_to_folder"),
	folderId: identifier,
}).strict();

export const AutomationRuleActionSchema = z.discriminatedUnion("kind", [
	ApplyLabelsAction,
	StarAction,
	MoveAction,
]);

export const AutomationRuleDefinitionSchema = z.object({
	schemaVersion: z.literal(1),
	name: z.string().transform(normalizeText).pipe(
		z.string().min(1).max(AUTOMATION_RULE_LIMITS.nameChars).refine(
			(value) => !CONTROL_TEXT.test(value),
		),
	),
	match: z.enum(["all", "any"]),
	conditions: z.array(AutomationRuleConditionSchema)
		.min(1)
		.max(AUTOMATION_RULE_LIMITS.conditionCount),
	actions: z.array(AutomationRuleActionSchema)
		.min(1)
		.max(AUTOMATION_RULE_LIMITS.actionCount),
	stopProcessing: z.boolean(),
}).strict().superRefine((definition, context) => {
	const everyIndexes = definition.conditions.flatMap((condition, index) =>
		condition.kind === "every_incoming" ? [index] : []
	);
	if (everyIndexes.length > 0 && definition.conditions.length !== 1) {
		context.addIssue({
			code: "custom",
			path: ["conditions", everyIndexes[0]],
			message: "Every incoming Message must be the only condition",
		});
	}
	const actionKinds = definition.actions.map((action) => action.kind);
	for (const [index, kind] of actionKinds.entries()) {
		if (actionKinds.indexOf(kind) !== index) {
			context.addIssue({
				code: "custom",
				path: ["actions", index],
				message: "Each Automation action type may appear only once",
			});
		}
	}
});

export type AutomationRuleCondition = z.infer<typeof AutomationRuleConditionSchema>;
export type AutomationRuleAction = z.infer<typeof AutomationRuleActionSchema>;
export type AutomationRuleDefinition = z.infer<typeof AutomationRuleDefinitionSchema>;

export class AutomationRuleContractError extends Error {
	constructor(message = "Automation Rule definition is invalid") {
		super(message);
		this.name = "AutomationRuleContractError";
	}
}

export function parseAutomationRuleDefinition(input: unknown): AutomationRuleDefinition {
	const result = AutomationRuleDefinitionSchema.safeParse(input);
	if (!result.success) throw new AutomationRuleContractError();
	const canonical = JSON.stringify(result.data);
	if (new TextEncoder().encode(canonical).byteLength > AUTOMATION_RULE_LIMITS.definitionBytes) {
		throw new AutomationRuleContractError("Automation Rule definition is too large");
	}
	return result.data;
}

export function canonicalAutomationRuleDefinition(input: unknown): string {
	return JSON.stringify(parseAutomationRuleDefinition(input));
}

export async function fingerprintAutomationRuleDefinition(input: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalAutomationRuleDefinition(input));
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
}

export type AutomationMessageSnapshot = {
	messageId: string;
	conversationId: string;
	folderId: string;
	senderAddress: string;
	subject: string;
	date: string;
	attachments: Array<{
		filename: string;
		disposition: "attachment" | "inline";
	}>;
};

export type AutomationRuleVersionSnapshot = {
	ordinal: number;
	ruleId: string;
	ruleName: string;
	version: number;
	definition: AutomationRuleDefinition;
	definitionFingerprint: string;
};
