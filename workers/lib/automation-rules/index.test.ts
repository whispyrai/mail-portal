import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
	AutomationMessageSnapshot,
	AutomationRuleDefinition,
	AutomationRuleVersionSnapshot,
} from "../../../shared/automation-rules.ts";
import { mailboxMigrations } from "../../durableObject/migrations.ts";
import {
	AutomationRuleError,
	createAutomationRulesModule,
	evaluateAutomationRule,
	planAutomationRun,
	type AutomationPlanningContext,
	type AutomationRulesStorage,
} from "./index.ts";

function databaseStorage(database: DatabaseSync): AutomationRulesStorage {
	const sql = {
		exec<T extends Record<string, ArrayBuffer | string | number | null>>(
			query: string,
			...bindings: Array<ArrayBuffer | string | number | null>
		): Iterable<T> {
			return database.prepare(query).all(...bindings) as T[];
		},
	};
	return {
		sql,
		transactionSync<T>(run: () => T): T {
			database.exec("BEGIN IMMEDIATE");
			try {
				const result = run();
				database.exec("COMMIT");
				return result;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	};
}

function migratedDatabase(): DatabaseSync {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of mailboxMigrations) database.exec(migration.sql);
	return database;
}

function snapshot(overrides: Partial<AutomationMessageSnapshot> = {}): AutomationMessageSnapshot {
	return {
		messageId: "message-1",
		conversationId: "conversation-1",
		folderId: "inbox",
		senderAddress: "finance@example.com",
		subject: "Résumé invoice",
		date: "2026-07-12T12:00:00.000Z",
		attachments: [{ filename: "Quarterly.PDF", disposition: "inline" }],
		...overrides,
	};
}

function definition(
	name: string,
	input: Partial<AutomationRuleDefinition> = {},
): AutomationRuleDefinition {
	return {
		schemaVersion: 1,
		name,
		match: "all",
		conditions: [{ kind: "every_incoming" }],
		actions: [{ kind: "star" }],
		stopProcessing: false,
		...input,
	};
}

function captured(
	ordinal: number,
	ruleId: string,
	ruleDefinition: AutomationRuleDefinition,
): AutomationRuleVersionSnapshot {
	return {
		ordinal,
		ruleId,
		ruleName: ruleDefinition.name,
		version: 1,
		definition: ruleDefinition,
		definitionFingerprint: `fingerprint-${ruleId}`,
	};
}

function planningContext(overrides: Partial<AutomationPlanningContext> = {}): AutomationPlanningContext {
	return {
		snapshot: snapshot(),
		currentInboxScope: {
			conversationMessageIds: ["message-1"],
			existingLabelIds: [],
			triggerIsStarred: false,
		},
		availableLabelIds: ["label-finance", "label-review"],
		availableMoveFolderIds: ["archive", "folder-review"],
		...overrides,
	};
}

test("evaluator covers all/any, negatives, Unicode, exact domains, and inline filenames", () => {
	const all = definition("All", {
		conditions: [
			{ kind: "sender_address", operator: "is_not_any_of", values: ["blocked@example.com"] },
			{ kind: "sender_domain", operator: "is_any_of", values: ["example.com"] },
			{ kind: "subject", operator: "contains", value: "RÉSUMÉ" },
			{ kind: "attachment_presence", operator: "has" },
			{ kind: "attachment_filename", operator: "ends_with_any", values: [".pdf"] },
		],
	});
	assert.equal(evaluateAutomationRule(all, snapshot()).matched, true);
	assert.equal(
		evaluateAutomationRule(all, snapshot({ senderAddress: "finance@sub.example.com" })).matched,
		false,
		"subdomains never match an exact domain implicitly",
	);
	const any = definition("Any", {
		match: "any",
		conditions: [
			{ kind: "subject", operator: "equals", value: "not this" },
			{ kind: "attachment_filename", operator: "contains", value: "quarterly" },
		],
	});
	assert.equal(evaluateAutomationRule(any, snapshot()).matched, true);
});

test("planner preserves stable order, stop behavior, additive actions, and first-move conflict", () => {
	const rules = [
		captured(0, "rule-first", definition("First", {
			actions: [
				{ kind: "apply_labels", labelIds: ["label-finance"] },
				{ kind: "move_to_folder", folderId: "archive" },
			],
		})),
		captured(1, "rule-second", definition("Second", {
			actions: [
				{ kind: "apply_labels", labelIds: ["label-review"] },
				{ kind: "move_to_folder", folderId: "folder-review" },
			],
		})),
	];
	const plan = planAutomationRun(rules, planningContext());
	assert.equal(plan.state, "applied_with_skips");
	assert.equal(plan.move?.folderId, "archive");
	assert.deepEqual(plan.applyLabels.map((action) => action.labelId), ["label-finance", "label-review"]);
	assert.equal(plan.results[1]?.outcome, "applied");
	assert.equal(
		plan.results[1]?.actionResults.find((action) => action.action === "move_to_folder")?.status,
		"skipped_conflict",
	);

	const stopped = planAutomationRun([
		captured(0, "rule-stop", definition("Stop", { stopProcessing: true })),
		captured(1, "rule-never", definition("Never")),
	], planningContext());
	assert.equal(stopped.stoppedByRuleId, "rule-stop");
	assert.equal(stopped.results[1]?.outcome, "stopped");
});

test("dry run uses the exact combined live planner and stores no-op/conflict truth", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	let now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
	});
	const earlier = captured(0, "rule-earlier", definition("Earlier", {
		actions: [{ kind: "move_to_folder", folderId: "archive" }],
	}));
	const proposed = definition("Proposed", {
		actions: [
			{ kind: "star" },
			{ kind: "move_to_folder", folderId: "folder-review" },
		],
	});
	const tested = await module.dryRun({
		definition: proposed,
		contexts: [planningContext({
			currentInboxScope: {
				conversationMessageIds: ["message-1"],
				existingLabelIds: [],
				triggerIsStarred: true,
			},
		})],
		orderedRules: [earlier],
		proposedOrdinal: 1,
		actorId: "user-1",
		ruleId: "rule-proposed",
		ruleVersion: 1,
		acknowledgedZero: false,
	});
	assert.equal(tested.result.wouldChange, 0);
	assert.equal(tested.result.alreadySatisfied, 1);
	assert.equal(tested.result.conflicts, 1);
	assert.deepEqual(tested.result.samples[0]?.noOpActions, ["star"]);
	assert.deepEqual(tested.result.samples[0]?.conflicts, ["move_to_folder"]);
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM activity_events").get()?.count, 0);
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automation_runs").get()?.count, 0);
	const archivedNonMatch = await module.dryRun({
		definition: definition("Archived non-match", {
			conditions: [{ kind: "subject", operator: "equals", value: "Different subject" }],
		}),
		contexts: [planningContext({ currentInboxScope: null })],
		orderedRules: [],
		proposedOrdinal: 0,
		actorId: "user-1",
		acknowledgedZero: true,
	});
	assert.equal(archivedNonMatch.matchedCount, 0);
	assert.equal(archivedNonMatch.result.samples.length, 0);
	now += 1;
	database.close();
});

test("draft activation requires the matching stored test acknowledgement for zero results", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
	});
	const draft = await module.createDraft({
		definition: definition("Zero"),
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	await module.dryRun({
		definition: definition("Zero"),
		contexts: [],
		orderedRules: [],
		proposedOrdinal: 0,
		actorId: "user-1",
		ruleId: draft.id,
		ruleVersion: 1,
		acknowledgedZero: false,
	});
	assert.throws(
		() => module.enable({
			ruleId: draft.id,
			actorId: "user-1",
			expectedRevision: draft.revision,
		}),
		(error: unknown) => error instanceof AutomationRuleError && error.code === "ACTIVATION_TEST_REQUIRED",
	);
	database.close();
});

test("archiving cannot bypass the bounded retained-rule limit", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const timestamp = "2026-07-12T12:00:00.000Z";
	database.exec(`
		WITH RECURSIVE sequence(value) AS (
			SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 500
		)
		INSERT INTO automation_rules(
			id, name, normalized_name, state, active_version, draft_version, next_version,
			position, revision, created_by, created_at, updated_by, updated_at, archived_by, archived_at
		)
		SELECT 'archived-' || value, 'Archived ' || value, 'archived ' || value,
			'archived', NULL, NULL, 1, value, 1, 'user-1', '${timestamp}',
			'user-1', '${timestamp}', 'user-1', '${timestamp}'
		FROM sequence;
	`);
	const module = createAutomationRulesModule({ storage, now: () => Date.parse(timestamp) });
	await assert.rejects(
		module.createDraft({
			definition: definition("One too many"),
			actorId: "user-1",
			expectedOrderRevision: 0,
		}),
		(error: unknown) =>
			error instanceof AutomationRuleError &&
			error.message.includes("retained Automation Rule limit"),
	);
	database.close();
});

test("immutable version numbering is bounded per Rule", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const module = createAutomationRulesModule({
		storage,
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
	});
	const draft = await module.createDraft({
		definition: definition("Bounded versions"),
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	database.prepare(
		"UPDATE automation_rules SET next_version = 501 WHERE id = ?",
	).run(draft.id);
	await assert.rejects(
		module.updateDraft({
			ruleId: draft.id,
			definition: definition("One version too many"),
			actorId: "user-1",
			expectedRevision: draft.revision,
		}),
		(error: unknown) =>
			error instanceof AutomationRuleError &&
			error.message.includes("retained version limit"),
	);
	database.close();
});

test("rule writes reject missing labels and forged system or internal move targets", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const module = createAutomationRulesModule({
		storage,
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
	});
	await assert.rejects(
		module.createDraft({
			definition: definition("Missing label", {
				actions: [{ kind: "apply_labels", labelIds: ["label-missing"] }],
			}),
			actorId: "user-1",
			expectedOrderRevision: 0,
		}),
		(error: unknown) => error instanceof AutomationRuleError && error.code === "INVALID",
	);
	for (const folderId of ["inbox", "sent", "draft", "outbox", "snoozed", "trash", "spam", "_cancelled_outbound"]) {
		await assert.rejects(
			module.createDraft({
				definition: definition(`Move ${folderId}`, {
					actions: [{ kind: "move_to_folder", folderId }],
				}),
				actorId: "user-1",
				expectedOrderRevision: 0,
			}),
			(error: unknown) => error instanceof AutomationRuleError && error.code === "INVALID",
			folderId,
		);
	}
	database.exec("INSERT INTO folders(id, name, is_deletable) VALUES ('folder-review', 'Review', 1)");
	const allowed = await module.createDraft({
		definition: definition("Move custom", {
			actions: [{ kind: "move_to_folder", folderId: "folder-review" }],
		}),
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	assert.equal(allowed.state, "draft");
	database.close();
});

test("captured versions survive edits; leases retry safely and finalize actions atomically", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	let now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	let token = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
		createToken: () => `lease-${++token}`,
	});
	database.exec(`
		INSERT INTO labels(id, name, normalized_name, color, created_at, updated_at)
		VALUES ('label-finance', 'Finance', 'finance', 'blue', '2026-07-12T12:00:00.000Z', '2026-07-12T12:00:00.000Z');
	`);
	const v1 = definition("Finance", {
		actions: [{ kind: "apply_labels", labelIds: ["label-finance"] }],
	});
	const draft = await module.createDraft({
		definition: v1,
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	await module.dryRun({
		definition: v1,
		contexts: [planningContext()],
		orderedRules: [],
		proposedOrdinal: 0,
		actorId: "user-1",
		ruleId: draft.id,
		ruleVersion: 1,
		acknowledgedZero: false,
	});
	const enabled = module.enable({
		ruleId: draft.id,
		actorId: "user-1",
		expectedRevision: draft.revision,
	});
	storage.transactionSync(() => {
		database.prepare(`
			INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body, thread_id)
			VALUES (?, 'inbox', 'Invoice', 'finance@example.com', 'team@example.com', ?, '', 'conversation-1')
		`).run("message-live", canonical(now));
		module.captureLiveInbound("message-live", canonical(now));
	});
	const updated = await module.updateDraft({
		ruleId: draft.id,
		definition: definition("Finance v2", { actions: [{ kind: "star" }] }),
		actorId: "user-1",
		expectedRevision: enabled.revision,
	});
	module.setEnabled({
		ruleId: draft.id,
		enabled: false,
		actorId: "user-1",
		expectedRevision: updated.revision,
	});
	const replay = module.captureLiveInbound("message-live", canonical(now));
	assert.equal(replay.replayed, true);

	const firstClaim = module.claimNextRun();
	assert.ok(firstClaim);
	assert.equal(firstClaim.rules[0]?.version, 1);
	assert.equal(firstClaim.rules[0]?.definition.actions[0]?.kind, "apply_labels");
	assert.equal(module.claimNextRun(), null, "one processing lease owns the run");
	assert.equal(module.failClaim(firstClaim, "temporary_storage", true), true);
	assert.equal(database.prepare("SELECT state FROM automation_runs WHERE id = ?").get(firstClaim.id)?.state, "pending");

	now += 10_000;
	const retryClaim = module.claimNextRun();
	assert.ok(retryClaim);
	assert.equal(retryClaim.attemptCount, 2);
	const plan = module.planRun(retryClaim.rules, planningContext({
		snapshot: snapshot({ messageId: "message-live" }),
	}));
	let appliedInsideTransaction = false;
	assert.equal(module.finalizeClaim(retryClaim, plan, (actionPlan) => {
		appliedInsideTransaction = database.isTransaction;
		for (const action of actionPlan.applyLabels) {
			database.prepare(`
				INSERT OR IGNORE INTO email_labels(email_id, label_id, created_at) VALUES (?, ?, ?)
			`).run("message-live", action.labelId, canonical(now));
		}
	}), true);
	assert.equal(appliedInsideTransaction, true);
	assert.equal(database.prepare("SELECT state FROM automation_runs WHERE id = ?").get(retryClaim.id)?.state, "applied");
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automation_run_results WHERE run_id = ?").get(retryClaim.id)?.count, 1);
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automation_run_label_refs WHERE run_id = ?").get(retryClaim.id)?.count, 0);
	assert.equal(module.listRuns()[0]?.id, retryClaim.id);
	assert.equal(module.getRun(retryClaim.id).state, "applied");
	assert.equal(module.listRunResults(retryClaim.id)[0]?.ruleVersion, 1);
	assert.equal(module.listTests(draft.id)[0]?.definitionFingerprint.length, 64);
	database.close();
});

test("expired and corrupt claims cannot mutate or poison later due runs", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	let now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
		createToken: () => `lease-${id}`,
	});
	const draft = await module.createDraft({
		definition: definition("Rule"),
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	await module.dryRun({
		definition: definition("Rule"),
		contexts: [planningContext()],
		orderedRules: [],
		proposedOrdinal: 0,
		actorId: "user-1",
		ruleId: draft.id,
		ruleVersion: 1,
		acknowledgedZero: false,
	});
	module.enable({ ruleId: draft.id, actorId: "user-1", expectedRevision: 1 });
	for (const messageId of ["message-corrupt", "message-good", "message-expired"]) {
		storage.transactionSync(() => {
			database.prepare(`
				INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body, thread_id)
				VALUES (?, 'inbox', 'Mail', 'sender@example.com', 'team@example.com', ?, '', ?)
			`).run(messageId, canonical(now), messageId);
			module.captureLiveInbound(messageId, canonical(now));
		});
	}
	database.prepare(
		"UPDATE automation_run_rules SET definition_json = '{' WHERE run_id = ?",
	).run("automation:message-corrupt");
	const goodClaim = module.claimNextRun();
	assert.ok(goodClaim);
	assert.equal(goodClaim.id, "automation:message-expired", "corrupt first row is terminalized and next due row is claimed");
	assert.equal(database.prepare("SELECT state FROM automation_runs WHERE id = ?").get("automation:message-corrupt")?.state, "failed");
	now += 30_001;
	assert.equal(module.failClaim(goodClaim, "late_worker", true), false, "expired lease cannot mutate the run");
	database.prepare(`
		UPDATE automation_runs SET attempt_count = 4, lease_expires_at = ?, state = 'processing'
		WHERE id = ?
	`).run(canonical(now - 1), goodClaim.id);
	module.claimNextRun();
	assert.equal(database.prepare("SELECT state FROM automation_runs WHERE id = ?").get(goodClaim.id)?.state, "failed");
	assert.equal(database.prepare("SELECT COUNT(*) AS count FROM automation_run_label_refs WHERE run_id = ?").get(goodClaim.id)?.count, 0);
	database.close();
});

test("capture failure keeps a terminal run and rolls back every partial rule snapshot", async () => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
	});
	const draft = await module.createDraft({
		definition: definition("Rule"),
		actorId: "user-1",
		expectedOrderRevision: 0,
	});
	await module.dryRun({
		definition: definition("Rule"),
		contexts: [planningContext()],
		orderedRules: [],
		proposedOrdinal: 0,
		actorId: "user-1",
		ruleId: draft.id,
		ruleVersion: 1,
		acknowledgedZero: false,
	});
	module.enable({ ruleId: draft.id, actorId: "user-1", expectedRevision: 1 });
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES (?, 'inbox', 'Mail', 'sender@example.com', 'team@example.com', ?, '', ?)
	`).run("message-capture-failure", canonical(now), "conversation-capture-failure");
	database.exec(`
		CREATE TRIGGER reject_captured_rule BEFORE INSERT ON automation_run_rules BEGIN
			SELECT RAISE(ABORT, 'simulated snapshot failure');
		END;
	`);
	const captured = module.captureLiveInbound("message-capture-failure", canonical(now));
	assert.equal(captured.state, "failed");
	assert.equal(captured.captureFailed, true);
	const failed = database.prepare(`
			SELECT state, failure_category AS failureCategory, completed_at AS completedAt
			FROM automation_runs WHERE trigger_message_id = ?
		`).get("message-capture-failure") as Record<string, unknown>;
	assert.equal(failed.state, "failed");
	assert.equal(failed.failureCategory, "capture_failed");
	assert.equal(failed.completedAt, canonical(now));
	assert.equal(
		database.prepare("SELECT COUNT(*) AS count FROM automation_run_rules").get()?.count,
		0,
	);
	assert.equal(module.captureLiveInbound("message-capture-failure", canonical(now)).replayed, true);
	database.close();
});

test("maximum live rules compile, capture, and plan inside a bounded Worker budget", async (context) => {
	const database = migratedDatabase();
	const storage = databaseStorage(database);
	const now = Date.parse("2026-07-12T12:00:00.000Z");
	let id = 0;
	const module = createAutomationRulesModule({
		storage,
		now: () => now,
		createId: (prefix) => `${prefix}-${++id}`,
	});
	for (let label = 0; label < 20; label += 1) {
		database.prepare(`
			INSERT INTO labels(id, name, normalized_name, color, created_at, updated_at)
			VALUES (?, ?, ?, 'blue', ?, ?)
		`).run(`label-${label}`, `Label ${label}`, `label ${label}`, canonical(now), canonical(now));
	}
	const maximumDefinition = (rule: number): AutomationRuleDefinition => ({
		schemaVersion: 1,
		name: `Maximum rule ${rule}`,
		match: "all",
		conditions: Array.from({ length: 10 }, () => ({
			kind: "subject" as const,
			operator: "contains" as const,
			value: "invoice",
		})),
		actions: [
			{ kind: "apply_labels", labelIds: Array.from({ length: 20 }, (_, label) => `label-${label}`) },
			{ kind: "star" },
			{ kind: "move_to_folder", folderId: "archive" },
		],
		stopProcessing: false,
	});
	const enabledSnapshots: AutomationRuleVersionSnapshot[] = [];
	const compileStarted = performance.now();
	for (let rule = 0; rule < 50; rule += 1) {
		const ruleDefinition = maximumDefinition(rule);
		const draft = await module.createDraft({
			definition: ruleDefinition,
			actorId: "benchmark-user",
			expectedOrderRevision: module.state().orderRevision,
		});
		await module.dryRun({
			definition: ruleDefinition,
			contexts: [],
			orderedRules: enabledSnapshots,
			proposedOrdinal: rule,
			actorId: "benchmark-user",
			ruleId: draft.id,
			ruleVersion: draft.draftVersion ?? 1,
			acknowledgedZero: true,
		});
		module.enable({
			ruleId: draft.id,
			actorId: "benchmark-user",
			expectedRevision: draft.revision,
		});
		enabledSnapshots.push({
			ordinal: rule,
			ruleId: draft.id,
			ruleName: ruleDefinition.name,
			version: draft.draftVersion ?? 1,
			definition: ruleDefinition,
			definitionFingerprint: "0".repeat(64),
		});
	}
	const compileMs = performance.now() - compileStarted;
	database.prepare(`
		INSERT INTO emails(id, folder_id, subject, sender, recipient, date, body, thread_id)
		VALUES (?, 'inbox', 'Invoice', 'sender@example.com', 'team@example.com', ?, '', ?)
	`).run("message-maximum", canonical(now), "conversation-maximum");
	const captureStarted = performance.now();
	const captured = module.captureLiveInbound("message-maximum", canonical(now));
	const captureMs = performance.now() - captureStarted;
	assert.equal(captured.state, "pending");
	assert.equal(
		database.prepare("SELECT COUNT(*) AS count FROM automation_run_rules WHERE run_id = ?")
			.get(captured.runId)?.count,
		50,
	);
	const claim = module.claimNextRun();
	assert.ok(claim);
	const planningStarted = performance.now();
	const plan = module.planRun(claim.rules, planningContext({
		snapshot: snapshot({
			messageId: "message-maximum",
			subject: "Invoice invoice invoice",
		}),
		currentInboxScope: {
			conversationMessageIds: Array.from({ length: 200 }, (_, index) => `message-${index}`),
			existingLabelIds: [],
			triggerIsStarred: false,
		},
		availableLabelIds: Array.from({ length: 20 }, (_, label) => `label-${label}`),
		availableMoveFolderIds: ["archive"],
	}));
	const planningMs = performance.now() - planningStarted;
	assert.equal(plan.evaluatedCount, 50);
	assert.equal(plan.matchedCount, 50);
	assert.ok(compileMs < 5_000, `maximum rule compilation took ${compileMs.toFixed(1)} ms`);
	assert.ok(captureMs < 5_000, `maximum run capture took ${captureMs.toFixed(1)} ms`);
	assert.ok(planningMs < 5_000, `maximum run planning took ${planningMs.toFixed(1)} ms`);
	context.diagnostic(
		`maximum Automation benchmark: compile ${compileMs.toFixed(1)} ms, capture ${captureMs.toFixed(1)} ms, plan ${planningMs.toFixed(1)} ms`,
	);
	database.close();
});

function canonical(timestamp: number): string {
	return new Date(timestamp).toISOString();
}
