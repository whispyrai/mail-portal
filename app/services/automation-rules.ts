import { z } from "zod";
import {
	AUTOMATION_RULE_STATES,
	AUTOMATION_RUN_RESULT_OUTCOMES,
	AUTOMATION_RUN_STATES,
	AutomationRuleDefinitionSchema,
	type AutomationRuleDefinition,
} from "../../shared/automation-rules.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const id = z.string().min(1).max(300);
const timestamp = z.string().datetime({ offset: true });
const nullableTimestamp = timestamp.nullable();
const nonnegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();

const AutomationRuleSchema = z.object({
	id,
	name: z.string().min(1).max(80),
	state: z.enum(AUTOMATION_RULE_STATES),
	position: nonnegativeInteger,
	revision: positiveInteger,
	activeVersion: positiveInteger.nullable(),
	draftVersion: positiveInteger.nullable(),
	activeDefinition: AutomationRuleDefinitionSchema.nullable(),
	draftDefinition: AutomationRuleDefinitionSchema.nullable(),
	createdBy: id,
	createdAt: timestamp,
	updatedBy: id,
	updatedAt: timestamp,
	archivedBy: id.nullable(),
	archivedAt: nullableTimestamp,
	targetHealth: z.enum(["ready", "needs_attention"]),
	lastRunAt: nullableTimestamp,
	lastMatchedAt: nullableTimestamp,
}).strict();

const AutomationRuleVersionSchema = z.object({
	ruleId: id,
	version: positiveInteger,
	definition: AutomationRuleDefinitionSchema,
	definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
	createdBy: id,
	createdAt: timestamp,
	isActive: z.boolean(),
	isDraft: z.boolean(),
}).strict();

const ActionCountsSchema = z.object({
	wouldChange: nonnegativeInteger,
	alreadySatisfied: nonnegativeInteger,
	conflicts: nonnegativeInteger,
}).strict();

const AutomationTestSampleSchema = z.object({
	messageId: id,
	conversationId: id,
	sender: z.string().max(320),
	subject: z.string().max(998),
	date: timestamp,
	href: z.string().min(1).max(2_000),
	matchedConditionIndexes: z.array(nonnegativeInteger).max(10),
	plannedActions: z.array(z.string().min(1).max(120)).max(5),
	noOpActions: z.array(z.string().min(1).max(120)).max(100),
	conflicts: z.array(z.string().min(1).max(120)).max(100),
}).strict();

const AutomationRuleTestSchema = z.object({
	id,
	ruleId: id.nullable(),
	ruleVersion: positiveInteger.nullable(),
	definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
	evaluatedCount: nonnegativeInteger,
	matchedCount: nonnegativeInteger,
	acknowledgedZero: z.boolean(),
	actionCounts: ActionCountsSchema,
	samples: z.array(AutomationTestSampleSchema).max(20),
	actorId: id,
	createdAt: timestamp,
	expiresAt: timestamp,
}).strict();

const AutomationActionResultSchema = z.object({
	action: z.string().min(1).max(160),
	status: z.enum([
		"applied",
		"already_satisfied",
		"skipped_conflict",
		"skipped_invalid_target",
	]),
}).strict();

const AutomationRunResultSchema = z.object({
	ordinal: nonnegativeInteger,
	ruleId: id,
	ruleName: z.string().min(1).max(80),
	ruleVersion: positiveInteger,
	outcome: z.enum(AUTOMATION_RUN_RESULT_OUTCOMES),
	matchedConditionIndexes: z.array(nonnegativeInteger).max(10),
	plannedActions: z.array(z.string().min(1).max(120)).max(5),
	actionResults: z.array(AutomationActionResultSchema).max(100),
	failureCategory: z.string().min(1).max(80).nullable(),
	attemptCount: nonnegativeInteger,
	createdAt: timestamp,
}).strict();

const AvailableRunMessageSchema = z.object({
	state: z.literal("available"),
	messageId: id,
	conversationId: id,
	sender: z.string().max(320),
	subject: z.string().max(998),
	date: timestamp,
	href: z.string().min(1).max(2_000),
}).strict();

const UnavailableRunMessageSchema = z.object({
	state: z.literal("unavailable"),
	messageId: id,
	label: z.literal("Message no longer available"),
}).strict();

const AutomationRunSchema = z.object({
	id,
	message: z.discriminatedUnion("state", [
		AvailableRunMessageSchema,
		UnavailableRunMessageSchema,
	]),
	rulesetGeneration: nonnegativeInteger,
	state: z.enum(AUTOMATION_RUN_STATES),
	attemptCount: nonnegativeInteger,
	evaluatedCount: nonnegativeInteger,
	matchedCount: nonnegativeInteger,
	appliedCount: nonnegativeInteger,
	stoppedByRuleId: id.nullable(),
	completedAt: nullableTimestamp,
	failureCategory: z.string().min(1).max(80).nullable(),
	createdAt: timestamp,
	updatedAt: timestamp,
	results: z.array(AutomationRunResultSchema).max(100).optional(),
}).strict();

const RuleListResponseSchema = z.object({
	rules: z.array(AutomationRuleSchema).max(500),
	rulesetGeneration: nonnegativeInteger,
	orderRevision: nonnegativeInteger,
	canManage: z.boolean(),
}).strict();

const RuleMutationResponseSchema = z.object({
	rule: AutomationRuleSchema,
	rulesetGeneration: nonnegativeInteger,
	orderRevision: nonnegativeInteger,
	canManage: z.literal(true),
}).strict();

const RuleDetailResponseSchema = z.object({
	rule: AutomationRuleSchema,
	versions: z.array(AutomationRuleVersionSchema).max(500).optional(),
	canManage: z.boolean(),
}).strict();

const VersionsResponseSchema = z.object({
	versions: z.array(AutomationRuleVersionSchema).max(500),
	canManage: z.boolean(),
}).strict();

const TestsResponseSchema = z.object({
	tests: z.array(AutomationRuleTestSchema).max(500),
	nextCursor: z.string().min(1).max(2_000).nullable(),
	canManage: z.boolean(),
}).strict();

const TestResponseSchema = z.object({
	test: AutomationRuleTestSchema,
	replayed: z.boolean(),
	canManage: z.literal(true),
}).strict();

const RunsResponseSchema = z.object({
	runs: z.array(AutomationRunSchema).max(100),
	nextCursor: z.string().min(1).max(2_000).nullable(),
	canManage: z.boolean(),
}).strict();

const RunDetailResponseSchema = z.object({
	run: AutomationRunSchema,
	canManage: z.boolean(),
}).strict();

export type AutomationRule = z.infer<typeof AutomationRuleSchema>;
export type AutomationRuleVersion = z.infer<typeof AutomationRuleVersionSchema>;
export type AutomationRuleTest = z.infer<typeof AutomationRuleTestSchema>;
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
export type AutomationRunResult = z.infer<typeof AutomationRunResultSchema>;
export type AutomationRuleListResponse = z.infer<typeof RuleListResponseSchema>;
export type AutomationRuleMutationResponse = z.infer<typeof RuleMutationResponseSchema>;
export type AutomationRuleDetailResponse = z.infer<typeof RuleDetailResponseSchema>;
export type AutomationRuleVersionsResponse = z.infer<typeof VersionsResponseSchema>;
export type AutomationRuleTestsResponse = z.infer<typeof TestsResponseSchema>;
export type AutomationRuleTestResponse = z.infer<typeof TestResponseSchema>;
export type AutomationRunsResponse = z.infer<typeof RunsResponseSchema>;
export type AutomationRunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export class AutomationRulesApiError extends Error {
	readonly status: number;
	readonly code: string | null;

	constructor(status: number, message: string, code: string | null = null) {
		super(message);
		this.name = "AutomationRulesApiError";
		this.status = status;
		this.code = code;
	}
}

export class AutomationRulesResponseError extends Error {
	constructor() {
		super("The Automations service returned an invalid response");
		this.name = "AutomationRulesResponseError";
	}
}

export function isAutomationAccessRevoked(error: unknown): boolean {
	return error instanceof AutomationRulesApiError && error.status === 403;
}

function apiPath(mailboxId: string, suffix: string): string {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/${suffix}`;
}

async function requestJson<T>(input: {
	mailboxId: string;
	path: string;
	method?: "GET" | "POST" | "PUT" | "DELETE";
	body?: unknown;
	signal?: AbortSignal;
	fetcher?: FetchLike;
	parse(value: unknown): T;
}): Promise<T> {
	const response = await (input.fetcher ?? fetch)(
		apiPath(input.mailboxId, input.path),
		{
			method: input.method ?? "GET",
			credentials: "same-origin",
			cache: "no-store",
			headers: input.body === undefined ? undefined : { "Content-Type": "application/json" },
			body: input.body === undefined ? undefined : JSON.stringify(input.body),
			signal: input.signal,
		},
	);
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const record = body && typeof body === "object" && !Array.isArray(body)
			? body as Record<string, unknown>
			: {};
		throw new AutomationRulesApiError(
			response.status,
			typeof record.error === "string" && record.error.trim()
				? record.error.trim()
				: "Automations are unavailable",
			typeof record.code === "string" ? record.code : null,
		);
	}
	try {
		return input.parse(body);
	} catch {
		throw new AutomationRulesResponseError();
	}
}

export function fetchAutomationRules(
	mailboxId: string,
	options: { signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<AutomationRuleListResponse> {
	return requestJson({
		mailboxId,
		path: "automation-rules",
		signal: options.signal,
		fetcher: options.fetcher,
		parse: (value) => RuleListResponseSchema.parse(value),
	});
}

export function fetchAutomationRule(
	mailboxId: string,
	ruleId: string,
	options: { signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<AutomationRuleDetailResponse> {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}`,
		signal: options.signal,
		fetcher: options.fetcher,
		parse: (value) => RuleDetailResponseSchema.parse(value),
	});
}

export function createAutomationRule(
	mailboxId: string,
	input: {
		definition: AutomationRuleDefinition;
		expectedOrderRevision: number;
	},
	fetcher?: FetchLike,
): Promise<AutomationRuleMutationResponse> {
	return requestJson({
		mailboxId,
		path: "automation-rules",
		method: "POST",
		body: input,
		fetcher,
		parse: (value) => RuleMutationResponseSchema.parse(value),
	});
}

export function updateAutomationRule(
	mailboxId: string,
	ruleId: string,
	input: { definition: AutomationRuleDefinition; expectedRevision: number },
): Promise<AutomationRuleMutationResponse> {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}`,
		method: "PUT",
		body: input,
		parse: (value) => RuleMutationResponseSchema.parse(value),
	});
}

export function archiveAutomationRule(mailboxId: string, ruleId: string, expectedRevision: number) {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}`,
		method: "DELETE",
		body: { expectedRevision },
		parse: (value) => RuleMutationResponseSchema.parse(value),
	});
}

export function setAutomationRuleEnabled(
	mailboxId: string,
	ruleId: string,
	enabled: boolean,
	input: { expectedRevision: number },
	fetcher?: FetchLike,
) {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}/${enabled ? "enable" : "disable"}`,
		method: "POST",
		body: input,
		fetcher,
		parse: (value) => RuleMutationResponseSchema.parse(value),
	});
}

export function reorderAutomationRules(
	mailboxId: string,
	orderedRuleIds: string[],
	expectedOrderRevision: number,
) {
	return requestJson({
		mailboxId,
		path: "automation-rules/order",
		method: "PUT",
		body: { orderedRuleIds, expectedOrderRevision },
		parse: (value) => RuleListResponseSchema.parse(value),
	});
}

export function dryRunAutomationRule(
	mailboxId: string,
	input: {
		definition: AutomationRuleDefinition;
		ruleId: string;
		ruleVersion: number;
		acknowledgedZero: boolean;
		operationId: string;
	},
	fetcher?: FetchLike,
) {
	return requestJson({
		mailboxId,
		path: "automation-rules/dry-run",
		method: "POST",
		body: input,
		fetcher,
		parse: (value) => TestResponseSchema.parse(value),
	});
}

export function fetchAutomationRuns(
	mailboxId: string,
	input: { cursor?: string; state?: string; signal?: AbortSignal; fetcher?: FetchLike } = {},
) {
	const params = new URLSearchParams();
	if (input.cursor) params.set("cursor", input.cursor);
	if (input.state) params.set("state", input.state);
	const query = params.size ? `?${params.toString()}` : "";
	return requestJson({
		mailboxId,
		path: `automation-runs${query}`,
		signal: input.signal,
		fetcher: input.fetcher,
		parse: (value) => RunsResponseSchema.parse(value),
	});
}

export function fetchAutomationRun(
	mailboxId: string,
	runId: string,
	options: { signal?: AbortSignal; fetcher?: FetchLike } = {},
) {
	return requestJson({
		mailboxId,
		path: `automation-runs/${encodeURIComponent(runId)}`,
		signal: options.signal,
		fetcher: options.fetcher,
		parse: (value) => RunDetailResponseSchema.parse(value),
	});
}

export function fetchAutomationRuleVersions(mailboxId: string, ruleId: string, signal?: AbortSignal) {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}/versions`,
		signal,
		parse: (value) => VersionsResponseSchema.parse(value),
	});
}

export function fetchAutomationRuleTests(mailboxId: string, ruleId?: string, signal?: AbortSignal) {
	const query = ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : "";
	return requestJson({
		mailboxId,
		path: `automation-rule-tests${query}`,
		signal,
		parse: (value) => TestsResponseSchema.parse(value),
	});
}

export function restoreAutomationRuleVersion(
	mailboxId: string,
	ruleId: string,
	input: { version: number; expectedRevision: number },
) {
	return requestJson({
		mailboxId,
		path: `automation-rules/${encodeURIComponent(ruleId)}/restore-version`,
		method: "POST",
		body: input,
		parse: (value) => RuleMutationResponseSchema.parse(value),
	});
}
