import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTodayBriefInput } from "../../shared/today-brief.ts";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	hasUnloadedDueReminderRisk,
	runTodayBrief,
	type TodayBriefRuntimeDependencies,
	type TodayBriefSnapshot,
} from "./today-brief-runtime.ts";

test("future reminder pages do not disable a complete due-today snapshot", () => {
	assert.equal(
		hasUnloadedDueReminderRisk(
			[{ remindAt: "2026-07-13T09:00:00.000Z" }],
			"next-page",
			"2026-07-12T21:00:00.000Z",
		),
		false,
	);
	assert.equal(
		hasUnloadedDueReminderRisk(
			[{ remindAt: "2026-07-12T08:00:00.000Z" }],
			"next-page",
			"2026-07-12T21:00:00.000Z",
		),
		true,
	);
});

const actorUserId = "user-a";
const mailboxId = "team@example.com";

function snapshot(overrides: Partial<TodayBriefSnapshot> = {}): TodayBriefSnapshot {
	return {
		input: normalizeTodayBriefInput({
			actorUserId,
			mailboxId,
			localDate: "2026-07-12",
			timezone: "Africa/Cairo",
			omittedCount: 0,
			candidates: [
				{
					id: "focus-01",
					conversationKey: "thread-1",
					sourceEmailId: "mail-2",
					subject: "Launch review",
					counterparty: "Mona <mona@example.com>",
					reasons: ["today_reminder", "unread_in_mailbox"],
					reminder: {
						id: "reminder-1",
						version: 2,
						state: "active",
						dueAt: "2026-07-12T08:00:00.000Z",
					},
					remindAt: "2026-07-12T08:00:00.000Z",
					unreadInMailbox: true,
					messages: [
						{
							id: "mail-2",
							date: "2026-07-12T07:00:00.000Z",
							folderId: "inbox",
							sender: "mona@example.com",
							subject: "Launch review",
							text: "Please confirm the final launch checklist today.",
						},
					],
				},
			],
		}),
		fingerprint: "fingerprint-1",
		counts: { privateRemindersDue: 1, unreadConversations: 1 },
		...overrides,
	};
}

function validOutput() {
	return JSON.stringify({
		items: [
			{
				candidateId: "focus-01",
				rank: 1,
				whyNow: "unread_request",
				suggestedNextStep: "prepare_reply",
				messageIds: ["mail-2"],
				requiresHumanReview: true,
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

function dependencies(input: {
	snapshots?: TodayBriefSnapshot[];
	access?: boolean[];
	cached?: unknown | unknown[];
	decision?: AiUsageDecision;
	claimGeneration?: boolean;
	runModel?: TodayBriefRuntimeDependencies["runModel"];
} = {}) {
	const snapshots = [...(input.snapshots ?? [snapshot(), snapshot()])];
	const access = [...(input.access ?? [true, true])];
	const cachedValues = Array.isArray(input.cached)
		? [...input.cached]
		: [input.cached ?? null];
	const calls = {
		readSnapshot: 0,
		canAccess: 0,
		getCached: [] as Array<{ cacheKey: string; cacheScope: string }>,
		putCached: [] as Array<{ cacheKey: string; cacheScope: string; value: unknown }>,
		claimGeneration: 0,
		releaseGeneration: 0,
		beginUsage: [] as unknown[],
		startUsage: 0,
		completeUsage: 0,
		failUsage: 0,
		runModel: 0,
	};
	const deps: TodayBriefRuntimeDependencies = {
		model: "cheap-model",
		readSnapshot: async () => {
			calls.readSnapshot += 1;
			return snapshots.shift() ?? snapshot();
		},
		canAccess: async () => {
			calls.canAccess += 1;
			return access.shift() ?? true;
		},
		getCached: async (cacheKey, cacheScope) => {
			calls.getCached.push({ cacheKey, cacheScope });
			return (cachedValues.shift() ?? null) as never;
		},
		putCached: async (cacheKey, cacheScope, value) => {
			calls.putCached.push({ cacheKey, cacheScope, value });
		},
		claimGeneration: async () => {
			calls.claimGeneration += 1;
			return input.claimGeneration ?? true;
		},
		releaseGeneration: async () => {
			calls.releaseGeneration += 1;
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
			return input.runModel
				? input.runModel(...args)
				: { text: validOutput(), promptTokens: 500, completionTokens: 100 };
		},
		now: () => Date.parse("2026-07-12T07:30:00.000Z"),
	};
	return { deps, calls };
}

test("returns deterministic no-attention without cache, ledger, or model work", async () => {
	const empty = snapshot({
		input: normalizeTodayBriefInput({
			actorUserId,
			mailboxId,
			localDate: "2026-07-12",
			timezone: "Africa/Cairo",
			omittedCount: 0,
			candidates: [],
		}),
		counts: { privateRemindersDue: 0, unreadConversations: 0 },
	});
	const { deps, calls } = dependencies({ snapshots: [empty] });
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.deepEqual(result, {
		state: "no_attention",
		counts: { privateRemindersDue: 0, unreadConversations: 0 },
		omittedCount: 0,
	});
	assert.equal(calls.getCached.length, 0);
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
});

test("generates, revalidates, joins server metadata, and writes an actor-private cache", async () => {
	const { deps, calls } = dependencies();
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.equal(result.state, "generated");
	if (result.state !== "generated") return;
	assert.equal(result.items[0]?.candidate.sourceEmailId, "mail-2");
	assert.deepEqual(result.items[0]?.candidate.reasons, [
		"today_reminder",
		"unread_in_mailbox",
	]);
	assert.equal(result.items[0]?.requiresHumanReview, true);
	assert.equal(calls.readSnapshot, 3);
	assert.equal(calls.completeUsage, 1);
	assert.equal(calls.failUsage, 0);
	assert.equal(calls.putCached.length, 1);
	assert.equal(calls.claimGeneration, 1);
	assert.equal(calls.releaseGeneration, 1);
	assert.match(calls.putCached[0]!.cacheScope, /owner:user-a:mailbox:team@example\.com/);
});

test("validates and reauthorizes an actor-private cache hit without inference", async () => {
	const { deps, calls } = dependencies({
		cached: {
			fingerprint: "fingerprint-1",
			generatedAt: "2026-07-12T07:00:00.000Z",
			result: JSON.parse(validOutput()),
		},
	});
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.equal(result.state, "cached");
	assert.equal(calls.runModel, 0);
	assert.equal(calls.readSnapshot, 2);
	assert.equal(
		(calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit,
		true,
	);
	assert.match(calls.getCached[0]!.cacheScope, /owner:user-a/);
});

test("never serves or caches guidance when the authoritative snapshot changes", async () => {
	const { deps, calls } = dependencies({
		snapshots: [snapshot(), snapshot({ fingerprint: "fingerprint-2" })],
	});
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.equal(result.state, "stale");
	assert.equal(calls.putCached.length, 0);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.runModel, 0);
});

test("budget pause preserves deterministic counts and performs no provider call", async () => {
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
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.deepEqual(result, {
		state: "budget_paused",
		reason: "admin_review_required",
		counts: { privateRemindersDue: 1, unreadConversations: 1 },
		omittedCount: 0,
	});
	assert.equal(calls.runModel, 0);
	assert.equal(calls.startUsage, 0);
});

test("a distributed claim held by another isolate returns non-destructive preparing state", async () => {
	const { deps, calls } = dependencies({ claimGeneration: false });
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.deepEqual(result, {
		state: "preparing",
		counts: { privateRemindersDue: 1, unreadConversations: 1 },
		omittedCount: 0,
	});
	assert.equal(calls.beginUsage.length, 0);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.releaseGeneration, 0);
});

test("rechecks cache after a distributed claim handoff before reserving inference", async () => {
	const cached = {
		fingerprint: "fingerprint-1",
		generatedAt: "2026-07-12T07:00:00.000Z",
		result: JSON.parse(validOutput()),
	};
	const { deps, calls } = dependencies({ cached: [null, cached] });
	const result = await runTodayBrief(deps, { actorUserId, mailboxId });
	assert.equal(result.state, "cached");
	assert.equal(calls.claimGeneration, 1);
	assert.equal(calls.releaseGeneration, 1);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.beginUsage.length, 1);
	assert.equal(
		(calls.beginUsage[0] as { cacheHit?: boolean }).cacheHit,
		true,
	);
});

test("membership revocation before provider start returns no counts or guidance", async () => {
	const { deps, calls } = dependencies({
		access: [true, true, true, false],
	});
	await assert.rejects(
		runTodayBrief(deps, { actorUserId, mailboxId }),
		/access was revoked/,
	);
	assert.equal(calls.runModel, 0);
	assert.equal(calls.completeUsage, 0);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("invalid output fails the reservation and never persists guidance", async () => {
	const { deps, calls } = dependencies({
		runModel: async () => ({
			text: JSON.stringify({ items: [] }),
			promptTokens: 100,
			completionTokens: 10,
		}),
	});
	await assert.rejects(
		runTodayBrief(deps, { actorUserId, mailboxId }),
		/coverage/,
	);
	assert.equal(calls.failUsage, 1);
	assert.equal(calls.putCached.length, 0);
});

test("coalesces concurrent identical misses into one reservation and provider call", async () => {
	let release!: () => void;
	let markStarted!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const { deps, calls } = dependencies({
		runModel: async () => {
			markStarted();
			await gate;
			return { text: validOutput(), promptTokens: 100, completionTokens: 10 };
		},
		snapshots: [snapshot(), snapshot(), snapshot()],
		access: [true, true, true],
	});
	const first = runTodayBrief(deps, { actorUserId, mailboxId });
	const second = runTodayBrief(deps, { actorUserId, mailboxId });
	await started;
	assert.equal(calls.runModel, 1);
	release();
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left.state, "generated");
	assert.equal(right.state, "generated");
	assert.equal(calls.getCached.length, 2);
	assert.deepEqual(
		calls.beginUsage.map((usage) => (usage as { cacheHit?: boolean }).cacheHit),
		[false],
	);
	assert.equal(calls.runModel, 1);
});
