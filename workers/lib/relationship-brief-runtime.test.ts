import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import type { RelationshipBriefEvidenceProjection } from "./relationship-brief-evidence.ts";
import {
	RelationshipBriefAccessRevokedError,
	runRelationshipBrief,
	type RelationshipBriefRuntimeDependencies,
} from "./relationship-brief-runtime.ts";

const projection: Extract<RelationshipBriefEvidenceProjection, { state: "ready" }> = {
	state: "ready",
	person: { id: "person-1", address: "client@example.com", displayName: "Client" },
	messages: [
		{
			id: "message-them",
			conversationId: "conversation-1",
			folderId: "inbox",
			direction: "received",
			role: "from",
			sentAt: "2026-07-11T10:00:00.000Z",
			subject: "Question",
			text: "Can you send the signed proposal?",
		},
		{
			id: "message-us",
			conversationId: "conversation-1",
			folderId: "sent",
			direction: "sent",
			role: "to",
			sentAt: "2026-07-12T10:00:00.000Z",
			subject: "Re: Question",
			text: "We committed to reply by Friday.",
		},
	],
};

const modelOutput = {
	topics: [{ text: "Proposal review", messageIds: ["message-them", "message-us"] }],
	openQuestions: [{ askedBy: "them", text: "They asked for the signed proposal.", messageIds: ["message-them"] }],
	commitments: [{ madeBy: "us", text: "We committed to reply by Friday.", messageIds: ["message-us"] }],
	importantConversations: [{ reason: "The proposal is active.", messageIds: ["message-us"] }],
	suggestedNextStep: { text: "Review the proposal before following up.", messageIds: ["message-us"], requiresHumanReview: true },
	requiresHumanReview: true,
};

function allowedDecision(): AiUsageDecision {
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

function fixture(input: {
	projection?: RelationshipBriefEvidenceProjection | { state: "building"; processedMessages: number; retryAfterMs: number };
	changedAtRead?: number;
	revokeAtAccess?: number;
	cached?: unknown;
	cacheReadFails?: boolean;
	cacheWriteFails?: boolean;
	claim?: boolean;
	decision?: AiUsageDecision;
	modelText?: string;
	beginUsageFails?: boolean;
		startUsageAllowed?: boolean;
		completeUsageFails?: boolean;
		failAtRead?: number;
		claimResults?: Array<boolean | Error>;
		renewalDuringModel?: boolean | Error;
		claimRenewalIntervalMs?: number;
		modelDelayMs?: number;
		modelNeverResolves?: boolean;
		modelTimeoutMs?: number;
	} = {}) {
	let reads = 0;
	let accessReads = 0;
	const calls = {
		getCached: 0,
		putCached: [] as unknown[],
		cacheScopes: [] as string[],
		deleteCached: 0,
		claim: 0,
		release: 0,
		beginUsage: [] as BeginUsageRecord[],
		startUsage: 0,
		completeUsage: 0,
		failUsage: 0,
		failUsageCodes: [] as string[],
		runModel: 0,
	};
	type BeginUsageRecord = { feature: string; cacheHit?: boolean; estimatedCostMicros: number };
	const deps: RelationshipBriefRuntimeDependencies = {
		environment: "test",
		model: "cheap-model",
		canAccess: async () => {
			accessReads += 1;
			return input.revokeAtAccess === undefined || accessReads < input.revokeAtAccess;
		},
		readProjection: async () => {
			reads += 1;
			if (input.failAtRead === reads) throw new Error("snapshot read failed");
			const value = structuredClone(input.projection ?? projection);
			if (input.changedAtRead !== undefined && reads >= input.changedAtRead && value.state === "ready") {
				value.messages[0]!.text = "Changed evidence";
			}
			return value;
		},
		getCached: async (_key, scope) => {
			calls.getCached += 1;
			calls.cacheScopes.push(scope);
			if (input.cacheReadFails) throw new Error("cache unavailable");
			return (input.cached ?? null) as never;
		},
		putCached: async (_key, scope, value) => {
			calls.cacheScopes.push(scope);
			if (input.cacheWriteFails) throw new Error("cache unavailable");
			calls.putCached.push(value);
		},
		deleteCached: async () => { calls.deleteCached += 1; },
		claimGeneration: async () => {
			calls.claim += 1;
			if (calls.runModel > 0 && input.renewalDuringModel !== undefined) {
				if (input.renewalDuringModel instanceof Error) throw input.renewalDuringModel;
				return input.renewalDuringModel;
			}
			const result = input.claimResults?.[calls.claim - 1];
			if (result instanceof Error) throw result;
			return result ?? input.claim ?? true;
		},
		releaseGeneration: async () => { calls.release += 1; },
		beginUsage: async (usage) => {
			calls.beginUsage.push(usage as BeginUsageRecord);
			if (input.beginUsageFails) throw new Error("cost ledger unavailable");
			return input.decision ?? allowedDecision();
		},
		startUsage: async () => { calls.startUsage += 1; return input.startUsageAllowed ?? true; },
		completeUsage: async () => {
			calls.completeUsage += 1;
			if (input.completeUsageFails) throw new Error("cost completion unavailable");
		},
		failUsage: async (_reservationId, failure) => {
			calls.failUsage += 1;
			calls.failUsageCodes.push(failure.errorCode);
		},
		runModel: async () => {
			calls.runModel += 1;
			if (input.modelNeverResolves) return await new Promise<never>(() => undefined);
			if (input.modelDelayMs) {
				await new Promise((resolve) => setTimeout(resolve, input.modelDelayMs));
			}
			return {
				text: input.modelText ?? JSON.stringify(modelOutput),
				promptTokens: 500,
				completionTokens: 100,
			};
		},
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
		claimRenewalIntervalMs: input.claimRenewalIntervalMs,
		modelTimeoutMs: input.modelTimeoutMs,
	};
	return { deps, calls };
}

const request = {
	actorUserId: "user-a",
	mailboxId: "team@example.com",
	personId: "person-1",
	refresh: false,
};

test("manual generation is cheap-tier, cited, costed once, and cached actor-private", async () => {
	const { deps, calls } = fixture();
	const result = await runRelationshipBrief(deps, request);
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.equal(result.brief.requiresHumanReview, true);
	assert.equal(result.brief.suggestedNextStep.requiresHumanReview, true);
	assert.deepEqual(result.brief.topics[0]?.citations.map((item) => item.messageId), ["message-them", "message-us"]);
	assert.equal(calls.runModel, 1);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.beginUsage[0]?.feature, "relationship_brief");
	assert.ok(calls.cacheScopes.every((scope) => scope.includes("owner:user-a") && scope.includes("person:person-1")));
});

test("current valid cache avoids claims/provider while refresh bypasses cache", async () => {
	const first = fixture();
	await runRelationshipBrief(first.deps, request);
	const cached = first.calls.putCached[0];
	const normal = fixture({ cached });
	const cachedResult = await runRelationshipBrief(normal.deps, request);
	assert.equal(cachedResult.state, "cached");
	assert.equal(normal.calls.claim, 0);
	assert.equal(normal.calls.runModel, 0);
	assert.equal(normal.calls.beginUsage[0]?.cacheHit, true);

	const refresh = fixture({ cached });
	const refreshed = await runRelationshipBrief(refresh.deps, { ...request, refresh: true });
	assert.equal(refreshed.state, "generated");
	assert.equal(refresh.calls.getCached, 0);
	assert.equal(refresh.calls.runModel, 1);
});

test("normal cached reads and simultaneous refreshes never coalesce across refresh semantics", async () => {
	const seeded = fixture();
	await runRelationshipBrief(seeded.deps, request);
	const shared = fixture({ cached: seeded.calls.putCached[0] });
	const [normal, refresh] = await Promise.all([
		runRelationshipBrief(shared.deps, request),
		runRelationshipBrief(shared.deps, { ...request, refresh: true }),
	]);
	assert.equal(normal.state, "cached");
	assert.equal(refresh.state, "generated");
	assert.equal(shared.calls.runModel, 1);
});

test("identical simultaneous refreshes coalesce one claim, reservation, and provider call", async () => {
	const shared = fixture();
	const [first, second] = await Promise.all([
		runRelationshipBrief(shared.deps, { ...request, refresh: true }),
		runRelationshipBrief(shared.deps, { ...request, refresh: true }),
	]);
	assert.equal(first.state, "generated");
	assert.deepEqual(second, first);
	assert.ok(shared.calls.claim >= 4);
	assert.equal(shared.calls.beginUsage.length, 1);
	assert.equal(shared.calls.runModel, 1);
});

test("lease loss after reservation settles it before provider dispatch", async () => {
	const { deps, calls } = fixture({ claimResults: [true, true, false] });
	const result = await runRelationshipBrief(deps, { ...request, refresh: true });
	assert.equal(result.state, "preparing");
	assert.equal(calls.beginUsage.length, 1);
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.failUsage, 1);
	assert.deepEqual(calls.failUsageCodes, ["relationship_brief_generation_lease_lost"]);
	assert.equal(calls.putCached.length, 0);
});

test("a lost or failed interval renewal fences provider output after truthful usage settlement", async () => {
	for (const lost of [false, new Error("renewal unavailable")]) {
		const { deps, calls } = fixture({
			renewalDuringModel: lost,
			claimRenewalIntervalMs: 1,
			modelDelayMs: 15,
		});
		const result = await runRelationshipBrief(deps, { ...request, refresh: true });
		assert.equal(result.state, "preparing");
		assert.equal(calls.runModel, 1);
		assert.equal(calls.completeUsage, 1);
		assert.equal(calls.failUsage, 0);
		assert.equal(calls.putCached.length, 0);
	}
});

test("an expired-owner takeover after inference suppresses output before persistence", async () => {
	const { deps, calls } = fixture({
		claimResults: [true, true, true, true, false],
	});
	const result = await runRelationshipBrief(deps, { ...request, refresh: true });
	assert.equal(result.state, "preparing");
	assert.equal(calls.runModel, 1);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("a final lease boundary evicts output persisted just before takeover", async () => {
	const { deps, calls } = fixture({
		claimResults: [true, true, true, true, true, true, false],
	});
	const result = await runRelationshipBrief(deps, { ...request, refresh: true });
	assert.equal(result.state, "preparing");
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("an unabortable provider timeout settles failure and leaves the claim to expire", async () => {
	const { deps, calls } = fixture({
		modelNeverResolves: true,
		modelTimeoutMs: 5,
	});
	const result = await runRelationshipBrief(deps, { ...request, refresh: true });
	assert.equal(result.state, "preparing");
	assert.equal(calls.runModel, 1);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage, 1);
	assert.deepEqual(calls.failUsageCodes, ["relationship_brief_model_timeout"]);
	assert.equal(calls.putCached.length, 0);
	assert.equal(calls.release, 0);
});

test("projection preparation, missing People, claim contention, and budget pause perform no provider work", async () => {
	const cases = [
		{ fixture: fixture({ projection: { state: "building", processedMessages: 100, retryAfterMs: 750 } }), state: "preparing" },
		{ fixture: fixture({ projection: { state: "not_found" } }), state: "unavailable" },
		{ fixture: fixture({ claim: false }), state: "preparing" },
		{ fixture: fixture({ decision: {
			decision: "block", reason: "admin_review_required", reviewRequired: true,
			fallback: "deterministic_only", tier: "cheap", model: "cheap-model", ledgerRecorded: true,
		} }), state: "budget_paused" },
	];
	for (const item of cases) {
		const result = await runRelationshipBrief(item.fixture.deps, request);
		assert.equal(result.state, item.state);
		assert.equal(item.fixture.calls.runModel, 0);
	}
});

test("stale evidence after provider or cache persistence exposes no brief and evicts a just-written cache", async () => {
	const afterProvider = fixture({ changedAtRead: 7 });
	assert.equal((await runRelationshipBrief(afterProvider.deps, request)).state, "stale");
	assert.equal(afterProvider.calls.completeUsage, 1);
	assert.equal(afterProvider.calls.putCached.length, 0);

	const afterCache = fixture({ changedAtRead: 8 });
	assert.equal((await runRelationshipBrief(afterCache.deps, request)).state, "stale");
	assert.equal(afterCache.calls.putCached.length, 1);
	assert.equal(afterCache.calls.deleteCached, 1);
});

test("in-flight access revocation after cache write evicts it and returns no result", async () => {
	const { deps, calls } = fixture({ revokeAtAccess: 16 });
	await assert.rejects(() => runRelationshipBrief(deps, request), RelationshipBriefAccessRevokedError);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("a final post-persist snapshot read failure evicts the just-written cache", async () => {
	const { deps, calls } = fixture({ failAtRead: 8 });
	await assert.rejects(() => runRelationshipBrief(deps, request), /snapshot read failed/i);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("forged provider citations fail usage and cache outages preserve safe generation semantics", async () => {
	const forged = structuredClone(modelOutput);
	forged.topics[0]!.messageIds = ["forged-message"];
	const invalid = fixture({ modelText: JSON.stringify(forged) });
	await assert.rejects(() => runRelationshipBrief(invalid.deps, request));
	assert.equal(invalid.calls.failUsage, 1);
	assert.equal(invalid.calls.putCached.length, 0);

	const cacheFailure = fixture({ cacheReadFails: true, cacheWriteFails: true });
	assert.equal((await runRelationshipBrief(cacheFailure.deps, request)).state, "generated");
	assert.equal(cacheFailure.calls.runModel, 1);
	assert.equal(cacheFailure.calls.completeUsage, 1);
});

test("cost reservation and settlement failures never dispatch twice or cache ambiguous output", async () => {
	const ledger = fixture({ beginUsageFails: true });
	await assert.rejects(() => runRelationshipBrief(ledger.deps, request), /ledger/i);
	assert.equal(ledger.calls.runModel, 0);
	assert.equal(ledger.calls.putCached.length, 0);

	const start = fixture({ startUsageAllowed: false });
	await assert.rejects(() => runRelationshipBrief(start.deps, request), /reservation/i);
	assert.equal(start.calls.runModel, 0);
	assert.equal(start.calls.failUsage, 1);

	const completion = fixture({ completeUsageFails: true });
	await assert.rejects(() => runRelationshipBrief(completion.deps, request), /completion/i);
	assert.equal(completion.calls.runModel, 1);
	assert.equal(completion.calls.failUsage, 1);
	assert.equal(completion.calls.putCached.length, 0);
});

test("revoked access fails before mail, cache, claims, cost, or provider", async () => {
	const { deps, calls } = fixture({ revokeAtAccess: 1 });
	await assert.rejects(() => runRelationshipBrief(deps, request), RelationshipBriefAccessRevokedError);
	assert.equal(calls.getCached, 0);
	assert.equal(calls.claim, 0);
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});
