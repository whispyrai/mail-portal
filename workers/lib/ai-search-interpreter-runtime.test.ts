import assert from "node:assert/strict";
import test from "node:test";
import type { BeginAiUsageInput } from "./ai-cost-control.ts";
import {
	AiSearchInterpreterAccessRevokedError,
	runAiSearchInterpreter,
	type AiSearchInterpreterRuntimeDependencies,
} from "./ai-search-interpreter-runtime.ts";

const baseCatalog = {
	folders: [{ id: "inbox", name: "Inbox" }],
	labels: [{ id: "label-vip", name: "VIP" }],
};

const readyModelOutput = JSON.stringify({
	status: "ready",
	filters: {
		terms: ["proposal"],
		phrases: [],
		from: [],
		to: [],
		subject: [],
		filename: [],
		folders: ["inbox"],
		isRead: false,
		isStarred: null,
		hasAttachment: false,
		after: null,
		before: null,
	},
	labelId: "label-vip",
});

function harness(options: {
	modelText?: string;
	budgetBlocked?: boolean;
	cached?: unknown;
} = {}) {
	let access = true;
	let catalog: unknown = baseCatalog;
	let stored = options.cached ?? null;
	const calls = {
		access: 0,
		catalog: 0,
		getCached: [] as Array<{ cacheKey: string; cacheScope: string }>,
		putCached: [] as Array<{ cacheKey: string; cacheScope: string; value: unknown }>,
		deleteCached: [] as Array<{ cacheKey: string; cacheScope: string }>,
		beginUsage: [] as BeginAiUsageInput[],
		startUsage: 0,
		completeUsage: [] as unknown[],
		failUsage: [] as unknown[],
		runModel: 0,
		messages: [] as unknown[],
	};
	const dependencies: AiSearchInterpreterRuntimeDependencies = {
		environment: "test",
		model: "cheap-model",
		now: () => Date.parse("2026-07-12T10:00:00.000Z"),
		canAccess: async () => { calls.access += 1; return access; },
		readCatalog: async () => { calls.catalog += 1; return catalog; },
		getCached: async (cacheKey, cacheScope) => {
			calls.getCached.push({ cacheKey, cacheScope });
			return stored as never;
		},
		putCached: async (cacheKey, cacheScope, value) => {
			calls.putCached.push({ cacheKey, cacheScope, value });
			stored = value;
		},
		deleteCached: async (cacheKey, cacheScope) => {
			calls.deleteCached.push({ cacheKey, cacheScope });
			stored = null;
		},
		beginUsage: async (input) => {
			calls.beginUsage.push(input);
			if (input.cacheHit) {
				return {
					decision: "allow", mode: "cached", tier: "cheap",
					model: "cheap-model", ledgerRecorded: true, reviewRequired: false,
				};
			}
			if (options.budgetBlocked) {
				return {
					decision: "block", reason: "admin_review_required",
					reviewRequired: true, fallback: "deterministic_only",
					tier: "cheap", model: "cheap-model", ledgerRecorded: true,
				};
			}
			return {
				decision: "allow", mode: "paid", tier: "cheap",
				model: "cheap-model", reservationId: "reservation-1",
				ledgerRecorded: true, reviewRequired: false,
			};
		},
		startUsage: async () => { calls.startUsage += 1; return true; },
		completeUsage: async (_reservationId, actual) => {
			calls.completeUsage.push(actual);
		},
		failUsage: async (_reservationId, failure) => {
			calls.failUsage.push(failure);
		},
		runModel: async (_model, messages) => {
			calls.runModel += 1;
			calls.messages.push(messages);
			return {
				text: options.modelText ?? readyModelOutput,
				promptTokens: 100,
				completionTokens: 40,
			};
		},
	};
	return {
		dependencies,
		calls,
		setAccess(value: boolean) { access = value; },
		setCatalog(value: unknown) { catalog = value; },
		setStored(value: unknown) { stored = value; },
		getStored() { return stored; },
	};
}

const input = {
	actorUserId: "user-1",
	mailboxId: "team@example.com",
	request: { intent: "Unread proposals in Inbox", timezone: "Africa/Cairo" },
};

test("generated interpretation settles cheap usage, caches privately, and never searches mail", async () => {
	const test = harness();
	const result = await runAiSearchInterpreter(test.dependencies, input);
	assert.equal(result.state, "generated");
	assert.equal(result.state === "generated" ? result.requiresReview : false, true);
	assert.equal(test.calls.runModel, 1);
	assert.equal(test.calls.startUsage, 1);
	assert.equal(test.calls.completeUsage.length, 1);
	assert.equal(test.calls.failUsage.length, 0);
	assert.equal(test.calls.putCached.length, 1);
	assert.equal(
		test.calls.putCached[0]!.cacheScope,
		"search-interpreter:owner:user-1:mailbox:team@example.com",
	);
	assert.deepEqual(test.calls.beginUsage[0], {
		feature: "search_interpreter",
		actorUserId: "user-1",
		mailboxId: "team@example.com",
		requestedTier: "cheap",
		estimatedCostMicros: 5_000,
		cacheKey: test.calls.putCached[0]!.cacheKey,
		cacheHit: false,
	});
	assert.doesNotMatch(JSON.stringify(test.calls.beginUsage), /Unread proposals/);
	assert.equal("search" in test.dependencies, false);
});

test("valid private cache is reparsed, freshness-checked, and recorded without provider work", async () => {
	const test = harness();
	await runAiSearchInterpreter(test.dependencies, input);
	const second = await runAiSearchInterpreter(test.dependencies, input);
	assert.equal(second.state, "cached");
	assert.equal(test.calls.runModel, 1);
	assert.equal(test.calls.startUsage, 1);
	assert.equal(test.calls.beginUsage.at(-1)?.cacheHit, true);
	assert.equal(test.calls.getCached.at(-1)?.cacheScope.includes("owner:user-1"), true);
});

test("corrupt cache is deleted and falls through to one paid generation", async () => {
	const first = harness();
	await runAiSearchInterpreter(first.dependencies, input);
	const cached = first.getStored() as Record<string, unknown>;
	const test = harness({
		cached: { ...cached, modelOutput: { status: "ready", leaked: true } },
	});
	const result = await runAiSearchInterpreter(test.dependencies, input);
	assert.equal(result.state, "generated");
	assert.equal(test.calls.deleteCached.length, 1);
	assert.equal(test.calls.runModel, 1);
});

test("budget pause does no provider work and still checks catalog freshness", async () => {
	const test = harness({ budgetBlocked: true });
	const result = await runAiSearchInterpreter(test.dependencies, input);
	assert.deepEqual(result, { state: "budget_paused" });
	assert.equal(test.calls.runModel, 0);
	assert.equal(test.calls.startUsage, 0);
	assert.equal(test.calls.putCached.length, 0);
});

test("catalog changes during inference settle usage but return stale without caching", async () => {
	const test = harness();
	const originalRun = test.dependencies.runModel;
	test.dependencies.runModel = async (...args) => {
		const result = await originalRun(...args);
		test.setCatalog({
			folders: baseCatalog.folders,
			labels: [{ id: "label-vip", name: "Priority" }],
		});
		return result;
	};
	const result = await runAiSearchInterpreter(test.dependencies, input);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(test.calls.completeUsage.length, 1);
	assert.equal(test.calls.putCached.length, 0);
});

test("revocation after provider or cache write exposes nothing and removes persisted output", async () => {
	const afterProvider = harness();
	const originalRun = afterProvider.dependencies.runModel;
	afterProvider.dependencies.runModel = async (...args) => {
		const result = await originalRun(...args);
		afterProvider.setAccess(false);
		return result;
	};
	await assert.rejects(
		runAiSearchInterpreter(afterProvider.dependencies, input),
		AiSearchInterpreterAccessRevokedError,
	);
	assert.equal(afterProvider.calls.completeUsage.length, 1);
	assert.equal(afterProvider.calls.putCached.length, 0);

	const afterCache = harness();
	const originalPut = afterCache.dependencies.putCached;
	afterCache.dependencies.putCached = async (...args) => {
		await originalPut(...args);
		afterCache.setAccess(false);
	};
	await assert.rejects(
		runAiSearchInterpreter(afterCache.dependencies, input),
		AiSearchInterpreterAccessRevokedError,
	);
	assert.equal(afterCache.calls.putCached.length, 1);
	assert.equal(afterCache.calls.deleteCached.length, 1);
});

test("invalid provider output fails charged usage and never caches", async () => {
	const test = harness({ modelText: "not-json" });
	await assert.rejects(runAiSearchInterpreter(test.dependencies, input));
	assert.equal(test.calls.completeUsage.length, 0);
	assert.equal(test.calls.failUsage.length, 1);
	assert.equal(test.calls.putCached.length, 0);
	assert.equal(
		(test.calls.failUsage[0] as { errorCode: string }).errorCode,
		"invalid_search_interpreter_output",
	);
});

test("access denial wins before catalog, cache, cost, or provider work", async () => {
	const test = harness();
	test.setAccess(false);
	await assert.rejects(
		runAiSearchInterpreter(test.dependencies, input),
		AiSearchInterpreterAccessRevokedError,
	);
	assert.equal(test.calls.catalog, 0);
	assert.equal(test.calls.getCached.length, 0);
	assert.equal(test.calls.beginUsage.length, 0);
	assert.equal(test.calls.runModel, 0);
});

test("identical in-process requests share one paid provider run", async () => {
	const test = harness();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const originalRun = test.dependencies.runModel;
	test.dependencies.runModel = async (...args) => {
		await gate;
		return originalRun(...args);
	};
	const first = runAiSearchInterpreter(test.dependencies, input);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const second = runAiSearchInterpreter(test.dependencies, input);
	await new Promise((resolve) => setTimeout(resolve, 0));
	release?.();
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.deepEqual(secondResult, firstResult);
	assert.equal(test.calls.runModel, 1);
	assert.equal(test.calls.startUsage, 1);
});
