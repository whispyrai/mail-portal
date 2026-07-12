import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	parseInboxTriageSuggestionRequest,
	validateNormalizedInboxTriageSuggestionRequest,
} from "../../shared/inbox-triage-suggestions.ts";
import type { Env } from "../types.ts";
import type { InboxTriageCandidateSnapshot } from "./inbox-triage-candidates.ts";
import {
	InboxTriageSuggestionAccessRevokedError,
	createInboxTriageSuggestionRuntime,
	runInboxTriageSuggestions,
	type InboxTriageSuggestionRuntimeDependencies,
} from "./inbox-triage-suggestions-runtime.ts";

const snapshot: InboxTriageCandidateSnapshot = {
	version: 1,
	page: 1,
	labelId: null,
	visibleEmailIds: ["email-1"],
	candidates: [
		{
			candidateId: "email-1",
			emailId: "email-1",
			conversationId: "thread-1",
			subject: "Resolved",
			counterparty: "customer@example.com",
			latestAt: "2026-07-12T08:00:00Z",
			read: false,
			threadUnreadCount: 1,
			starred: false,
			hasDraft: false,
			messages: [
				{
					id: "message-1",
					date: "2026-07-12T08:00:00Z",
					sender: "customer@example.com",
					subject: "Resolved",
					text: "This has been resolved, thank you.",
				},
			],
		},
	],
};

function allowDecision(): AiUsageDecision {
	return {
		decision: "allow",
		mode: "paid",
		tier: "cheap",
		model: "cheap-model",
		reservationId: "reservation-1",
		ledgerRecorded: true,
		reviewRequired: false,
	};
}

function dependencies(
	input: {
		projections?: Array<{ state: "ready"; snapshot: InboxTriageCandidateSnapshot } | { state: "stale" }>;
		access?: boolean[];
		cached?: unknown;
		decision?: AiUsageDecision;
		runModel?: InboxTriageSuggestionRuntimeDependencies["runModel"];
	} = {},
) {
	const projections = [...(input.projections ?? [])];
	const access = [...(input.access ?? [])];
	const calls = {
		readProjection: 0,
		getCached: 0,
		putCached: [] as unknown[],
		deleteCached: 0,
		beginUsage: [] as unknown[],
		startUsage: 0,
		completeUsage: 0,
		failUsage: 0,
		runModel: 0,
	};
	const deps: InboxTriageSuggestionRuntimeDependencies = {
		environment: "test",
		model: "cheap-model",
		canAccess: async () => access.shift() ?? true,
		readProjection: async () => {
			calls.readProjection += 1;
			return projections.shift() ?? { state: "ready", snapshot };
		},
		getCached: async () => {
			calls.getCached += 1;
			return (input.cached ?? null) as never;
		},
		putCached: async (_key, _scope, value) => {
			calls.putCached.push(value);
		},
		deleteCached: async () => {
			calls.deleteCached += 1;
		},
		beginUsage: async (usage) => {
			calls.beginUsage.push(usage);
			return input.decision ?? allowDecision();
		},
		startUsage: async () => {
			calls.startUsage += 1;
			return true;
		},
		completeUsage: async () => {
			calls.completeUsage += 1;
		},
		failUsage: async () => {
			calls.failUsage += 1;
		},
		runModel: async (...args) => {
			calls.runModel += 1;
			if (input.runModel) return input.runModel(...args);
			return {
				text: JSON.stringify({
					suggestions: [
						{
							candidateId: "email-1",
							action: "archive",
							explanation: "The customer confirms the issue is resolved.",
							messageIds: ["message-1"],
						},
					],
				}),
				promptTokens: 300,
				completionTokens: 70,
			};
		},
	};
	return { deps, calls };
}

const request = {
	actorUserId: "user-a",
	mailboxId: "team@example.com",
	request: { page: 1, visibleEmailIds: ["email-1"] },
};

function projectionSequence(
	count: number,
	last: InboxTriageCandidateSnapshot = snapshot,
) {
	return Array.from({ length: count }, (_, index) => ({
		state: "ready" as const,
		snapshot: index === count - 1 ? last : snapshot,
	}));
}

function changedSnapshot(): InboxTriageCandidateSnapshot {
	const changed = structuredClone(snapshot);
	changed.candidates[0]!.messages[0]!.text = "Changed mail";
	return changed;
}

test("generation is review-only, costed once, and cached in actor-private scope", async () => {
	const { deps, calls } = dependencies();
	const result = await runInboxTriageSuggestions(deps, request);
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.equal(result.result.suggestions[0]!.requiresHumanReview, true);
	assert.equal(result.result.suggestions[0]!.action, "archive");
	assert.equal(calls.runModel, 1);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(
		(calls.beginUsage[0] as { feature?: string }).feature,
		"inbox_triage_suggestions",
	);
	assert.equal(
		(calls.beginUsage[0] as { estimatedCostMicros?: number }).estimatedCostMicros,
		10_000,
	);
});

test("valid cache hit is revalidated against the current candidate allowlists and avoids provider work", async () => {
	const first = dependencies();
	await runInboxTriageSuggestions(first.deps, request);
	const cached = first.calls.putCached[0];
	const { deps, calls } = dependencies({ cached });
	const result = await runInboxTriageSuggestions(deps, request);
	assert.equal(result.state, "cached");
	assert.equal(calls.runModel, 0);
	assert.equal(calls.startUsage, 0);
	assert.equal((calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit, true);
});

test("corrupt cached output is evicted and cannot bypass current output validation", async () => {
	const first = dependencies();
	await runInboxTriageSuggestions(first.deps, request);
	const cached = first.calls.putCached[0] as {
		fingerprint: string;
		modelOutput: unknown;
	};
	const { deps, calls } = dependencies({
		cached: {
			fingerprint: cached.fingerprint,
			modelOutput: {
				suggestions: [
					{
						candidateId: "email-1",
						action: "trash",
						explanation: "Unsafe",
						messageIds: ["message-1"],
					},
				],
			},
		},
	});
	const result = await runInboxTriageSuggestions(deps, request);
	assert.equal(result.state, "generated");
	assert.equal(calls.deleteCached, 1);
	assert.equal(calls.runModel, 1);
});

test("ordered page mismatch returns stale before cache, cost, or provider", async () => {
	const { deps, calls } = dependencies({
		projections: [{ state: "stale" }],
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.getCached, 0);
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});

test("snapshot change before cache use returns stale before cost", async () => {
	const { deps, calls } = dependencies({
		projections: [
			{ state: "ready", snapshot },
			{ state: "ready", snapshot: changedSnapshot() },
		],
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.getCached, 0);
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});

test("snapshot change at the pre-cost boundary spends nothing", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(3, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
});

test("snapshot change before reservation start fails the unused reservation", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(4, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.beginUsage.length, 1);
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.runModel, 0);
});

test("snapshot change immediately after usage start blocks provider dispatch and settles failure", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(5, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.startUsage, 1);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.runModel, 0);
});

test("snapshot change after inference settles provider cost and never caches", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(6, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.runModel, 1);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage, 0);
	assert.equal(calls.putCached.length, 0);
});

test("snapshot change at the pre-cache boundary never writes stale output", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(7, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("snapshot change after cache write evicts the just-written stale output", async () => {
	const { deps, calls } = dependencies({
		projections: projectionSequence(8, changedSnapshot()),
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "stale",
	});
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("access revocation after cache write evicts output and exposes no result", async () => {
	const { deps, calls } = dependencies({
		access: [...Array.from({ length: 14 }, () => true), false],
	});
	await assert.rejects(
		() => runInboxTriageSuggestions(deps, request),
		InboxTriageSuggestionAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("budget pause happens after freshness validation and performs no provider work", async () => {
	const { deps, calls } = dependencies({
		decision: {
			decision: "block",
			reason: "admin_review_required",
			reviewRequired: true,
			fallback: "deterministic_only",
			tier: "cheap",
			model: "cheap-model",
			ledgerRecorded: true,
		},
	});
	assert.deepEqual(await runInboxTriageSuggestions(deps, request), {
		state: "budget_paused",
		reason: "admin_review_required",
	});
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
});

test("invalid provider output is rejected, charged as failed usage, and never cached", async () => {
	const { deps, calls } = dependencies({
		runModel: async () => ({
			text: JSON.stringify({
				suggestions: [
					{
						candidateId: "email-1",
						action: "trash",
						explanation: "Unsafe",
						messageIds: ["message-1"],
					},
				],
			}),
			promptTokens: 300,
			completionTokens: 20,
		}),
	});
	await assert.rejects(() => runInboxTriageSuggestions(deps, request));
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("revoked access fails without reading mail or spending", async () => {
	const { deps, calls } = dependencies({ access: [false] });
	await assert.rejects(
		() => runInboxTriageSuggestions(deps, request),
		InboxTriageSuggestionAccessRevokedError,
	);
	assert.equal(calls.readProjection, 0);
	assert.equal(calls.beginUsage.length, 0);
});

test("production runtime sends the normalized request shape accepted by the DO RPC", async () => {
	const normalized = parseInboxTriageSuggestionRequest({
		page: 1,
		visibleEmailIds: ["email-1"],
	});
	let received: unknown;
	let receivedMailbox: unknown;
	const runtime = createInboxTriageSuggestionRuntime(
		{
			BRAND: "wiser",
			AI_CHEAP_MODEL: "cheap-model",
			DB: {},
		} as unknown as Env,
		{
			actorUserId: "user-a",
			mailboxId: "team@example.com",
			stub: {
				getInboxTriageCandidates: async (request: unknown, mailboxId: string) => {
					received = validateNormalizedInboxTriageSuggestionRequest(request);
					receivedMailbox = mailboxId;
					return { state: "stale" as const };
				},
			},
		},
	);
	assert.deepEqual(await runtime.readProjection(normalized), { state: "stale" });
	assert.deepEqual(received, normalized);
	assert.equal(receivedMailbox, "team@example.com");
});
