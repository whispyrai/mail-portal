import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	ConversationAnswerAccessRevokedError,
	runConversationAnswer,
	type ConversationAnswerRuntimeDependencies,
} from "./conversation-answer-runtime.ts";
import { ConversationIntelligenceNotFoundError } from "./conversation-intelligence-runtime.ts";
import { normalizeConversationIntelligenceInput } from "./conversation-intelligence.ts";

const actorUserId = "user-a";
const mailboxId = "team@example.com";

function evidence(text = "The launch review is confirmed for Friday.") {
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

function validOutput() {
	return JSON.stringify({
		state: "answered",
		claims: [
			{
				text: "The launch review is confirmed for Friday.",
				messageIds: ["message-1"],
			},
		],
	});
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
		evidence?: Array<ReturnType<typeof evidence> | Error>;
		access?: boolean[];
		cached?: unknown;
		decision?: AiUsageDecision;
		startUsage?: boolean;
		runModel?: ConversationAnswerRuntimeDependencies["runModel"];
	} = {},
) {
	const evidenceQueue = [...(input.evidence ?? [evidence()])];
	const accessQueue = [...(input.access ?? [])];
	const calls = {
		canAccess: 0,
		readEvidence: 0,
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
	const deps: ConversationAnswerRuntimeDependencies = {
		environment: "test",
		model: "cheap-model",
		canAccess: async () => {
			calls.canAccess += 1;
			return accessQueue.shift() ?? true;
		},
		readEvidence: async () => {
			calls.readEvidence += 1;
			const next = evidenceQueue.shift() ?? evidence();
			if (next instanceof Error) throw next;
			return next;
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
				: { text: validOutput(), promptTokens: 300, completionTokens: 80 };
		},
	};
	return { deps, calls };
}

const request = {
	actorUserId,
	mailboxId,
	emailId: "message-1",
	question: "When is the launch review?",
};

test("generates a cited answer and writes only to an actor-private cache", async () => {
	const { deps, calls } = dependencies();
	const result = await runConversationAnswer(deps, request);
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.equal(result.result.state, "answered");
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 1);
	assert.match(
		calls.putCached[0]!.cacheScope,
		/conversation-answer:owner:user-a:mailbox:team@example\.com/,
	);
	assert.equal(
		(calls.beginUsage[0] as { feature?: string }).feature,
		"conversation_answer",
	);
});

test("validates and rechecks a private cache hit before returning it", async () => {
	const first = dependencies();
	const generated = await runConversationAnswer(first.deps, request);
	assert.equal(generated.state, "generated");
	assert.equal(first.calls.putCached.length, 1);
	const cachedValue = first.calls.putCached[0]!.value;
	const { deps, calls } = dependencies({ cached: cachedValue });
	const result = await runConversationAnswer(deps, request);
	assert.equal(result.state, "cached");
	assert.equal(calls.runModel, 0);
	assert.equal(calls.readEvidence, 3);
	assert.equal((calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit, true);
});

test("corrupt cached output fails closed and falls through to paid generation", async () => {
	const initial = dependencies();
	await runConversationAnswer(initial.deps, request);
	const cached = initial.calls.putCached[0]!.value as {
		fingerprint: string;
	};
	const { deps, calls } = dependencies({
		cached: {
			fingerprint: cached.fingerprint,
			result: {
				state: "answered",
				claims: [{ text: "Unsupported", messageIds: ["unknown-message"] }],
			},
		},
	});
	const result = await runConversationAnswer(deps, request);
	assert.equal(result.state, "generated");
	assert.equal(calls.runModel, 1);
	assert.equal((calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit, false);
});

test("budget pause performs no provider call and still checks final freshness", async () => {
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
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, {
		state: "budget_paused",
		reason: "admin_review_required",
	});
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.readEvidence, 2);
});

test("fails the unused reservation when evidence changes before provider start", async () => {
	const { deps, calls } = dependencies({
		evidence: [evidence(), evidence("The review moved to Monday.")],
	});
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage.length, 1);
	assert.equal(
		(calls.failUsage[0] as { errorCode?: string }).errorCode,
		"conversation_answer_snapshot_changed",
	);
});

test("settles provider usage but never caches when evidence changes after inference", async () => {
	const { deps, calls } = dependencies({
		evidence: [evidence(), evidence(), evidence("The review moved to Monday.")],
	});
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 0);
});

test("a conversation that disappears after inference returns stale and is never cached", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			new ConversationIntelligenceNotFoundError(),
		],
	});
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("rechecks immediately before cache write and does not persist stale output", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence("The review moved to Monday."),
		],
	});
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("evicts a just-written answer if evidence changes before final response", async () => {
	const { deps, calls } = dependencies({
		evidence: [
			evidence(),
			evidence(),
			evidence(),
			evidence(),
			evidence("The review moved to Monday."),
		],
	});
	const result = await runConversationAnswer(deps, request);
	assert.deepEqual(result, { state: "stale" });
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
	assert.equal(calls.completeUsage, 1);
});

test("access revocation after inference exposes no answer but preserves charged usage", async () => {
	const { deps, calls } = dependencies({ access: [true, true, true, false] });
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 0);
});

test("access revocation before provider start fails the unused reservation", async () => {
	const { deps, calls } = dependencies({ access: [true, false] });
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage.length, 1);
});

test("revocation during the provider-boundary evidence reread exposes no mail", async () => {
	const { deps, calls } = dependencies({ access: [true, true, false] });
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.readEvidence, 2);
	assert.equal(calls.startUsage, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.failUsage.length, 1);
});

test("access revocation before cache write preserves charged usage without persistence", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, true, true, false],
	});
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage.length, 0);
	assert.equal(calls.putCached.length, 0);
});

test("access revocation before final response removes the just-written private cache", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, true, true, true, true, false],
	});
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.deleteCached, 1);
});

test("access revocation at the cache boundary exposes no cached answer", async () => {
	const first = dependencies();
	await runConversationAnswer(first.deps, request);
	const { deps, calls } = dependencies({
		cached: first.calls.putCached[0]!.value,
		access: [true, false],
	});
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.beginUsage.length, 0);
});

test("access revocation at the cache-hit final boundary exposes no cached answer", async () => {
	const first = dependencies();
	await runConversationAnswer(first.deps, request);
	const { deps, calls } = dependencies({
		cached: first.calls.putCached[0]!.value,
		access: [true, true, true, false],
	});
	await assert.rejects(
		runConversationAnswer(deps, request),
		ConversationAnswerAccessRevokedError,
	);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.beginUsage.length, 1);
});

test("invalid provider output is charged through a failed usage and never cached", async () => {
	const { deps, calls } = dependencies({
		runModel: async () => ({
			text: JSON.stringify({
				state: "answered",
				claims: [{ text: "No citation", messageIds: [] }],
			}),
			promptTokens: 120,
			completionTokens: 20,
		}),
	});
	await assert.rejects(runConversationAnswer(deps, request));
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
	await assert.rejects(
		runConversationAnswer(deps, request),
		/provider unavailable/,
	);
	assert.equal(calls.failUsage.length, 1);
	assert.equal(calls.putCached.length, 0);
});
