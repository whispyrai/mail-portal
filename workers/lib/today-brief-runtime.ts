import {
	normalizeTodayBriefInput,
	type NormalizedTodayBriefInput,
	type TodayBriefCandidateInput,
	type TodayBriefCandidateReason,
	type TodayBriefGeneratedResult,
} from "../../shared/today-brief.ts";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import type { Env } from "../types.ts";
import {
	calculateAiUsageCostMicros,
	resolveAiCostControlConfig,
	type AiUsageDecision,
	type BeginAiUsageInput,
} from "./ai-cost-control.ts";
import {
	createAiCostController,
	getCachedAiResponse,
	putCachedAiResponse,
} from "./ai-cost-control-d1.ts";
import { mailboxAccess } from "./mailbox-access.ts";
import { followUpReminderService } from "./follow-up-reminders-d1.ts";
import type { TodayBriefCandidateProjection } from "./today-brief-candidates.ts";
import type { TodayBriefDayBoundary } from "./today-brief-timezone.ts";
import {
	TODAY_BRIEF_AI_CONFIG,
	buildTodayBriefCacheKey,
	buildTodayBriefModelMessages,
	fingerprintTodayBriefInput,
	parseTodayBriefOutput,
} from "./today-brief.ts";

const CACHE_TTL_MS = 48 * 60 * 60 * 1_000;
const GENERATION_CLAIM_TTL_MS = 2 * 60 * 1_000;

export type TodayBriefCounts = {
	privateRemindersDue: number;
	unreadConversations: number;
};

export type TodayBriefResponseCandidate = {
	candidateId: string;
	sourceEmailId: string;
	subject: string;
	counterparty: string;
	reasons: TodayBriefCandidateReason[];
	remindAt?: string;
};

export type TodayBriefRuntimeResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			generatedAt: string;
			counts: TodayBriefCounts;
			omittedCount: number;
			items: Array<{
				candidate: TodayBriefResponseCandidate;
				whyNow: string;
				suggestedNextStep: string;
				messageIds: string[];
				requiresHumanReview: true;
			}>;
	  }
	| { state: "no_attention"; counts: TodayBriefCounts; omittedCount: 0 }
	| {
			state: "budget_paused";
			reason: string;
			counts: TodayBriefCounts;
			omittedCount: number;
	  }
	| { state: "preparing"; counts: TodayBriefCounts; omittedCount: number }
	| { state: "stale"; counts: TodayBriefCounts; omittedCount: number };

export type TodayBriefSnapshot = {
	input: NormalizedTodayBriefInput;
	fingerprint: string;
	counts: TodayBriefCounts;
};

type CachedTodayBrief = {
	fingerprint: string;
	generatedAt: string;
	result: TodayBriefGeneratedResult;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export interface TodayBriefRuntimeDependencies {
	model: string;
	readSnapshot(): Promise<TodayBriefSnapshot>;
	canAccess(): Promise<boolean>;
	getCached(cacheKey: string, cacheScope: string): Promise<CachedTodayBrief | null>;
	putCached(
		cacheKey: string,
		cacheScope: string,
		value: CachedTodayBrief,
	): Promise<void>;
	claimGeneration(
		cacheKey: string,
		claimToken: string,
		expiresAt: number,
	): Promise<boolean>;
	releaseGeneration(cacheKey: string, claimToken: string): Promise<unknown>;
	beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision>;
	startUsage(reservationId: string): Promise<boolean>;
	completeUsage(
		reservationId: string,
		actual: {
			actualCostMicros: number;
			promptTokens: number;
			completionTokens: number;
		},
	): Promise<unknown>;
	failUsage(
		reservationId: string,
		failure: {
			errorCode: string;
			actualCostMicros?: number;
			promptTokens: number;
			completionTokens: number;
		},
	): Promise<unknown>;
	runModel(model: string, messages: ReturnType<typeof buildTodayBriefModelMessages>): Promise<ModelResult>;
	now?(): number;
}

export type RunTodayBriefInput = {
	actorUserId: string;
	mailboxId: string;
	requestScope?: string;
};

export function hasUnloadedDueReminderRisk(
	reminders: readonly Pick<FollowUpReminder, "remindAt">[],
	nextCursor: string | null,
	dayEndAt: string,
): boolean {
	if (!nextCursor) return false;
	const lastReminder = reminders.at(-1);
	const dayEnd = Date.parse(dayEndAt);
	const lastDue = lastReminder ? Date.parse(lastReminder.remindAt) : Number.NaN;
	if (!Number.isFinite(dayEnd) || !Number.isFinite(lastDue)) return true;
	// Reminder pages are authoritative chronological order. Once the last row
	// is outside today's boundary, every unloaded row is later and irrelevant.
	return lastDue < dayEnd;
}

const inFlight = new Map<string, Promise<TodayBriefRuntimeResponse>>();
const requestInFlight = new Map<string, Promise<TodayBriefRuntimeResponse>>();

function privateCacheScope(actorUserId: string, mailboxId: string) {
	return `today-brief:owner:${actorUserId.trim().toLowerCase()}:mailbox:${mailboxId
		.trim()
		.toLowerCase()}`;
}

function responseCandidate(candidate: NormalizedTodayBriefInput["candidates"][number]) {
	return {
		candidateId: candidate.id,
		sourceEmailId: candidate.sourceEmailId,
		subject: candidate.subject,
		counterparty: candidate.counterparty,
		reasons: [...candidate.reasons],
		...(candidate.remindAt ? { remindAt: candidate.remindAt } : {}),
	} satisfies TodayBriefResponseCandidate;
}

function generatedResponse(
	state: "cached" | "generated",
	snapshot: TodayBriefSnapshot,
	payload: CachedTodayBrief,
): TodayBriefRuntimeResponse {
	const candidates = new Map(
		snapshot.input.candidates.map((candidate) => [candidate.id, candidate]),
	);
	return {
		state,
		fingerprint: snapshot.fingerprint,
		generatedAt: payload.generatedAt,
		counts: snapshot.counts,
		omittedCount: snapshot.input.omittedCount,
		items: payload.result.items.map((item) => {
			const candidate = candidates.get(item.candidateId);
			if (!candidate) throw new Error("Validated Today brief candidate is unavailable");
			return {
				candidate: responseCandidate(candidate),
				whyNow: item.whyNow,
				suggestedNextStep: item.suggestedNextStep,
				messageIds: [...item.messageIds],
				requiresHumanReview: true,
			};
		}),
	};
}

async function snapshotStillCurrent(
	dependencies: TodayBriefRuntimeDependencies,
	expected: TodayBriefSnapshot,
) {
	if (!(await dependencies.canAccess())) {
		throw new Error("Mailbox access was revoked");
	}
	const current = await dependencies.readSnapshot();
	return current.fingerprint === expected.fingerprint ? current : null;
}

async function generateTodayBrief(
	dependencies: TodayBriefRuntimeDependencies,
	input: RunTodayBriefInput,
	snapshot: TodayBriefSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<TodayBriefRuntimeResponse> {
	// Build and bound the complete trusted/untrusted model envelope before a
	// paid reservation is started. Local validation failures must never look
	// like a provider-started inference or consume the conservative estimate.
	const messages = buildTodayBriefModelMessages(snapshot.input);
	const decision = await dependencies.beginUsage({
		feature: TODAY_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: TODAY_BRIEF_AI_CONFIG.requestedTier,
		estimatedCostMicros: TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		const current = await snapshotStillCurrent(dependencies, snapshot);
		if (!current) {
			return {
				state: "stale",
				counts: snapshot.counts,
				omittedCount: snapshot.input.omittedCount,
			};
		}
		return {
			state: "budget_paused",
			reason: decision.reason ?? "inference_unavailable",
			counts: snapshot.counts,
			omittedCount: snapshot.input.omittedCount,
		};
	}

	let promptTokens = 0;
	let completionTokens = 0;
	try {
		const currentBeforeProvider = await snapshotStillCurrent(
			dependencies,
			snapshot,
		);
		if (!currentBeforeProvider) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "today_brief_snapshot_changed",
				promptTokens: 0,
				completionTokens: 0,
			});
			return {
				state: "stale",
				counts: snapshot.counts,
				omittedCount: snapshot.input.omittedCount,
			};
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("AI usage reservation could not be started");
		}
		const model = await dependencies.runModel(
			decision.model,
			messages,
		);
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const result = parseTodayBriefOutput(model.text, snapshot.input);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros:
				actualCostMicros || TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});

		const current = await snapshotStillCurrent(dependencies, snapshot);
		if (!current) {
			return {
				state: "stale",
				counts: snapshot.counts,
				omittedCount: snapshot.input.omittedCount,
			};
		}
		const payload: CachedTodayBrief = {
			fingerprint: snapshot.fingerprint,
			generatedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
			result,
		};
		try {
			await dependencies.putCached(cacheKey, cacheScope, payload);
		} catch {
			// Validated, charged guidance remains usable if cache persistence fails.
		}
		return generatedResponse("generated", current, payload);
	} catch (error) {
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.failUsage(decision.reservationId, {
			errorCode:
				error instanceof Error && error.name === "TodayBriefValidationError"
					? "invalid_today_brief_output"
					: "today_brief_failed",
			...(actualCostMicros > 0 ? { actualCostMicros } : {}),
			promptTokens,
			completionTokens,
		});
		throw error;
	}
}

async function cachedTodayBriefResponse(
	dependencies: TodayBriefRuntimeDependencies,
	input: RunTodayBriefInput,
	snapshot: TodayBriefSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<TodayBriefRuntimeResponse | null> {
	const cached = await dependencies.getCached(cacheKey, cacheScope);
	if (
		!cached ||
		cached.fingerprint !== snapshot.fingerprint ||
		!Number.isFinite(Date.parse(cached.generatedAt)) ||
		cached.generatedAt !== new Date(cached.generatedAt).toISOString()
	) {
		return null;
	}
	const result = parseTodayBriefOutput(
		JSON.stringify(cached.result),
		snapshot.input,
	);
	const current = await snapshotStillCurrent(dependencies, snapshot);
	if (!current) {
		return {
			state: "stale",
			counts: snapshot.counts,
			omittedCount: snapshot.input.omittedCount,
		};
	}
	await dependencies.beginUsage({
		feature: TODAY_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: TODAY_BRIEF_AI_CONFIG.requestedTier,
		estimatedCostMicros: TODAY_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	});
	return generatedResponse("cached", current, { ...cached, result });
}

async function resolveTodayBriefSnapshot(
	dependencies: TodayBriefRuntimeDependencies,
	input: RunTodayBriefInput,
	snapshot: TodayBriefSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<TodayBriefRuntimeResponse> {
	if (!(await dependencies.canAccess())) {
		throw new Error("Mailbox access was revoked");
	}
	try {
		const cached = await cachedTodayBriefResponse(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		);
		if (cached) return cached;
	} catch {
		// Corrupt and unavailable cache entries never become user-facing guidance.
	}
	if (!(await dependencies.canAccess())) {
		throw new Error("Mailbox access was revoked");
	}
	const claimToken = crypto.randomUUID();
	const now = (dependencies.now ?? Date.now)();
	if (
		!(await dependencies.claimGeneration(
			cacheKey,
			claimToken,
			now + GENERATION_CLAIM_TTL_MS,
		))
	) {
		if (!(await dependencies.canAccess())) {
			throw new Error("Mailbox access was revoked");
		}
		return {
			state: "preparing",
			counts: snapshot.counts,
			omittedCount: snapshot.input.omittedCount,
		};
	}
	let renewal: ReturnType<typeof setInterval> | undefined;
	try {
		// Close the cache-miss/claim handoff race before reserving any money.
		// Another isolate may have completed between our first read and claim.
		try {
			const cached = await cachedTodayBriefResponse(
				dependencies,
				input,
				snapshot,
				cacheKey,
				cacheScope,
			);
			if (cached) return cached;
		} catch {
			if (!(await dependencies.canAccess())) {
				throw new Error("Mailbox access was revoked");
			}
		}
		renewal = setInterval(() => {
			void dependencies
				.claimGeneration(
					cacheKey,
					claimToken,
					(dependencies.now ?? Date.now)() + GENERATION_CLAIM_TTL_MS,
				)
				.catch(() => undefined);
		}, 30_000);
		return await generateTodayBrief(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		);
	} finally {
		if (renewal !== undefined) clearInterval(renewal);
		await dependencies.releaseGeneration(cacheKey, claimToken).catch(() => undefined);
	}
}

async function runTodayBriefOnce(
	dependencies: TodayBriefRuntimeDependencies,
	input: RunTodayBriefInput,
): Promise<TodayBriefRuntimeResponse> {
	if (!(await dependencies.canAccess())) throw new Error("Mailbox access is required");
	const snapshot = await dependencies.readSnapshot();
	if (snapshot.input.candidates.length === 0) {
		if (!(await dependencies.canAccess())) {
			throw new Error("Mailbox access was revoked");
		}
		return {
			state: "no_attention",
			counts: snapshot.counts,
			omittedCount: 0,
		};
	}
	const cacheKey = await buildTodayBriefCacheKey(snapshot.input, {
		model: dependencies.model,
	});
	const cacheScope = privateCacheScope(input.actorUserId, input.mailboxId);
	const existing = inFlight.get(cacheKey);
	if (existing) return existing;
	// Publish the single-flight promise before any reservation or provider work
	// can start. This closes the same-microtask gap between construction and Map
	// insertion for simultaneous automatic loads from multiple tabs.
	const work = Promise.resolve().then(() =>
		resolveTodayBriefSnapshot(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		),
	);
	inFlight.set(cacheKey, work);
	try {
		return await work;
	} finally {
		if (inFlight.get(cacheKey) === work) inFlight.delete(cacheKey);
	}
}

export function runTodayBrief(
	dependencies: TodayBriefRuntimeDependencies,
	input: RunTodayBriefInput,
): Promise<TodayBriefRuntimeResponse> {
	const requestKey = [
		input.actorUserId.trim().toLowerCase(),
		input.mailboxId.trim().toLowerCase(),
		input.requestScope?.trim().toLowerCase() ?? "default",
	].join("|");
	const existing = requestInFlight.get(requestKey);
	if (existing) return existing;
	const work = Promise.resolve().then(() => runTodayBriefOnce(dependencies, input));
	requestInFlight.set(requestKey, work);
	void work.finally(() => {
		if (requestInFlight.get(requestKey) === work) {
			requestInFlight.delete(requestKey);
		}
	}).catch(() => undefined);
	return work;
}

type TodayBriefCandidateStub = {
	getTodayBriefCandidates(
		mailboxAddress: string,
		reminders: FollowUpReminder[],
		boundaries: { now: string; tomorrowStart: string },
	): Promise<TodayBriefCandidateProjection>;
	claimTodayBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
		expiresAt: number,
	): Promise<boolean>;
	releaseTodayBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
	): Promise<boolean>;
};

export function createTodayBriefRuntime(
	env: Env,
	input: {
		actorUserId: string;
		mailboxId: string;
		day: TodayBriefDayBoundary;
		stub: unknown;
	},
): TodayBriefRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	const service = followUpReminderService(env);
	const stub = input.stub as TodayBriefCandidateStub;
	const readSnapshot = async (): Promise<TodayBriefSnapshot> => {
		const page = await service.list(input.actorUserId, input.mailboxId, 100);
		if (
			hasUnloadedDueReminderRisk(
				page.reminders,
				page.nextCursor,
				input.day.endAt,
			)
		) {
			throw new Error("Today brief reminder snapshot exceeds its safe bound");
		}
		const projection = await stub.getTodayBriefCandidates(
			input.mailboxId,
			page.reminders,
			{
				now: new Date().toISOString(),
				tomorrowStart: input.day.endAt,
			},
		);
		const normalized = normalizeTodayBriefInput({
			actorUserId: input.actorUserId,
			mailboxId: input.mailboxId,
			localDate: input.day.localDate,
			timezone: input.day.timeZone,
			omittedCount: projection.omittedCount,
			candidates: projection.candidates,
		});
		return {
			input: normalized,
			fingerprint: await fingerprintTodayBriefInput(normalized, {
				model: config.cheapModel,
			}),
			counts: projection.counts,
		};
	};
	return {
		model: config.cheapModel,
		readSnapshot,
		canAccess: () =>
			mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		getCached: (cacheKey, cacheScope) =>
			getCachedAiResponse<CachedTodayBrief>(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
			}),
		putCached: (cacheKey, cacheScope, value) =>
			putCachedAiResponse(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
				feature: TODAY_BRIEF_AI_CONFIG.feature,
				value,
				ttlMs: CACHE_TTL_MS,
			}),
		claimGeneration: (cacheKey, claimToken, expiresAt) =>
			stub.claimTodayBriefGeneration(
				cacheKey,
				input.actorUserId,
				claimToken,
				expiresAt,
			),
		releaseGeneration: (cacheKey, claimToken) =>
			stub.releaseTodayBriefGeneration(
				cacheKey,
				input.actorUserId,
				claimToken,
			),
		beginUsage: (usage) => cost.beginUsage(usage),
		startUsage: (reservationId) => cost.startUsage(reservationId),
		completeUsage: (reservationId, actual) =>
			cost.completeUsage(reservationId, actual),
		failUsage: (reservationId, failure) =>
			cost.failUsage(reservationId, failure),
		runModel: async (model, messages) => {
			const ai = env.AI as unknown as {
				run(model: string, input: Record<string, unknown>): Promise<unknown>;
			};
			const response = (await ai.run(model, {
				messages,
				max_tokens: TODAY_BRIEF_AI_CONFIG.maxTokens,
				temperature: TODAY_BRIEF_AI_CONFIG.temperature,
			})) as {
				response?: string;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			return {
				text: (response.response ?? "").trim(),
				promptTokens: Math.max(
					0,
					Math.floor(response.usage?.prompt_tokens ?? 0),
				),
				completionTokens: Math.max(
					0,
					Math.floor(response.usage?.completion_tokens ?? 0),
				),
			};
		},
	};
}
