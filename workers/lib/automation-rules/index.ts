import {
	AUTOMATION_RULE_LIMITS,
	canonicalAutomationRuleDefinition,
	fingerprintAutomationRuleDefinition,
	parseAutomationRuleDefinition,
	type AutomationMessageSnapshot,
	type AutomationRuleAction,
	type AutomationRuleCondition,
	type AutomationRuleDefinition,
	type AutomationRuleState,
	type AutomationRuleVersionSnapshot,
	type AutomationRunResultOutcome,
	type AutomationRunState,
} from "../../../shared/automation-rules.ts";

type SqlValue = ArrayBuffer | string | number | null;

export type AutomationRulesSql = {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
};

export type AutomationRulesStorage = {
	sql: AutomationRulesSql;
	transactionSync<T>(run: () => T): T;
};

export const AUTOMATION_RUNTIME_LIMITS = {
	maxRules: 100,
	maxRetainedRules: 500,
	maxVersionsPerRule: 500,
	maxRetainedVersions: 5_000,
	maxEnabledRules: 50,
	leaseMs: 30_000,
	maxAttempts: 4,
	retryMs: [10_000, 30_000, 120_000] as const,
	liveRetentionMs: 90 * 24 * 60 * 60_000,
	testRetentionMs: 30 * 24 * 60 * 60_000,
	pruneBatch: 100,
} as const;

export type AutomationRuleRecord = {
	id: string;
	name: string;
	state: AutomationRuleState;
	activeVersion: number | null;
	draftVersion: number | null;
	nextVersion: number;
	position: number;
	revision: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string;
	updatedAt: string;
	archivedBy: string | null;
	archivedAt: string | null;
};

export type AutomationRuleVersionRecord = {
	ruleId: string;
	version: number;
	definition: AutomationRuleDefinition;
	definitionFingerprint: string;
	createdBy: string;
	createdAt: string;
};

export type AutomationRulesState = {
	rulesetGeneration: number;
	orderRevision: number;
	updatedAt: string;
};

export type AutomationRuleEvaluation = {
	matched: boolean;
	matchedConditionIndexes: number[];
	conditionResults: Array<{ index: number; code: string; matched: boolean }>;
};

export type AutomationActionResult = {
	action: string;
	status:
		| "applied"
		| "already_satisfied"
		| "skipped_conflict"
		| "skipped_invalid_target";
	targetId: string | null;
};

export type AutomationPlannedRuleResult = {
	ordinal: number;
	ruleId: string;
	ruleName: string;
	ruleVersion: number;
	outcome: AutomationRunResultOutcome;
	matchedConditionIndexes: number[];
	plannedActions: string[];
	actionResults: AutomationActionResult[];
	failureCategory: string | null;
};

export type AutomationActionPlan = {
	state: Extract<AutomationRunState, "no_match" | "applied" | "applied_with_skips" | "failed">;
	evaluatedCount: number;
	matchedCount: number;
	appliedCount: number;
	stoppedByRuleId: string | null;
	applyLabels: Array<{ labelId: string; ruleId: string; ruleVersion: number }>;
	star: { ruleId: string; ruleVersion: number } | null;
	move: { folderId: string; ruleId: string; ruleVersion: number } | null;
	results: AutomationPlannedRuleResult[];
};

export type AutomationPlanningContext = {
	snapshot: AutomationMessageSnapshot;
	currentInboxScope: null | {
		conversationMessageIds: string[];
		existingLabelIds: string[];
		triggerIsStarred: boolean;
	};
	availableLabelIds: string[];
	availableMoveFolderIds: string[];
};

export type AutomationRunClaim = {
	id: string;
	triggerMessageId: string;
	rulesetGeneration: number;
	attemptCount: number;
	leaseToken: string;
	leaseExpiresAt: string;
	rules: AutomationRuleVersionSnapshot[];
};

export type AutomationDryRunRecord = {
	id: string;
	actorId: string;
	ruleId: string | null;
	ruleVersion: number | null;
	definitionFingerprint: string;
	evaluatedCount: number;
	matchedCount: number;
	acknowledgedZero: boolean;
	result: {
		wouldChange: number;
		alreadySatisfied: number;
		conflicts: number;
		samples: Array<{
			messageId: string;
			conversationId: string;
			sender: string;
			subject: string;
			date: string;
			matchedConditionIndexes: number[];
			plannedActions: string[];
			noOpActions: string[];
			conflicts: string[];
		}>;
	};
	createdAt: string;
	expiresAt: string;
};

export type AutomationRunRecord = {
	id: string;
	triggerMessageId: string;
	rulesetGeneration: number;
	state: AutomationRunState;
	attemptCount: number;
	startedAt: string | null;
	completedAt: string | null;
	evaluatedCount: number;
	matchedCount: number;
	appliedCount: number;
	stoppedByRuleId: string | null;
	failureCategory: string | null;
	createdAt: string;
	updatedAt: string;
};

export type AutomationRunResultRecord = AutomationPlannedRuleResult & {
	attemptCount: number;
	createdAt: string;
};

export type AutomationRuleErrorCode =
	| "INVALID"
	| "NOT_FOUND"
	| "CONFLICT"
	| "DRY_RUN_IDEMPOTENCY_CONFLICT"
	| "RULE_TARGET_IN_USE"
	| "ACTIVATION_TEST_REQUIRED";

export class AutomationRuleError extends Error {
	readonly code: AutomationRuleErrorCode;

	constructor(code: AutomationRuleErrorCode, message: string) {
		super(message);
		this.name = `AutomationRuleError:${code}`;
		this.code = code;
	}
}

type RuleRow = {
	id: string;
	name: string;
	state: AutomationRuleState;
	activeVersion: number | null;
	draftVersion: number | null;
	nextVersion: number;
	position: number;
	revision: number;
	createdBy: string;
	createdAt: string;
	updatedBy: string;
	updatedAt: string;
	archivedBy: string | null;
	archivedAt: string | null;
};

type VersionRow = {
	ruleId: string;
	version: number;
	definitionJson: string;
	definitionFingerprint: string;
	createdBy: string;
	createdAt: string;
};

type ClaimedRunRow = {
	id: string;
	triggerMessageId: string;
	rulesetGeneration: number;
	attemptCount: number;
};

type AutomationTestRow = {
	id: string;
	actorId: string;
	ruleId: string | null;
	ruleVersion: number | null;
	definitionFingerprint: string;
	evaluatedCount: number;
	matchedCount: number;
	acknowledgedZero: number;
	resultJson: string;
	createdAt: string;
	expiresAt: string;
};

function first<T extends Record<string, SqlValue>>(
	sql: AutomationRulesSql,
	query: string,
	...bindings: SqlValue[]
): T | null {
	return [...sql.exec<T>(query, ...bindings)][0] ?? null;
}

function canonicalIso(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function normalizedName(name: string): string {
	return name.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

function ruleFromRow(row: RuleRow): AutomationRuleRecord {
	return row;
}

function versionFromRow(row: VersionRow): AutomationRuleVersionRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(row.definitionJson);
	} catch {
		throw new AutomationRuleError("INVALID", "Stored Automation Rule version is invalid");
	}
	return {
		ruleId: row.ruleId,
		version: row.version,
		definition: parseAutomationRuleDefinition(parsed),
		definitionFingerprint: row.definitionFingerprint,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
	};
}

function conditionCode(condition: AutomationRuleCondition): string {
	if (condition.kind === "every_incoming") return "every_incoming";
	return `${condition.kind}:${condition.operator}`;
}

function folded(value: string): string {
	return value.normalize("NFC").toLowerCase();
}

function senderDomain(address: string): string {
	const normalized = address.trim().toLowerCase();
	const at = normalized.lastIndexOf("@");
	return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1) : "";
}

function conditionMatches(
	condition: AutomationRuleCondition,
	snapshot: AutomationMessageSnapshot,
): boolean {
	if (condition.kind === "every_incoming") return true;
	if (condition.kind === "sender_address") {
		const found = condition.values.includes(snapshot.senderAddress.trim().toLowerCase());
		return condition.operator === "is_any_of" ? found : !found;
	}
	if (condition.kind === "sender_domain") {
		const found = condition.values.includes(senderDomain(snapshot.senderAddress));
		return condition.operator === "is_any_of" ? found : !found;
	}
	if (condition.kind === "subject") {
		const subject = folded(snapshot.subject || "");
		const value = folded(condition.value);
		if (condition.operator === "equals") return subject === value;
		if (condition.operator === "contains") return subject.includes(value);
		if (condition.operator === "starts_with") return subject.startsWith(value);
		return !subject.includes(value);
	}
	if (condition.kind === "attachment_presence") {
		const has = snapshot.attachments.length > 0;
		return condition.operator === "has" ? has : !has;
	}
	const filenames = snapshot.attachments
		.map((attachment) => folded(attachment.filename.trim()))
		.filter(Boolean);
	if (condition.operator === "contains") {
		const value = folded(condition.value);
		return filenames.some((filename) => filename.includes(value));
	}
	const suffixes = condition.values.map(folded);
	return filenames.some((filename) => suffixes.some((suffix) => filename.endsWith(suffix)));
}

export function evaluateAutomationRule(
	definitionInput: unknown,
	snapshot: AutomationMessageSnapshot,
): AutomationRuleEvaluation {
	const definition = parseAutomationRuleDefinition(definitionInput);
	const conditionResults = definition.conditions.map((condition, index) => ({
		index,
		code: conditionCode(condition),
		matched: conditionMatches(condition, snapshot),
	}));
	const matched = definition.match === "all"
		? conditionResults.every((result) => result.matched)
		: conditionResults.some((result) => result.matched);
	return {
		matched,
		matchedConditionIndexes: conditionResults
			.filter((result) => result.matched)
			.map((result) => result.index),
		conditionResults,
	};
}

function actionCode(action: AutomationRuleAction): string {
	return action.kind;
}

export function planAutomationRun(
	rules: readonly AutomationRuleVersionSnapshot[],
	context: AutomationPlanningContext,
): AutomationActionPlan {
	const availableLabels = new Set(context.availableLabelIds);
	const availableFolders = new Set(context.availableMoveFolderIds);
	const satisfiedLabels = new Set(context.currentInboxScope?.existingLabelIds ?? []);
	const applyLabels: AutomationActionPlan["applyLabels"] = [];
	let star: AutomationActionPlan["star"] = null;
	let move: AutomationActionPlan["move"] = null;
	let stoppedByRuleId: string | null = null;
	let matchedCount = 0;
	let appliedCount = 0;
	let hasSkip = false;
	const results: AutomationPlannedRuleResult[] = [];

	for (let index = 0; index < rules.length; index += 1) {
		const rule = rules[index]!;
		if (stoppedByRuleId) {
			results.push({
				ordinal: rule.ordinal,
				ruleId: rule.ruleId,
				ruleName: rule.ruleName,
				ruleVersion: rule.version,
				outcome: "stopped",
				matchedConditionIndexes: [],
				plannedActions: [],
				actionResults: [],
				failureCategory: null,
			});
			continue;
		}

		let definition: AutomationRuleDefinition;
		try {
			definition = parseAutomationRuleDefinition(rule.definition);
		} catch {
			hasSkip = true;
			results.push({
				ordinal: rule.ordinal,
				ruleId: rule.ruleId,
				ruleName: rule.ruleName,
				ruleVersion: rule.version,
				outcome: "skipped_invalid_target",
				matchedConditionIndexes: [],
				plannedActions: [],
				actionResults: [],
				failureCategory: "invalid_captured_definition",
			});
			continue;
		}
		const evaluation = evaluateAutomationRule(definition, context.snapshot);
		if (!evaluation.matched) {
			results.push({
				ordinal: rule.ordinal,
				ruleId: rule.ruleId,
				ruleName: rule.ruleName,
				ruleVersion: rule.version,
				outcome: "not_matched",
				matchedConditionIndexes: evaluation.matchedConditionIndexes,
				plannedActions: definition.actions.map(actionCode),
				actionResults: [],
				failureCategory: null,
			});
			continue;
		}

		matchedCount += 1;
		if (!context.currentInboxScope) {
			hasSkip = true;
			results.push({
				ordinal: rule.ordinal,
				ruleId: rule.ruleId,
				ruleName: rule.ruleName,
				ruleVersion: rule.version,
				outcome: "skipped_scope_changed",
				matchedConditionIndexes: evaluation.matchedConditionIndexes,
				plannedActions: definition.actions.map(actionCode),
				actionResults: [],
				failureCategory: "inbox_scope_changed",
			});
			if (definition.stopProcessing) stoppedByRuleId = rule.ruleId;
			continue;
		}
		const missingTargets = definition.actions.flatMap((action) => {
			if (action.kind === "apply_labels") {
				return action.labelIds.filter((labelId) => !availableLabels.has(labelId));
			}
			if (action.kind === "move_to_folder" && !availableFolders.has(action.folderId)) {
				return [action.folderId];
			}
			return [];
		});
		if (missingTargets.length > 0) {
			hasSkip = true;
			results.push({
				ordinal: rule.ordinal,
				ruleId: rule.ruleId,
				ruleName: rule.ruleName,
				ruleVersion: rule.version,
				outcome: "skipped_invalid_target",
				matchedConditionIndexes: evaluation.matchedConditionIndexes,
				plannedActions: definition.actions.map(actionCode),
				actionResults: missingTargets.map((targetId) => ({
					action: "target",
					status: "skipped_invalid_target",
					targetId,
				})),
				failureCategory: "target_unavailable",
			});
			continue;
		}
		const actionResults: AutomationActionResult[] = [];
		let ruleApplied = false;
		let ruleConflict = false;
		let invalidTarget = false;
		for (const action of definition.actions) {
			if (action.kind === "apply_labels") {
				for (const labelId of action.labelIds) {
					if (!availableLabels.has(labelId)) {
						invalidTarget = true;
						hasSkip = true;
						actionResults.push({ action: action.kind, status: "skipped_invalid_target", targetId: labelId });
						continue;
					}
					if (satisfiedLabels.has(labelId)) {
						actionResults.push({ action: action.kind, status: "already_satisfied", targetId: labelId });
						continue;
					}
					satisfiedLabels.add(labelId);
					applyLabels.push({ labelId, ruleId: rule.ruleId, ruleVersion: rule.version });
					actionResults.push({ action: action.kind, status: "applied", targetId: labelId });
					appliedCount += 1;
					ruleApplied = true;
				}
			} else if (action.kind === "star") {
				if (context.currentInboxScope.triggerIsStarred || star) {
					actionResults.push({ action: action.kind, status: "already_satisfied", targetId: null });
				} else {
					star = { ruleId: rule.ruleId, ruleVersion: rule.version };
					actionResults.push({ action: action.kind, status: "applied", targetId: null });
					appliedCount += 1;
					ruleApplied = true;
				}
			} else if (!availableFolders.has(action.folderId)) {
				invalidTarget = true;
				hasSkip = true;
				actionResults.push({ action: action.kind, status: "skipped_invalid_target", targetId: action.folderId });
			} else if (action.folderId === context.snapshot.folderId) {
				actionResults.push({ action: action.kind, status: "already_satisfied", targetId: action.folderId });
			} else if (!move) {
				move = { folderId: action.folderId, ruleId: rule.ruleId, ruleVersion: rule.version };
				actionResults.push({ action: action.kind, status: "applied", targetId: action.folderId });
				appliedCount += 1;
				ruleApplied = true;
			} else if (move.folderId === action.folderId) {
				actionResults.push({ action: action.kind, status: "already_satisfied", targetId: action.folderId });
			} else {
				ruleConflict = true;
				hasSkip = true;
				actionResults.push({ action: action.kind, status: "skipped_conflict", targetId: action.folderId });
			}
		}

		results.push({
			ordinal: rule.ordinal,
			ruleId: rule.ruleId,
			ruleName: rule.ruleName,
			ruleVersion: rule.version,
			outcome: ruleApplied
				? "applied"
				: ruleConflict
					? "skipped_conflict"
					: invalidTarget
						? "skipped_invalid_target"
						: "already_satisfied",
			matchedConditionIndexes: evaluation.matchedConditionIndexes,
			plannedActions: definition.actions.map(actionCode),
			actionResults,
			failureCategory: invalidTarget ? "target_unavailable" : null,
		});
		if (definition.stopProcessing) stoppedByRuleId = rule.ruleId;
	}

	return {
		state: matchedCount === 0
			? "no_match"
			: hasSkip
				? "applied_with_skips"
				: "applied",
		evaluatedCount: results.filter((result) => result.outcome !== "stopped").length,
		matchedCount,
		appliedCount,
		stoppedByRuleId,
		applyLabels,
		star,
		move,
		results,
	};
}

function definitionTargets(definition: AutomationRuleDefinition) {
	const labelIds = new Set<string>();
	const folderIds = new Set<string>();
	for (const action of definition.actions) {
		if (action.kind === "apply_labels") {
			for (const labelId of action.labelIds) labelIds.add(labelId);
		} else if (action.kind === "move_to_folder") {
			folderIds.add(action.folderId);
		}
	}
	return { labelIds: [...labelIds], folderIds: [...folderIds] };
}

function stateRow(sql: AutomationRulesSql): AutomationRulesState {
	const row = first<{
		rulesetGeneration: number;
		orderRevision: number;
		updatedAt: string;
	}>(sql,
		`SELECT ruleset_generation AS rulesetGeneration,
		        order_revision AS orderRevision, updated_at AS updatedAt
		 FROM automation_rule_state WHERE id = 1`,
	);
	if (!row) throw new AutomationRuleError("INVALID", "Automation Rule state is unavailable");
	return row;
}

function ruleRow(sql: AutomationRulesSql, ruleId: string): RuleRow {
	const row = first<RuleRow>(sql,
		`SELECT id, name, state, active_version AS activeVersion,
		        draft_version AS draftVersion, next_version AS nextVersion,
		        position, revision, created_by AS createdBy, created_at AS createdAt,
		        updated_by AS updatedBy, updated_at AS updatedAt,
		        archived_by AS archivedBy, archived_at AS archivedAt
		 FROM automation_rules WHERE id = ?`,
		ruleId,
	);
	if (!row) throw new AutomationRuleError("NOT_FOUND", "Automation Rule was not found");
	return row;
}

function assertRevision(rule: RuleRow, expectedRevision: number): void {
	if (!Number.isSafeInteger(expectedRevision) || rule.revision !== expectedRevision) {
		throw new AutomationRuleError("CONFLICT", "Automation Rule changed; refresh and try again");
	}
}

function insertVersion(
	sql: AutomationRulesSql,
	input: {
		ruleId: string;
		version: number;
		definition: AutomationRuleDefinition;
		fingerprint: string;
		actorId: string;
		now: string;
	},
): void {
	if (input.version > AUTOMATION_RUNTIME_LIMITS.maxVersionsPerRule) {
		throw new AutomationRuleError(
			"INVALID",
			"This Automation Rule has reached its retained version limit",
		);
	}
	const retainedVersions = Number(first<{ count: number }>(sql,
		"SELECT COUNT(*) AS count FROM automation_rule_versions",
	)?.count ?? 0);
	if (retainedVersions >= AUTOMATION_RUNTIME_LIMITS.maxRetainedVersions) {
		throw new AutomationRuleError(
			"INVALID",
			"This Mailbox has reached its retained Automation Rule version limit",
		);
	}
	const definitionJson = canonicalAutomationRuleDefinition(input.definition);
	const targets = definitionTargets(input.definition);
	for (const labelId of targets.labelIds) {
		if (!first<{ found: number }>(sql,
			"SELECT 1 AS found FROM labels WHERE id = ? LIMIT 1",
			labelId,
		)) {
			throw new AutomationRuleError(
				"INVALID",
				"An Automation Rule label target is no longer available",
			);
		}
	}
	for (const folderId of targets.folderIds) {
		const folder = first<{ id: string; isDeletable: number }>(sql,
			"SELECT id, is_deletable AS isDeletable FROM folders WHERE id = ? LIMIT 1",
			folderId,
		);
		if (
			!folder ||
			(folder.id !== "archive" && (folder.isDeletable !== 1 || folder.id.startsWith("_")))
		) {
			throw new AutomationRuleError(
				"INVALID",
				"Automation Rules may move mail only to Archive or a custom folder",
			);
		}
	}
	sql.exec(
		`INSERT INTO automation_rule_versions
		 (rule_id, version, schema_version, definition_json, definition_fingerprint, created_by, created_at)
		 VALUES (?, ?, 1, ?, ?, ?, ?)`,
		input.ruleId,
		input.version,
		definitionJson,
		input.fingerprint,
		input.actorId,
		input.now,
	);
	for (const labelId of targets.labelIds) {
		sql.exec(
			"INSERT INTO automation_rule_label_refs(rule_id, version, label_id) VALUES (?, ?, ?)",
			input.ruleId,
			input.version,
			labelId,
		);
	}
	for (const folderId of targets.folderIds) {
		sql.exec(
			"INSERT INTO automation_rule_folder_refs(rule_id, version, folder_id) VALUES (?, ?, ?)",
			input.ruleId,
			input.version,
			folderId,
		);
	}
}

function removeInactiveReferences(sql: AutomationRulesSql, ruleId: string): void {
	sql.exec(
		`DELETE FROM automation_rule_label_refs
		 WHERE rule_id = ? AND version NOT IN (
		   SELECT active_version FROM automation_rules WHERE id = ? AND active_version IS NOT NULL
		   UNION
		   SELECT draft_version FROM automation_rules WHERE id = ? AND draft_version IS NOT NULL
		 )`,
		ruleId,
		ruleId,
		ruleId,
	);
	sql.exec(
		`DELETE FROM automation_rule_folder_refs
		 WHERE rule_id = ? AND version NOT IN (
		   SELECT active_version FROM automation_rules WHERE id = ? AND active_version IS NOT NULL
		   UNION
		   SELECT draft_version FROM automation_rules WHERE id = ? AND draft_version IS NOT NULL
		 )`,
		ruleId,
		ruleId,
		ruleId,
	);
}

function isActionResultStatus(value: unknown): value is AutomationActionResult["status"] {
	return value === "applied" ||
		value === "already_satisfied" ||
		value === "skipped_conflict" ||
		value === "skipped_invalid_target";
}

function storedRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value))
		: null;
}

function storedStringArray(value: unknown): string[] | null {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? value
		: null;
}

function storedIntegerArray(value: unknown): number[] | null {
	return Array.isArray(value) && value.every(
		(entry) => Number.isSafeInteger(entry) && Number(entry) >= 0,
	)
		? value.map(Number)
		: null;
}

function parseStoredDryRunResult(value: unknown): AutomationDryRunRecord["result"] {
	const record = storedRecord(value);
	if (
		!record ||
		!Number.isSafeInteger(record.wouldChange) || Number(record.wouldChange) < 0 ||
		!Number.isSafeInteger(record.alreadySatisfied) || Number(record.alreadySatisfied) < 0 ||
		!Number.isSafeInteger(record.conflicts) || Number(record.conflicts) < 0 ||
		!Array.isArray(record.samples) ||
		record.samples.length > AUTOMATION_RULE_LIMITS.dryRunSamples
	) throw new AutomationRuleError("INVALID", "Stored Automation Rule test is invalid");
	const samples = record.samples.map((value) => {
		const sample = storedRecord(value);
		const matchedConditionIndexes = storedIntegerArray(sample?.matchedConditionIndexes);
		const plannedActions = storedStringArray(sample?.plannedActions);
		const noOpActions = storedStringArray(sample?.noOpActions);
		const conflicts = storedStringArray(sample?.conflicts);
		if (
			!sample ||
			typeof sample.messageId !== "string" ||
			typeof sample.conversationId !== "string" ||
			typeof sample.sender !== "string" ||
			typeof sample.subject !== "string" ||
			typeof sample.date !== "string" ||
			!matchedConditionIndexes ||
			!plannedActions ||
			!noOpActions ||
			!conflicts
		) throw new AutomationRuleError("INVALID", "Stored Automation Rule test sample is invalid");
		return {
			messageId: sample.messageId,
			conversationId: sample.conversationId,
			sender: sample.sender,
			subject: sample.subject,
			date: sample.date,
			matchedConditionIndexes,
			plannedActions,
			noOpActions,
			conflicts,
		};
	});
	return {
		wouldChange: Number(record.wouldChange),
		alreadySatisfied: Number(record.alreadySatisfied),
		conflicts: Number(record.conflicts),
		samples,
	};
}

function automationTestFromRow(row: AutomationTestRow): AutomationDryRunRecord {
	let rawResult: unknown;
	try {
		rawResult = JSON.parse(row.resultJson);
	} catch {
		throw new AutomationRuleError("INVALID", "Stored Automation Rule test is invalid");
	}
	return {
		id: row.id,
		actorId: row.actorId,
		ruleId: row.ruleId,
		ruleVersion: row.ruleVersion,
		definitionFingerprint: row.definitionFingerprint,
		evaluatedCount: row.evaluatedCount,
		matchedCount: row.matchedCount,
		acknowledgedZero: row.acknowledgedZero === 1,
		result: parseStoredDryRunResult(rawResult),
		createdAt: row.createdAt,
		expiresAt: row.expiresAt,
	};
}

export function createAutomationRulesModule(input: {
	storage: AutomationRulesStorage;
	now?: () => number;
	createId?: (prefix: "rule" | "test") => string;
	createToken?: () => string;
}) {
	const { storage } = input;
	const now = input.now ?? Date.now;
	const createId = input.createId ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
	const createToken = input.createToken ?? (() => crypto.randomUUID());

	function listRules(includeArchived = false): AutomationRuleRecord[] {
		return [...storage.sql.exec<RuleRow>(
			`SELECT id, name, state, active_version AS activeVersion,
			        draft_version AS draftVersion, next_version AS nextVersion,
			        position, revision, created_by AS createdBy, created_at AS createdAt,
			        updated_by AS updatedBy, updated_at AS updatedAt,
			        archived_by AS archivedBy, archived_at AS archivedAt
			 FROM automation_rules
			 WHERE (? = 1 OR state <> 'archived')
			 ORDER BY position ASC, id ASC`,
			includeArchived ? 1 : 0,
		)].map(ruleFromRow);
	}

	function ruleWrite<T>(run: () => T): T {
		try {
			return storage.transactionSync(run);
		} catch (error) {
			if (error instanceof AutomationRuleError) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("FOREIGN KEY constraint failed")) {
				throw new AutomationRuleError(
					"INVALID",
					"An Automation Rule label or folder target is no longer available",
				);
			}
			if (message.includes("UNIQUE constraint failed")) {
				throw new AutomationRuleError(
					"CONFLICT",
					"An Automation Rule with this name already exists",
				);
			}
			throw error;
		}
	}

	function listVersions(ruleId: string): AutomationRuleVersionRecord[] {
		ruleRow(storage.sql, ruleId);
		return [...storage.sql.exec<VersionRow>(
			`SELECT rule_id AS ruleId, version, definition_json AS definitionJson,
			        definition_fingerprint AS definitionFingerprint,
			        created_by AS createdBy, created_at AS createdAt
			 FROM automation_rule_versions WHERE rule_id = ? ORDER BY version DESC`,
			ruleId,
		)].map(versionFromRow);
	}

	function getRule(ruleId: string): AutomationRuleRecord {
		return ruleFromRow(ruleRow(storage.sql, ruleId));
	}

	function listRuns(limit = 50): AutomationRunRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new AutomationRuleError("INVALID", "Automation Run history limit is invalid");
		}
		return [...storage.sql.exec<AutomationRunRecord>(
			`SELECT id, trigger_message_id AS triggerMessageId,
			        ruleset_generation AS rulesetGeneration, state,
			        attempt_count AS attemptCount, started_at AS startedAt,
			        completed_at AS completedAt, evaluated_count AS evaluatedCount,
			        matched_count AS matchedCount, applied_count AS appliedCount,
			        stopped_by_rule_id AS stoppedByRuleId,
			        failure_category AS failureCategory,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM automation_runs
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			limit,
		)];
	}

	function getRun(runId: string): AutomationRunRecord {
		const run = first<AutomationRunRecord>(storage.sql,
			`SELECT id, trigger_message_id AS triggerMessageId,
			        ruleset_generation AS rulesetGeneration, state,
			        attempt_count AS attemptCount, started_at AS startedAt,
			        completed_at AS completedAt, evaluated_count AS evaluatedCount,
			        matched_count AS matchedCount, applied_count AS appliedCount,
			        stopped_by_rule_id AS stoppedByRuleId,
			        failure_category AS failureCategory,
			        created_at AS createdAt, updated_at AS updatedAt
			 FROM automation_runs WHERE id = ?`,
			runId,
		);
		if (!run) throw new AutomationRuleError("NOT_FOUND", "Automation Run was not found");
		return run;
	}

	function parseStoredArray(value: string, label: string): unknown[] {
		try {
			const parsed: unknown = JSON.parse(value);
			if (Array.isArray(parsed)) return parsed;
		} catch {
			// The stable error below keeps corrupt history from leaking partial data.
		}
		throw new AutomationRuleError("INVALID", `Stored ${label} is invalid`);
	}

	function listRunResults(runId: string): AutomationRunResultRecord[] {
		getRun(runId);
		const rows = [...storage.sql.exec<{
			ordinal: number;
			ruleId: string;
			ruleName: string;
			ruleVersion: number;
			outcome: AutomationRunResultOutcome;
			matchedConditionIndexesJson: string;
			plannedActionsJson: string;
			actionResultsJson: string;
			failureCategory: string | null;
			attemptCount: number;
			createdAt: string;
		}>(
			`SELECT ordinal, rule_id AS ruleId, rule_name AS ruleName,
			        rule_version AS ruleVersion, outcome,
			        matched_condition_indexes_json AS matchedConditionIndexesJson,
			        planned_actions_json AS plannedActionsJson,
			        action_results_json AS actionResultsJson,
			        failure_category AS failureCategory,
			        attempt_count AS attemptCount, created_at AS createdAt
			 FROM automation_run_results WHERE run_id = ? ORDER BY ordinal ASC`,
			runId,
		)];
		return rows.map((row) => {
			const matched = parseStoredArray(row.matchedConditionIndexesJson, "condition result");
			const planned = parseStoredArray(row.plannedActionsJson, "planned action result");
			const actions = parseStoredArray(row.actionResultsJson, "action result");
			if (
				!matched.every((value) => Number.isSafeInteger(value) && Number(value) >= 0) ||
				!planned.every((value) => typeof value === "string") ||
				!actions.every((value) => value && typeof value === "object" && !Array.isArray(value))
			) throw new AutomationRuleError("INVALID", "Stored Automation Run result is invalid");
			return {
				ordinal: row.ordinal,
				ruleId: row.ruleId,
				ruleName: row.ruleName,
				ruleVersion: row.ruleVersion,
				outcome: row.outcome,
				matchedConditionIndexes: matched.map(Number),
				plannedActions: planned.map(String),
				actionResults: actions.map((value) => {
					const record = storedRecord(value);
					if (
						!record ||
						typeof record.action !== "string" ||
						!isActionResultStatus(record.status) ||
						(record.targetId !== null && typeof record.targetId !== "string")
					) throw new AutomationRuleError("INVALID", "Stored Automation action result is invalid");
					return {
						action: record.action,
						status: record.status,
						targetId: record.targetId,
					};
				}),
				failureCategory: row.failureCategory,
				attemptCount: row.attemptCount,
				createdAt: row.createdAt,
			};
		});
	}

	function listTests(ruleId: string | null, limit = 50): AutomationDryRunRecord[] {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new AutomationRuleError("INVALID", "Automation Rule test history limit is invalid");
		}
		const rows = [...storage.sql.exec<AutomationTestRow>(
			`SELECT id, actor_id AS actorId, rule_id AS ruleId, rule_version AS ruleVersion,
			        definition_fingerprint AS definitionFingerprint,
			        evaluated_count AS evaluatedCount, matched_count AS matchedCount,
			        acknowledged_zero AS acknowledgedZero, result_json AS resultJson,
			        created_at AS createdAt, expires_at AS expiresAt
			 FROM automation_rule_tests
			 WHERE (? IS NULL OR rule_id = ?)
			 ORDER BY created_at DESC, id DESC LIMIT ?`,
			ruleId,
			ruleId,
			limit,
		)];
		return rows.map(automationTestFromRow);
	}

	function getTest(testId: string): AutomationDryRunRecord {
		const row = automationTestRow(testId);
		if (!row) throw new AutomationRuleError("NOT_FOUND", "Automation Rule test was not found");
		return automationTestFromRow(row);
	}

	function automationTestRow(testId: string): AutomationTestRow | null {
		return first<AutomationTestRow>(storage.sql,
			`SELECT id, actor_id AS actorId, rule_id AS ruleId, rule_version AS ruleVersion,
			        definition_fingerprint AS definitionFingerprint,
			        evaluated_count AS evaluatedCount, matched_count AS matchedCount,
			        acknowledged_zero AS acknowledgedZero, result_json AS resultJson,
			        created_at AS createdAt, expires_at AS expiresAt
			 FROM automation_rule_tests WHERE id = ?`,
			testId,
		);
	}

	async function createDraft(command: {
		definition: unknown;
		actorId: string;
		expectedOrderRevision: number;
	}): Promise<AutomationRuleRecord> {
		const definition = parseAutomationRuleDefinition(command.definition);
		const fingerprint = await fingerprintAutomationRuleDefinition(definition);
		const timestamp = canonicalIso(now());
		const ruleId = createId("rule");
		return ruleWrite(() => {
			const state = stateRow(storage.sql);
			if (state.orderRevision !== command.expectedOrderRevision) {
				throw new AutomationRuleError("CONFLICT", "Automation Rule order changed; refresh and try again");
			}
			const retainedCount = Number(first<{ count: number }>(storage.sql,
				"SELECT COUNT(*) AS count FROM automation_rules",
			)?.count ?? 0);
			if (retainedCount >= AUTOMATION_RUNTIME_LIMITS.maxRetainedRules) {
				throw new AutomationRuleError(
					"INVALID",
					"This Mailbox has reached its retained Automation Rule limit",
				);
			}
			const count = Number(first<{ count: number }>(storage.sql,
				"SELECT COUNT(*) AS count FROM automation_rules WHERE state <> 'archived'",
			)?.count ?? 0);
			if (count >= AUTOMATION_RUNTIME_LIMITS.maxRules) {
				throw new AutomationRuleError("INVALID", "This Mailbox has reached its Automation Rule limit");
			}
			const position = Number(first<{ position: number }>(storage.sql,
				"SELECT COALESCE(MAX(position), -1) + 1 AS position FROM automation_rules WHERE state <> 'archived'",
			)?.position ?? 0);
			storage.sql.exec(
				`INSERT INTO automation_rules
				 (id, name, normalized_name, state, active_version, draft_version, next_version,
				  position, revision, created_by, created_at, updated_by, updated_at)
				 VALUES (?, ?, ?, 'draft', NULL, 1, 2, ?, 1, ?, ?, ?, ?)`,
				ruleId,
				definition.name,
				normalizedName(definition.name),
				position,
				command.actorId,
				timestamp,
				command.actorId,
				timestamp,
			);
			insertVersion(storage.sql, {
				ruleId,
				version: 1,
				definition,
				fingerprint,
				actorId: command.actorId,
				now: timestamp,
			});
			storage.sql.exec(
				"UPDATE automation_rule_state SET order_revision = order_revision + 1, updated_at = ? WHERE id = 1",
				timestamp,
			);
			return ruleFromRow(ruleRow(storage.sql, ruleId));
		});
	}

	async function updateDraft(command: {
		ruleId: string;
		definition: unknown;
		actorId: string;
		expectedRevision: number;
	}): Promise<AutomationRuleRecord> {
		const definition = parseAutomationRuleDefinition(command.definition);
		const fingerprint = await fingerprintAutomationRuleDefinition(definition);
		const timestamp = canonicalIso(now());
		return ruleWrite(() => {
			const current = ruleRow(storage.sql, command.ruleId);
			assertRevision(current, command.expectedRevision);
			if (current.state === "archived") {
				throw new AutomationRuleError("CONFLICT", "Archived Automation Rules cannot be edited");
			}
			const version = current.nextVersion;
			insertVersion(storage.sql, {
				ruleId: current.id,
				version,
				definition,
				fingerprint,
				actorId: command.actorId,
				now: timestamp,
			});
			storage.sql.exec(
				`UPDATE automation_rules
				 SET name = ?, normalized_name = ?, draft_version = ?, next_version = ?,
				     state = CASE WHEN active_version IS NULL THEN 'draft' ELSE state END,
				     revision = revision + 1, updated_by = ?, updated_at = ?
				 WHERE id = ? AND revision = ?`,
				definition.name,
				normalizedName(definition.name),
				version,
				version + 1,
				command.actorId,
				timestamp,
				current.id,
				command.expectedRevision,
			);
			removeInactiveReferences(storage.sql, current.id);
			return ruleFromRow(ruleRow(storage.sql, current.id));
		});
	}

	function latestPassingTest(ruleId: string, fingerprint: string, timestamp: string) {
		return first<{ evaluatedCount: number; matchedCount: number; acknowledgedZero: number }>(
			storage.sql,
			`SELECT evaluated_count AS evaluatedCount, matched_count AS matchedCount,
			        acknowledged_zero AS acknowledgedZero
			 FROM automation_rule_tests
			 WHERE rule_id = ? AND definition_fingerprint = ? AND expires_at > ?
			 ORDER BY created_at DESC, id DESC LIMIT 1`,
			ruleId,
			fingerprint,
			timestamp,
		);
	}

	function enable(command: {
		ruleId: string;
		actorId: string;
		expectedRevision: number;
	}): AutomationRuleRecord {
		const timestampMs = now();
		const timestamp = canonicalIso(timestampMs);
		return storage.transactionSync(() => {
			const current = ruleRow(storage.sql, command.ruleId);
			assertRevision(current, command.expectedRevision);
			if (current.state === "archived" || current.draftVersion === null) {
				throw new AutomationRuleError("CONFLICT", "Automation Rule has no draft to activate");
			}
			const version = first<VersionRow>(storage.sql,
				`SELECT rule_id AS ruleId, version, definition_json AS definitionJson,
				        definition_fingerprint AS definitionFingerprint,
				        created_by AS createdBy, created_at AS createdAt
				 FROM automation_rule_versions WHERE rule_id = ? AND version = ?`,
				current.id,
				current.draftVersion,
			);
			if (!version) throw new AutomationRuleError("INVALID", "Automation Rule draft is unavailable");
			const test = latestPassingTest(
				current.id,
				version.definitionFingerprint,
				timestamp,
			);
			if (
				!test ||
				((test.evaluatedCount === 0 || test.matchedCount === 0) &&
					test.acknowledgedZero !== 1)
			) {
				throw new AutomationRuleError(
					"ACTIVATION_TEST_REQUIRED",
					"Test this Automation Rule before enabling it",
				);
			}
			const enabledCount = Number(first<{ count: number }>(storage.sql,
				"SELECT COUNT(*) AS count FROM automation_rules WHERE state = 'enabled' AND id <> ?",
				current.id,
			)?.count ?? 0);
			if (enabledCount >= AUTOMATION_RUNTIME_LIMITS.maxEnabledRules) {
				throw new AutomationRuleError("INVALID", "This Mailbox has reached its enabled Automation Rule limit");
			}
			storage.sql.exec(
				`UPDATE automation_rules
				 SET state = 'enabled', active_version = draft_version, draft_version = NULL,
				     revision = revision + 1, updated_by = ?, updated_at = ?
				 WHERE id = ? AND revision = ?`,
				command.actorId,
				timestamp,
				current.id,
				command.expectedRevision,
			);
			removeInactiveReferences(storage.sql, current.id);
			storage.sql.exec(
				`UPDATE automation_rule_state
				 SET ruleset_generation = ruleset_generation + 1, updated_at = ? WHERE id = 1`,
				timestamp,
			);
			return ruleFromRow(ruleRow(storage.sql, current.id));
		});
	}

	function setEnabled(command: {
		ruleId: string;
		enabled: boolean;
		actorId: string;
		expectedRevision: number;
	}): AutomationRuleRecord {
		const timestamp = canonicalIso(now());
		return storage.transactionSync(() => {
			const current = ruleRow(storage.sql, command.ruleId);
			assertRevision(current, command.expectedRevision);
			if (current.state === "archived" || current.activeVersion === null) {
				throw new AutomationRuleError("CONFLICT", "Automation Rule has no active version");
			}
			if (command.enabled && current.state === "enabled") return current;
			if (!command.enabled && current.state === "disabled") return current;
			storage.sql.exec(
				`UPDATE automation_rules SET state = ?, revision = revision + 1,
				 updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?`,
				command.enabled ? "enabled" : "disabled",
				command.actorId,
				timestamp,
				current.id,
				command.expectedRevision,
			);
			storage.sql.exec(
				"UPDATE automation_rule_state SET ruleset_generation = ruleset_generation + 1, updated_at = ? WHERE id = 1",
				timestamp,
			);
			return ruleFromRow(ruleRow(storage.sql, current.id));
		});
	}

	function archive(command: {
		ruleId: string;
		actorId: string;
		expectedRevision: number;
	}): AutomationRuleRecord {
		const timestamp = canonicalIso(now());
		return storage.transactionSync(() => {
			const current = ruleRow(storage.sql, command.ruleId);
			assertRevision(current, command.expectedRevision);
			if (current.state === "archived") return current;
			storage.sql.exec(
				`UPDATE automation_rules
				 SET state = 'archived', revision = revision + 1, updated_by = ?, updated_at = ?,
				     archived_by = ?, archived_at = ?
				 WHERE id = ? AND revision = ?`,
				command.actorId,
				timestamp,
				command.actorId,
				timestamp,
				current.id,
				command.expectedRevision,
			);
			storage.sql.exec("DELETE FROM automation_rule_label_refs WHERE rule_id = ?", current.id);
			storage.sql.exec("DELETE FROM automation_rule_folder_refs WHERE rule_id = ?", current.id);
			storage.sql.exec(
				`UPDATE automation_rule_state SET ruleset_generation = ruleset_generation + 1,
				 order_revision = order_revision + 1, updated_at = ? WHERE id = 1`,
				timestamp,
			);
			return ruleFromRow(ruleRow(storage.sql, current.id));
		});
	}

	async function restoreVersion(command: {
		ruleId: string;
		version: number;
		actorId: string;
		expectedRevision: number;
	}): Promise<AutomationRuleRecord> {
		const source = listVersions(command.ruleId).find((version) => version.version === command.version);
		if (!source) throw new AutomationRuleError("NOT_FOUND", "Automation Rule version was not found");
		return updateDraft({
			ruleId: command.ruleId,
			definition: source.definition,
			actorId: command.actorId,
			expectedRevision: command.expectedRevision,
		});
	}

	function reorder(command: {
		orderedRuleIds: string[];
		expectedOrderRevision: number;
		actorId: string;
	}): AutomationRulesState {
		if (new Set(command.orderedRuleIds).size !== command.orderedRuleIds.length) {
			throw new AutomationRuleError("INVALID", "Automation Rule order is invalid");
		}
		const timestamp = canonicalIso(now());
		return storage.transactionSync(() => {
			const state = stateRow(storage.sql);
			if (state.orderRevision !== command.expectedOrderRevision) {
				throw new AutomationRuleError("CONFLICT", "Automation Rule order changed; refresh and try again");
			}
			const currentIds = listRules(false).map((rule) => rule.id);
			if (currentIds.length !== command.orderedRuleIds.length ||
				currentIds.some((id) => !command.orderedRuleIds.includes(id))) {
				throw new AutomationRuleError("CONFLICT", "Automation Rule list changed; refresh and try again");
			}
			for (const [position, ruleId] of command.orderedRuleIds.entries()) {
				storage.sql.exec(
					`UPDATE automation_rules SET position = ?, revision = revision + 1,
					 updated_by = ?, updated_at = ? WHERE id = ? AND state <> 'archived'`,
					position,
					command.actorId,
					timestamp,
					ruleId,
				);
			}
			storage.sql.exec(
				`UPDATE automation_rule_state SET ruleset_generation = ruleset_generation + 1,
				 order_revision = order_revision + 1, updated_at = ? WHERE id = 1`,
				timestamp,
			);
			return stateRow(storage.sql);
		});
	}

	function captureLiveInbound(messageId: string, acceptedAt: string) {
		const acceptedAtMs = Date.parse(acceptedAt);
		if (
			!messageId ||
			messageId.length > 300 ||
			!Number.isFinite(acceptedAtMs) ||
			new Date(acceptedAtMs).toISOString() !== acceptedAt
		) throw new AutomationRuleError("INVALID", "Automation Run trigger is invalid");
		const existing = first<{
			id: string;
			state: AutomationRunState;
			failureCategory: string | null;
		}>(storage.sql,
			`SELECT id, state, failure_category AS failureCategory
			 FROM automation_runs WHERE trigger_message_id = ?`,
			messageId,
		);
		if (existing) {
			return {
				runId: existing.id,
				state: existing.state,
				replayed: true,
				captureFailed: existing.failureCategory === "capture_failed",
				error: undefined,
			};
		}
		const state = stateRow(storage.sql);
		const runId = `automation:${messageId}`;
		// Reserve provenance before reading or copying any rule definition. If that
		// snapshot fails, the reservation remains and is terminalized below.
		storage.sql.exec(
			`INSERT INTO automation_runs
			 (id, trigger_kind, trigger_message_id, ruleset_generation, state, attempt_count,
			  next_attempt_at, completed_at, failure_category, created_at, updated_at)
			 VALUES (?, 'live_inbound', ?, ?, 'pending', 0, NULL, NULL,
			         'capture_in_progress', ?, ?)`,
			runId,
			messageId,
			state.rulesetGeneration,
			acceptedAt,
			acceptedAt,
		);
		const rules = [...storage.sql.exec<VersionRow & { id: string; name: string; position: number }>(
			`SELECT r.id, r.name, r.position, v.rule_id AS ruleId, v.version,
			        v.definition_json AS definitionJson,
			        v.definition_fingerprint AS definitionFingerprint,
			        v.created_by AS createdBy, v.created_at AS createdAt
			 FROM automation_rules r
			 JOIN automation_rule_versions v
			   ON v.rule_id = r.id AND v.version = r.active_version
			 WHERE r.state = 'enabled'
			 ORDER BY r.position ASC, r.id ASC
			 LIMIT ?`,
			AUTOMATION_RUNTIME_LIMITS.maxEnabledRules,
		)];
		let validatedRules: Array<
			VersionRow & { id: string; name: string; position: number; activeName: string }
		>;
		try {
			// Validate every immutable definition before copying any snapshot rows.
			// Semantic corruption becomes a durable failed run; storage failures still
			// escape so the outer Message transaction can roll back and retry safely.
			validatedRules = rules.map((rule) => {
				const definition = parseAutomationRuleDefinition(JSON.parse(rule.definitionJson));
				if (!/^[a-f0-9]{64}$/u.test(rule.definitionFingerprint)) {
					throw new AutomationRuleError("INVALID", "Stored Automation Rule fingerprint is invalid");
				}
				return { ...rule, activeName: definition.name };
			});
		} catch (error) {
			storage.sql.exec(
				`UPDATE automation_runs SET state = 'failed', next_attempt_at = NULL,
				 completed_at = ?, failure_category = 'capture_failed', updated_at = ?
				 WHERE id = ?`,
				acceptedAt,
				acceptedAt,
				runId,
			);
			pruneHistory(acceptedAtMs);
			return {
				runId,
				state: "failed" as const,
				replayed: false,
				captureFailed: true,
				error: error instanceof Error ? error.message : String(error),
			};
		}
		for (const [ordinal, rule] of validatedRules.entries()) {
			storage.sql.exec(
				`INSERT INTO automation_run_rules
				 (run_id, ordinal, rule_id, rule_name, rule_version, definition_json, definition_fingerprint)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				runId,
				ordinal,
				rule.id,
				rule.activeName,
				rule.version,
				rule.definitionJson,
				rule.definitionFingerprint,
			);
			storage.sql.exec(
				`INSERT OR IGNORE INTO automation_run_label_refs(run_id, label_id)
				 SELECT ?, label_id FROM automation_rule_label_refs
				 WHERE rule_id = ? AND version = ?`,
				runId,
				rule.id,
				rule.version,
			);
			storage.sql.exec(
				`INSERT OR IGNORE INTO automation_run_folder_refs(run_id, folder_id)
				 SELECT ?, folder_id FROM automation_rule_folder_refs
				 WHERE rule_id = ? AND version = ?`,
				runId,
				rule.id,
				rule.version,
			);
		}
		const runState: AutomationRunState = validatedRules.length === 0 ? "no_match" : "pending";
		storage.sql.exec(
			`UPDATE automation_runs SET state = ?, next_attempt_at = ?, completed_at = ?,
			 failure_category = NULL, updated_at = ? WHERE id = ?`,
			runState,
			validatedRules.length === 0 ? null : acceptedAt,
			validatedRules.length === 0 ? acceptedAt : null,
			acceptedAt,
			runId,
		);
		if (runState === "no_match") pruneHistory(acceptedAtMs);
		return { runId, state: runState, replayed: false, captureFailed: false, error: undefined };
	}

	function claimNextRun(): AutomationRunClaim | null {
		const timestampMs = now();
		const timestamp = canonicalIso(timestampMs);
		return storage.transactionSync(() => {
			storage.sql.exec(
				`UPDATE automation_runs SET state = 'failed', completed_at = ?, updated_at = ?,
				 lease_token = NULL, lease_expires_at = NULL, failure_category = 'attempts_exhausted'
				 WHERE state = 'processing' AND lease_expires_at <= ? AND attempt_count >= ?`,
				timestamp,
				timestamp,
				timestamp,
				AUTOMATION_RUNTIME_LIMITS.maxAttempts,
			);
			storage.sql.exec(
				`DELETE FROM automation_run_label_refs
				 WHERE run_id IN (SELECT id FROM automation_runs WHERE state = 'failed')`,
			);
			storage.sql.exec(
				`DELETE FROM automation_run_folder_refs
				 WHERE run_id IN (SELECT id FROM automation_runs WHERE state = 'failed')`,
			);
			storage.sql.exec(
				`UPDATE automation_runs SET state = 'pending', next_attempt_at = ?, updated_at = ?,
				 lease_token = NULL, lease_expires_at = NULL
				 WHERE state = 'processing' AND lease_expires_at <= ? AND attempt_count < ?`,
				timestamp,
				timestamp,
				timestamp,
				AUTOMATION_RUNTIME_LIMITS.maxAttempts,
			);
			for (let skippedCorrupt = 0; skippedCorrupt < AUTOMATION_RUNTIME_LIMITS.maxEnabledRules; skippedCorrupt += 1) {
				const due = first<ClaimedRunRow>(storage.sql,
					`SELECT id, trigger_message_id AS triggerMessageId,
					        ruleset_generation AS rulesetGeneration, attempt_count AS attemptCount
					 FROM automation_runs
					 WHERE state = 'pending' AND next_attempt_at <= ?
					 ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
					timestamp,
				);
				if (!due) return null;
				const token = createToken();
				const leaseExpiresAt = canonicalIso(timestampMs + AUTOMATION_RUNTIME_LIMITS.leaseMs);
				storage.sql.exec(
					`UPDATE automation_runs SET state = 'processing', attempt_count = attempt_count + 1,
					 lease_token = ?, lease_expires_at = ?, started_at = COALESCE(started_at, ?), updated_at = ?
					 WHERE id = ? AND state = 'pending'`,
					token,
					leaseExpiresAt,
					timestamp,
					timestamp,
					due.id,
				);
				const captured = [...storage.sql.exec<{
					ordinal: number;
					ruleId: string;
					ruleName: string;
					version: number;
					definitionJson: string;
					definitionFingerprint: string;
				}>(
					`SELECT ordinal, rule_id AS ruleId, rule_name AS ruleName,
					        rule_version AS version, definition_json AS definitionJson,
					        definition_fingerprint AS definitionFingerprint
					 FROM automation_run_rules WHERE run_id = ? ORDER BY ordinal ASC`,
					due.id,
				)];
				let rules: AutomationRuleVersionSnapshot[];
				try {
					rules = captured.map((rule) => ({
						ordinal: rule.ordinal,
						ruleId: rule.ruleId,
						ruleName: rule.ruleName,
						version: rule.version,
						definition: parseAutomationRuleDefinition(JSON.parse(rule.definitionJson)),
						definitionFingerprint: rule.definitionFingerprint,
					}));
				} catch {
					storage.sql.exec(
						`UPDATE automation_runs SET state = 'failed', completed_at = ?, updated_at = ?,
						 lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
						 failure_category = 'invalid_captured_definition'
						 WHERE id = ? AND state = 'processing' AND lease_token = ?`,
						timestamp,
						timestamp,
						due.id,
						token,
					);
					storage.sql.exec("DELETE FROM automation_run_label_refs WHERE run_id = ?", due.id);
					storage.sql.exec("DELETE FROM automation_run_folder_refs WHERE run_id = ?", due.id);
					continue;
				}
				return {
					id: due.id,
					triggerMessageId: due.triggerMessageId,
					rulesetGeneration: due.rulesetGeneration,
					attemptCount: due.attemptCount + 1,
					leaseToken: token,
					leaseExpiresAt,
					rules,
				};
			}
			return null;
		});
	}

	function finalizeClaim(
		claim: AutomationRunClaim,
		plan: AutomationActionPlan,
		applyActions: (plan: AutomationActionPlan) => void,
	): boolean {
		const timestampMs = now();
		const timestamp = canonicalIso(timestampMs);
		return storage.transactionSync(() => {
			const owned = first<{ found: number }>(storage.sql,
				`SELECT 1 AS found FROM automation_runs
				 WHERE id = ? AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
				claim.id,
				claim.leaseToken,
				timestamp,
			);
			if (!owned) return false;
			applyActions(plan);
			for (const result of plan.results) {
				storage.sql.exec(
					`INSERT INTO automation_run_results
					 (run_id, ordinal, rule_id, rule_name, rule_version, outcome,
					  matched_condition_indexes_json, planned_actions_json, action_results_json,
					  failure_category, attempt_count, created_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					claim.id,
					result.ordinal,
					result.ruleId,
					result.ruleName,
					result.ruleVersion,
					result.outcome,
					JSON.stringify(result.matchedConditionIndexes),
					JSON.stringify(result.plannedActions),
					JSON.stringify(result.actionResults),
					result.failureCategory,
					claim.attemptCount,
					timestamp,
				);
			}
			storage.sql.exec(
				`UPDATE automation_runs SET state = ?, evaluated_count = ?, matched_count = ?,
				 applied_count = ?, stopped_by_rule_id = ?, completed_at = ?, updated_at = ?,
				 lease_token = NULL, lease_expires_at = NULL, next_attempt_at = NULL,
				 failure_category = ?
				 WHERE id = ? AND state = 'processing' AND lease_token = ?`,
				plan.state,
				plan.evaluatedCount,
				plan.matchedCount,
				plan.appliedCount,
				plan.stoppedByRuleId,
				timestamp,
				timestamp,
				plan.state === "failed" ? "scope_or_definition_invalid" : null,
				claim.id,
				claim.leaseToken,
			);
			storage.sql.exec("DELETE FROM automation_run_label_refs WHERE run_id = ?", claim.id);
			storage.sql.exec("DELETE FROM automation_run_folder_refs WHERE run_id = ?", claim.id);
			pruneHistory(timestampMs);
			return true;
		});
	}

	function failClaim(
		claim: AutomationRunClaim,
		category: string,
		transient: boolean,
	): boolean {
		const timestampMs = now();
		const timestamp = canonicalIso(timestampMs);
		return storage.transactionSync(() => {
			const owned = first<{ found: number }>(storage.sql,
				`SELECT 1 AS found FROM automation_runs
				 WHERE id = ? AND state = 'processing' AND lease_token = ? AND lease_expires_at > ?`,
				claim.id,
				claim.leaseToken,
				timestamp,
			);
			if (!owned) return false;
			const canRetry = transient && claim.attemptCount < AUTOMATION_RUNTIME_LIMITS.maxAttempts;
			const retryDelay = AUTOMATION_RUNTIME_LIMITS.retryMs[
				Math.min(Math.max(claim.attemptCount - 1, 0), AUTOMATION_RUNTIME_LIMITS.retryMs.length - 1)
			]!;
			storage.sql.exec(
				`UPDATE automation_runs SET state = ?, next_attempt_at = ?, completed_at = ?,
				 updated_at = ?, lease_token = NULL, lease_expires_at = NULL, failure_category = ?
				 WHERE id = ? AND state = 'processing' AND lease_token = ?`,
				canRetry ? "pending" : "failed",
				canRetry ? canonicalIso(timestampMs + retryDelay) : null,
				canRetry ? null : timestamp,
				timestamp,
				category,
				claim.id,
				claim.leaseToken,
			);
			if (!canRetry) {
				storage.sql.exec("DELETE FROM automation_run_label_refs WHERE run_id = ?", claim.id);
				storage.sql.exec("DELETE FROM automation_run_folder_refs WHERE run_id = ?", claim.id);
			}
			return true;
		});
	}

	type DryRunIdentity = {
		testId: string;
		definition: unknown;
		actorId: string;
		ruleId?: string;
		ruleVersion?: number;
		acknowledgedZero: boolean;
	};
	type PreparedDryRun = {
		definition: AutomationRuleDefinition;
		fingerprint: string;
	};

	async function prepareDryRun(definitionInput: unknown): Promise<PreparedDryRun> {
		const definition = parseAutomationRuleDefinition(definitionInput);
		return {
			definition,
			fingerprint: await fingerprintAutomationRuleDefinition(definition),
		};
	}

	function assertDryRunIdentity(
		row: AutomationTestRow,
		command: Pick<
			DryRunIdentity,
			"actorId" | "ruleId" | "ruleVersion" | "acknowledgedZero"
		>,
		definitionFingerprint: string,
	): AutomationDryRunRecord {
		if (
			row.actorId !== command.actorId ||
			row.ruleId !== (command.ruleId ?? null) ||
			row.ruleVersion !== (command.ruleVersion ?? null) ||
			row.definitionFingerprint !== definitionFingerprint ||
			(row.acknowledgedZero === 1) !== command.acknowledgedZero
		) {
			throw new AutomationRuleError(
				"DRY_RUN_IDEMPOTENCY_CONFLICT",
				"This Automation test retry no longer matches the original test",
			);
		}
		return automationTestFromRow(row);
	}

	function deleteExactExpiredDryRun(testId: string, timestampMs: number): void {
		storage.sql.exec(
			"DELETE FROM automation_rule_tests WHERE id = ? AND expires_at <= ?",
			testId,
			canonicalIso(timestampMs),
		);
	}

	function replayPreparedDryRun(
		command: DryRunIdentity,
		prepared: PreparedDryRun,
	): (AutomationDryRunRecord & { replayed: true }) | null {
		return storage.transactionSync(() => {
			deleteExactExpiredDryRun(command.testId, now());
			const row = automationTestRow(command.testId);
			return row
				? {
					...assertDryRunIdentity(row, command, prepared.fingerprint),
					replayed: true as const,
				}
				: null;
		});
	}

	async function replayDryRun(
		command: DryRunIdentity,
	): Promise<(AutomationDryRunRecord & { replayed: true }) | null> {
		return replayPreparedDryRun(command, await prepareDryRun(command.definition));
	}

	type DryRunCommand = {
		testId?: string;
		definition: unknown;
		contexts: AutomationPlanningContext[];
		orderedRules: AutomationRuleVersionSnapshot[];
		proposedOrdinal: number;
		actorId: string;
		ruleId?: string;
		ruleVersion?: number;
		acknowledgedZero: boolean;
	};

	function dryRunPrepared(
		command: DryRunCommand & { prepared: PreparedDryRun },
	): AutomationDryRunRecord & { replayed: boolean } {
		const { prepared } = command;
		const { definition, fingerprint } = prepared;
		if (command.testId) {
			const replay = replayPreparedDryRun(
				{ ...command, testId: command.testId },
				prepared,
			);
			if (replay) return replay;
		}
		const timestampMs = now();
		const cutoff = timestampMs - AUTOMATION_RUNTIME_LIMITS.testRetentionMs;
		if (
			!Number.isSafeInteger(command.proposedOrdinal) ||
			command.proposedOrdinal < 0 ||
			command.proposedOrdinal > command.orderedRules.length
		) throw new AutomationRuleError("INVALID", "Automation Rule test position is invalid");
		const proposalId = command.ruleId ?? "dry_run_proposal";
		const existingRules = command.orderedRules.filter((rule) => rule.ruleId !== proposalId);
		const proposedOrdinal = Math.min(command.proposedOrdinal, existingRules.length);
		const proposal: AutomationRuleVersionSnapshot = {
			ordinal: proposedOrdinal,
			ruleId: proposalId,
			ruleName: definition.name,
			version: command.ruleVersion ?? 0,
			definition,
			definitionFingerprint: fingerprint,
		};
		const orderedRules = [...existingRules];
		orderedRules.splice(proposedOrdinal, 0, proposal);
		const normalizedRules = orderedRules.map((rule, ordinal) => ({ ...rule, ordinal }));
		const contexts = command.contexts
			.filter((context) => {
				const date = Date.parse(context.snapshot.date);
				return Number.isFinite(date) && date >= cutoff && date <= timestampMs;
			})
			.sort((left, right) =>
				right.snapshot.date.localeCompare(left.snapshot.date) ||
				right.snapshot.messageId.localeCompare(left.snapshot.messageId)
			)
			.slice(0, AUTOMATION_RULE_LIMITS.dryRunMessages);
		const evaluations = contexts.map((context) => {
			const plan = planAutomationRun(normalizedRules, context);
			return {
				context,
				plan,
				proposal: plan.results.find((result) => result.ruleId === proposalId),
			};
		});
		const matches = evaluations.filter((item) =>
			item.proposal && !new Set<AutomationRunResultOutcome>(["not_matched", "stopped"])
				.has(item.proposal.outcome)
		);
		const actionResults = matches.flatMap((item) => item.proposal?.actionResults ?? []);
		const result: AutomationDryRunRecord["result"] = {
			wouldChange: actionResults.filter((action) => action.status === "applied").length,
			alreadySatisfied: actionResults.filter((action) => action.status === "already_satisfied").length,
			conflicts: actionResults.filter((action) => action.status === "skipped_conflict").length,
			samples: matches.slice(0, AUTOMATION_RULE_LIMITS.dryRunSamples).map(({ context, proposal: sample }) => ({
				messageId: context.snapshot.messageId,
				conversationId: context.snapshot.conversationId,
				sender: context.snapshot.senderAddress,
				subject: context.snapshot.subject,
				date: context.snapshot.date,
				matchedConditionIndexes: sample?.matchedConditionIndexes ?? [],
				plannedActions: sample?.plannedActions ?? [],
				noOpActions: (sample?.actionResults ?? [])
					.filter((action) => action.status === "already_satisfied")
					.map((action) => action.action),
				conflicts: (sample?.actionResults ?? [])
					.filter((action) => action.status === "skipped_conflict")
					.map((action) => action.action),
			})),
		};
		const createdAt = canonicalIso(timestampMs);
		const expiresAt = canonicalIso(timestampMs + AUTOMATION_RUNTIME_LIMITS.testRetentionMs);
		const record: AutomationDryRunRecord = {
			id: command.testId ?? createId("test"),
			actorId: command.actorId,
			ruleId: command.ruleId ?? null,
			ruleVersion: command.ruleVersion ?? null,
			definitionFingerprint: fingerprint,
			evaluatedCount: contexts.length,
			matchedCount: matches.length,
			acknowledgedZero: command.acknowledgedZero,
			result,
			createdAt,
			expiresAt,
		};
		return storage.transactionSync(() => {
			if (command.testId) {
				deleteExactExpiredDryRun(command.testId, timestampMs);
				const existing = automationTestRow(command.testId);
				if (existing) {
					return {
						...assertDryRunIdentity(existing, command, fingerprint),
						replayed: true,
					};
				}
			}
			storage.sql.exec(
				`INSERT INTO automation_rule_tests
				 (id, actor_id, rule_id, rule_version, definition_json, definition_fingerprint,
				  evaluated_count, matched_count, acknowledged_zero, result_json, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				record.id,
				record.actorId,
				record.ruleId,
				record.ruleVersion,
				canonicalAutomationRuleDefinition(definition),
				fingerprint,
				record.evaluatedCount,
				record.matchedCount,
				record.acknowledgedZero ? 1 : 0,
				JSON.stringify(record.result),
				record.createdAt,
				record.expiresAt,
			);
			pruneHistory(timestampMs);
			return { ...record, replayed: false };
		});
	}

	async function dryRun(
		command: DryRunCommand,
	): Promise<AutomationDryRunRecord & { replayed: boolean }> {
		return dryRunPrepared({
			...command,
			prepared: await prepareDryRun(command.definition),
		});
	}

	function pruneHistory(timestampMs = now()): void {
		const runCutoff = canonicalIso(timestampMs - AUTOMATION_RUNTIME_LIMITS.liveRetentionMs);
		storage.sql.exec(
			`DELETE FROM automation_runs WHERE id IN (
			 SELECT id FROM automation_runs
			 WHERE state IN ('no_match', 'applied', 'applied_with_skips', 'failed')
			   AND completed_at <= ?
			 ORDER BY completed_at ASC, id ASC LIMIT ?
			)`,
			runCutoff,
			AUTOMATION_RUNTIME_LIMITS.pruneBatch,
		);
		storage.sql.exec(
			`DELETE FROM automation_runs WHERE id IN (
			 SELECT id FROM (
			   SELECT id, completed_at FROM automation_runs
			   WHERE state IN ('no_match', 'applied', 'applied_with_skips', 'failed')
			   ORDER BY completed_at DESC, id DESC
			   LIMIT -1 OFFSET ?
			 ) ORDER BY completed_at ASC, id ASC LIMIT ?
			)`,
			AUTOMATION_RULE_LIMITS.liveRuns,
			AUTOMATION_RUNTIME_LIMITS.pruneBatch,
		);
		storage.sql.exec(
			`DELETE FROM automation_rule_tests WHERE id IN (
			 SELECT id FROM automation_rule_tests
			 WHERE expires_at <= ? ORDER BY expires_at ASC, id ASC LIMIT ?
			)`,
			canonicalIso(timestampMs),
			AUTOMATION_RUNTIME_LIMITS.pruneBatch,
		);
		storage.sql.exec(
			`DELETE FROM automation_rule_tests WHERE id IN (
			 SELECT id FROM (
			   SELECT id, created_at FROM automation_rule_tests
			   ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?
			 ) ORDER BY created_at ASC, id ASC LIMIT ?
			)`,
			AUTOMATION_RULE_LIMITS.dryRuns,
			AUTOMATION_RUNTIME_LIMITS.pruneBatch,
		);
	}

	function rulesUsingTarget(target: { labelId?: string; folderId?: string }) {
		const table = target.labelId ? "automation_rule_label_refs" : "automation_rule_folder_refs";
		const column = target.labelId ? "label_id" : "folder_id";
		const targetId = target.labelId ?? target.folderId;
		if (!targetId) throw new AutomationRuleError("INVALID", "Automation Rule target is invalid");
		return [...storage.sql.exec<{ id: string; name: string }>(
			`SELECT DISTINCT r.id, r.name
			 FROM automation_rules r JOIN ${table} ref ON ref.rule_id = r.id
			 WHERE ref.${column} = ? AND r.state <> 'archived'
			 ORDER BY r.position ASC, r.id ASC LIMIT 20`,
			targetId,
		)];
	}

	return {
		state: () => stateRow(storage.sql),
		listRules,
		getRule,
		listVersions,
		listRuns,
		getRun,
		listRunResults,
		listTests,
		getTest,
		createDraft,
		updateDraft,
		enable,
		setEnabled,
		archive,
		restoreVersion,
		reorder,
		captureLiveInbound,
		claimNextRun,
		planRun: planAutomationRun,
		finalizeClaim,
		failClaim,
		prepareDryRun,
		replayPreparedDryRun,
		replayDryRun,
		dryRunPrepared,
		dryRun,
		pruneHistory,
		rulesUsingTarget,
	};
}
