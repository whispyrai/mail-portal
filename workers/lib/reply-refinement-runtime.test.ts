import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	ReplyRefinementAccessRevokedError,
	runReplyRefinement,
	type ReplyRefinementRuntimeDependencies,
} from "./reply-refinement-runtime.ts";
import { normalizeConversationIntelligenceInput } from "./conversation-intelligence.ts";

const actorUserId = "user-a";
const mailboxId = "team@example.com";

function evidence(text = "Please confirm the launch date by Friday.") {
	return normalizeConversationIntelligenceInput([
		{
			id: "message-1",
			sender: "mona@example.com",
			recipients: [mailboxId],
			sentAt: "2026-07-12T08:00:00.000Z",
			subject: "Launch review",
			text,
		},
	]);
}

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
		evidence?: ReturnType<typeof evidence>[];
		writingPrompts?: string[];
		access?: boolean[];
		cached?: unknown;
		decision?: AiUsageDecision;
		startUsage?: boolean;
		runModel?: ReplyRefinementRuntimeDependencies["runModel"];
	} = {},
) {
	const evidenceQueue = [...(input.evidence ?? [])];
	const writingPromptQueue = [...(input.writingPrompts ?? [])];
	const accessQueue = [...(input.access ?? [])];
	const calls = {
		canAccess: 0,
		readEvidence: 0,
		readWritingPrompt: 0,
		getCached: [] as Array<{ cacheKey: string; cacheScope: string }>,
		putCached: [] as Array<{
			cacheKey: string;
			cacheScope: string;
			value: unknown;
		}>,
		deleteCached: 0,
		beginUsage: [] as unknown[],
		startUsage: 0,
		completeUsage: 0,
		failUsage: [] as unknown[],
		runModel: 0,
	};
	const deps: ReplyRefinementRuntimeDependencies = {
		environment: "test",
		model: "cheap-model",
		canAccess: async () => {
			calls.canAccess += 1;
			return accessQueue.shift() ?? true;
		},
		readEvidence: async () => {
			calls.readEvidence += 1;
			return evidenceQueue.shift() ?? evidence();
		},
		readWritingPrompt: async () => {
			calls.readWritingPrompt += 1;
			return writingPromptQueue.shift() ?? "Write warmly and clearly.";
		},
		getCached: async (cacheKey, cacheScope) => {
			calls.getCached.push({ cacheKey, cacheScope });
			return (input.cached ?? null) as never;
		},
		putCached: async (cacheKey, cacheScope, value) => {
			calls.putCached.push({ cacheKey, cacheScope, value });
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
			return input.startUsage ?? true;
		},
		completeUsage: async () => {
			calls.completeUsage += 1;
		},
		failUsage: async (_reservationId, failure) => {
			calls.failUsage.push(failure);
		},
		runModel: async (...args) => {
			calls.runModel += 1;
			return input.runModel
				? input.runModel(...args)
				: {
						text: JSON.stringify({
							body: "Hi Mona,\n\nFriday works for us.\n\nThanks,",
						}),
						promptTokens: 400,
						completionTokens: 90,
					};
		},
	};
	return { deps, calls };
}

const request = {
	actorUserId,
	mailboxId,
	sourceEmailId: "message-1",
	request: {
		mode: "reply",
		prompt: "Make it concise.",
		currentBody: "Hi Mona,",
		preserveSignature: true,
	},
};

test("generates safe HTML, settles cheap usage, and writes only actor-private cache data", async () => {
	const { deps, calls } = dependencies();
	const result = await runReplyRefinement(deps, request);
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.equal(
		result.result.body,
		"<p>Hi Mona,</p><p>Friday works for us.</p><p>Thanks,</p>",
	);
	assert.equal(result.result.requiresHumanReview, true);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 1);
	assert.match(
		calls.putCached[0]!.cacheScope,
		/reply-refinement:owner:user-a:mailbox:team@example\.com/,
	);
	assert.deepEqual(calls.putCached[0]!.value, {
		fingerprint: result.fingerprint,
		bodyText: "Hi Mona,\n\nFriday works for us.\n\nThanks,",
	});
	assert.equal(
		(calls.beginUsage[0] as { feature?: string }).feature,
		"reply_refinement",
	);
	assert.equal(
		(calls.beginUsage[0] as { estimatedCostMicros?: number })
			.estimatedCostMicros,
		10_000,
	);
});

test("validates a private cache hit, records it, and performs no provider work", async () => {
	const first = dependencies();
	await runReplyRefinement(first.deps, request);
	const cached = first.calls.putCached[0]!.value;
	const { deps, calls } = dependencies({ cached });
	const result = await runReplyRefinement(deps, request);
	assert.equal(result.state, "cached");
	if (result.state === "cached") {
		assert.equal(result.result.requiresHumanReview, true);
	}
	assert.equal(calls.runModel, 0);
	assert.equal(calls.startUsage, 0);
	assert.equal((calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit, true);
	assert.equal(calls.readEvidence, 4);
	assert.equal(calls.readWritingPrompt, 4);
});

test("corrupt cached body fails closed and falls through to generation", async () => {
	const first = dependencies();
	const generated = await runReplyRefinement(first.deps, request);
	assert.equal(generated.state, "generated");
	const { deps, calls } = dependencies({
		cached: {
			fingerprint: generated.state === "generated" ? generated.fingerprint : "",
			bodyText: "Subject: attacker@example.com",
		},
	});
	const result = await runReplyRefinement(deps, request);
	assert.equal(result.state, "generated");
	assert.equal(calls.runModel, 1);
	assert.equal((calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit, false);
});

test("budget pause makes no provider call and preserves freshness", async () => {
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
	assert.deepEqual(await runReplyRefinement(deps, request), {
		state: "budget_paused",
		reason: "admin_review_required",
	});
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
});

test("changed Conversation before cache use returns stale before usage or provider work", async () => {
	const { deps, calls } = dependencies({
		evidence: [evidence(), evidence("The launch moved to Monday.")],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});

test("changed writing prompt before provider start fails the unused reservation", async () => {
	const { deps, calls } = dependencies({
		writingPrompts: [
			"Write warmly and clearly.",
			"Write warmly and clearly.",
			"Write formally.",
		],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.failUsage.length, 1);
	assert.equal(
		(calls.failUsage[0] as { errorCode?: string }).errorCode,
		"reply_refinement_snapshot_changed",
	);
});

test("changed Conversation after inference settles provider cost but never caches", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence("The launch moved to Monday."),
		],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 0);
});

test("changed evidence immediately before cache write never persists stale output", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence("The launch moved to Monday."),
		],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("changed evidence before response evicts the just-written private cache", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence("The launch moved to Monday."),
		],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
	assert.equal(calls.completeUsage, 1);
});

test("access revocation during the provider-boundary reread exposes no mail and fails the reservation", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, true, true, false],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.failUsage.length, 1);
});

test("access revocation while the usage-start write is pending blocks provider dispatch", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, true, true, true, false],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.startUsage, 1);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage.length, 1);
});

test("evidence changed during the usage-start write blocks provider dispatch", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence("The launch moved to Monday."),
		],
	});
	assert.deepEqual(await runReplyRefinement(deps, request), { state: "stale" });
	assert.equal(calls.startUsage, 1);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.failUsage.length, 1);
	assert.equal(
		(calls.failUsage[0] as { errorCode?: string }).errorCode,
		"reply_refinement_snapshot_changed_before_dispatch",
	);
});

test("access revocation before cache use exposes no cached output or ledger event", async () => {
	const first = dependencies();
	await runReplyRefinement(first.deps, request);
	const { deps, calls } = dependencies({
		cached: first.calls.putCached[0]!.value,
		access: [true, true, false],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.getCached.length, 0);
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});

test("access revocation at the cache-hit final boundary exposes no cached output", async () => {
	const first = dependencies();
	await runReplyRefinement(first.deps, request);
	const { deps, calls } = dependencies({
		cached: first.calls.putCached[0]!.value,
		access: [true, true, true, true, true, true, false],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.beginUsage.length, 1);
	assert.equal(
		(calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit,
		true,
	);
});

test("access revocation after inference exposes no output but preserves charged usage", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, true, true, true, true, true, false],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 0);
});

test("access revocation before final response removes the just-written cache", async () => {
	const { deps, calls } = dependencies({
		access: [
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			true,
			false,
		],
	});
	await assert.rejects(
		runReplyRefinement(deps, request),
		ReplyRefinementAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("invalid model output charges observed usage through failure and never caches", async () => {
	const { deps, calls } = dependencies({
		runModel: async () => ({
			text: JSON.stringify({ body: "Subject: unsafe" }),
			promptTokens: 120,
			completionTokens: 20,
		}),
	});
	await assert.rejects(runReplyRefinement(deps, request));
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage.length, 1);
	assert.ok(
		(calls.failUsage[0] as { actualCostMicros?: number }).actualCostMicros,
	);
	assert.equal(calls.putCached.length, 0);
});

test("provider failure fails the started reservation and never caches", async () => {
	const { deps, calls } = dependencies({
		runModel: async () => {
			throw new Error("provider unavailable");
		},
	});
	await assert.rejects(runReplyRefinement(deps, request), /provider unavailable/);
	assert.equal(calls.failUsage.length, 1);
	assert.equal(calls.putCached.length, 0);
});
