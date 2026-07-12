import {
	RELATIONSHIP_BRIEF_LIMITS,
	validateRelationshipBriefResponse,
	type RelationshipBriefResponse,
} from "../../shared/relationship-brief.ts";
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
import {
	RELATIONSHIP_BRIEF_AI_CONFIG,
	buildRelationshipBriefCacheKey,
	buildRelationshipBriefModelMessages,
	fingerprintRelationshipBriefInput,
	normalizeRelationshipBriefInput,
	parseRelationshipBriefOutput,
	type NormalizedRelationshipBriefInput,
	type RelationshipBriefModelOutput,
} from "./relationship-brief.ts";
import type { RelationshipBriefEvidenceProjection } from "./relationship-brief-evidence.ts";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CLAIM_TTL_MS = 2 * 60 * 1_000;
const CLAIM_RENEWAL_INTERVAL_MS = 30_000;
const MODEL_TIMEOUT_MS = 90_000;
const activeRuns = new Map<string, Promise<RelationshipBriefResponse>>();

type Projection =
	| RelationshipBriefEvidenceProjection
	| { state: "building"; processedMessages: number; retryAfterMs: number };

type Snapshot = {
	input: NormalizedRelationshipBriefInput;
	fingerprint: string;
};

type CachedRelationshipBrief = {
	fingerprint: string;
	generatedAt: string;
	modelOutput: RelationshipBriefModelOutput;
};

type ModelResult = { text: string; promptTokens: number; completionTokens: number };

class RelationshipBriefModelTimeoutError extends Error {
	constructor() {
		super("Relationship brief model timed out");
		this.name = "RelationshipBriefModelTimeoutError";
	}
}

export class RelationshipBriefAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "RelationshipBriefAccessRevokedError";
	}
}

export type RelationshipBriefRuntimeDependencies = {
	environment: string;
	model: string;
	canAccess(): Promise<boolean>;
	readProjection(): Promise<Projection>;
	getCached(cacheKey: string, cacheScope: string): Promise<CachedRelationshipBrief | null>;
	putCached(cacheKey: string, cacheScope: string, value: CachedRelationshipBrief): Promise<void>;
	deleteCached(cacheKey: string, cacheScope: string): Promise<void>;
	claimGeneration(cacheKey: string, claimToken: string, expiresAt: number): Promise<boolean>;
	releaseGeneration(cacheKey: string, claimToken: string): Promise<unknown>;
	beginUsage(input: BeginAiUsageInput): Promise<AiUsageDecision>;
	startUsage(reservationId: string): Promise<boolean>;
	completeUsage(
		reservationId: string,
		actual: { actualCostMicros: number; promptTokens: number; completionTokens: number },
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
	runModel(model: string, messages: ReturnType<typeof buildRelationshipBriefModelMessages>): Promise<ModelResult>;
	now?(): number;
	claimRenewalIntervalMs?: number;
	modelTimeoutMs?: number;
};

export type RunRelationshipBriefInput = {
	actorUserId: string;
	mailboxId: string;
	personId: string;
	refresh: boolean;
};

function privateScope(input: RunRelationshipBriefInput): string {
	return `relationship-brief:owner:${input.actorUserId}:mailbox:${input.mailboxId}:person:${input.personId}`;
}

async function requireAccess(dependencies: RelationshipBriefRuntimeDependencies): Promise<void> {
	if (!(await dependencies.canAccess())) throw new RelationshipBriefAccessRevokedError();
}

async function readSnapshot(
	dependencies: RelationshipBriefRuntimeDependencies,
): Promise<Snapshot | "building" | "not_found"> {
	const projection = await dependencies.readProjection();
	if (projection.state === "building") return "building";
	if (projection.state === "not_found") return "not_found";
	const input = normalizeRelationshipBriefInput(projection);
	return { input, fingerprint: await fingerprintRelationshipBriefInput(input) };
}

async function initialSnapshot(
	dependencies: RelationshipBriefRuntimeDependencies,
): Promise<Snapshot | "building" | "not_found"> {
	await requireAccess(dependencies);
	const snapshot = await readSnapshot(dependencies);
	await requireAccess(dependencies);
	return snapshot;
}

async function currentSnapshot(
	dependencies: RelationshipBriefRuntimeDependencies,
	expected: Snapshot,
): Promise<Snapshot | null> {
	await requireAccess(dependencies);
	const current = await readSnapshot(dependencies);
	await requireAccess(dependencies);
	return typeof current === "object" && current.fingerprint === expected.fingerprint
		? current
		: null;
}

function readyResponse(
	state: "cached" | "generated",
	snapshot: Snapshot,
	payload: CachedRelationshipBrief,
): RelationshipBriefResponse {
	const parsed = parseRelationshipBriefOutput(
		JSON.stringify(payload.modelOutput),
		snapshot.input,
	);
	return validateRelationshipBriefResponse({
		state,
		fingerprint: snapshot.fingerprint,
		generatedAt: payload.generatedAt,
		brief: parsed.brief,
	});
}

async function tryCached(
	dependencies: RelationshipBriefRuntimeDependencies,
	input: RunRelationshipBriefInput,
	snapshot: Snapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<RelationshipBriefResponse | null> {
	if (!(await currentSnapshot(dependencies, snapshot))) {
		return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	let cached: CachedRelationshipBrief | null;
	try {
		cached = await dependencies.getCached(cacheKey, cacheScope);
	} catch {
		return null;
	}
	if (!cached || cached.fingerprint !== snapshot.fingerprint) return null;
	let response: RelationshipBriefResponse;
	try {
		response = readyResponse("cached", snapshot, cached);
	} catch {
		await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
		return null;
	}
	if (!(await currentSnapshot(dependencies, snapshot))) {
		return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	await requireAccess(dependencies);
	await dependencies.beginUsage({
		feature: RELATIONSHIP_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: RELATIONSHIP_BRIEF_AI_CONFIG.requestedTier,
		estimatedCostMicros: RELATIONSHIP_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	}).catch(() => undefined);
	if (!(await currentSnapshot(dependencies, snapshot))) {
		return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	return response;
}

async function generate(
	dependencies: RelationshipBriefRuntimeDependencies,
	input: RunRelationshipBriefInput,
	snapshot: Snapshot,
	cacheKey: string,
	cacheScope: string,
	assertLease: () => Promise<boolean>,
	onUnabortableModelTimeout: () => void,
): Promise<RelationshipBriefResponse> {
	const messages = buildRelationshipBriefModelMessages(snapshot.input);
	if (!(await currentSnapshot(dependencies, snapshot))) {
		return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	if (!(await assertLease())) {
		return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	const decision = await dependencies.beginUsage({
		feature: RELATIONSHIP_BRIEF_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: RELATIONSHIP_BRIEF_AI_CONFIG.requestedTier,
		estimatedCostMicros: RELATIONSHIP_BRIEF_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		if (!(await assertLease())) {
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		if (!(await currentSnapshot(dependencies, snapshot))) {
			return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		return { state: "budget_paused", reason: decision.reason ?? "inference_unavailable" };
	}

	let promptTokens = 0;
	let completionTokens = 0;
	let settled = false;
	try {
		if (!(await assertLease())) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "relationship_brief_generation_lease_lost",
				promptTokens: 0,
				completionTokens: 0,
			}).catch(() => undefined);
			settled = true;
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		if (!(await currentSnapshot(dependencies, snapshot))) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "relationship_brief_snapshot_changed",
				promptTokens: 0,
				completionTokens: 0,
			}).catch(() => undefined);
			settled = true;
			return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("AI usage reservation could not be started");
		}
		if (!(await currentSnapshot(dependencies, snapshot))) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "relationship_brief_changed_before_dispatch",
				promptTokens: 0,
				completionTokens: 0,
			}).catch(() => undefined);
			settled = true;
			return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		// Renew with the same token immediately before paid provider dispatch. A
		// failed interval renewal is sticky, so this cannot silently reacquire a
		// lease after another isolate has taken over.
		if (!(await assertLease())) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "relationship_brief_generation_lease_lost",
				promptTokens: 0,
				completionTokens: 0,
			}).catch(() => undefined);
			settled = true;
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let model: ModelResult;
		try {
			model = await Promise.race([
				dependencies.runModel(decision.model, messages),
					new Promise<never>((_resolve, reject) => {
						timeout = setTimeout(
							() => reject(new RelationshipBriefModelTimeoutError()),
							Math.min(
								dependencies.modelTimeoutMs ?? MODEL_TIMEOUT_MS,
								CLAIM_TTL_MS - 1_000,
							),
					);
				}),
			]);
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
		}
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const parsed = parseRelationshipBriefOutput(model.text, snapshot.input);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros: actualCostMicros || RELATIONSHIP_BRIEF_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		settled = true;
		// Usage reflects the provider work even if ownership changed while it ran.
		// Never expose or persist that output once the generation lease is lost.
		if (!(await assertLease())) {
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		if (!(await currentSnapshot(dependencies, snapshot))) {
			return { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		const payload: CachedRelationshipBrief = {
			fingerprint: snapshot.fingerprint,
			generatedAt: new Date((dependencies.now ?? Date.now)()).toISOString(),
			modelOutput: parsed.modelOutput,
		};
		let cached = false;
		try {
			if (!(await assertLease())) {
				return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
			}
			await dependencies.putCached(cacheKey, cacheScope, payload);
			cached = true;
		} catch {
			// A cache outage never invalidates a completed, charged inference.
		}
		let current: Snapshot | null;
		try {
			current = await currentSnapshot(dependencies, snapshot);
			if (!current || !(await assertLease())) {
				if (cached) await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
				return current
					? { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs }
					: { state: "stale", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
			}
		} catch (error) {
			if (cached) await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
			throw error;
		}
		return readyResponse("generated", current, payload);
	} catch (error) {
		if (error instanceof RelationshipBriefModelTimeoutError) {
			// Workers AI does not expose a dependable abort signal here. Do not release
			// this token early: stop renewing and let the two-minute lease expire while
			// the provider promise finishes out of band.
			onUnabortableModelTimeout();
		}
		if (!settled) {
			const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
				promptTokens,
				completionTokens,
			});
			await dependencies.failUsage(decision.reservationId, {
				errorCode: error instanceof RelationshipBriefModelTimeoutError
					? "relationship_brief_model_timeout"
					: error instanceof Error && error.name === "RelationshipBriefValidationError"
						? "invalid_relationship_brief_output"
						: "relationship_brief_failed",
				...(actualCostMicros > 0 ? { actualCostMicros } : {}),
				promptTokens,
				completionTokens,
			}).catch(() => undefined);
			settled = true;
		}
		if (error instanceof RelationshipBriefModelTimeoutError) {
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
		}
		throw error;
	}
}

export async function runRelationshipBrief(
	dependencies: RelationshipBriefRuntimeDependencies,
	rawInput: RunRelationshipBriefInput,
): Promise<RelationshipBriefResponse> {
	const input = {
		actorUserId: rawInput.actorUserId.trim(),
		mailboxId: rawInput.mailboxId.trim().toLowerCase(),
		personId: rawInput.personId.trim(),
		refresh: rawInput.refresh,
	};
	const snapshot = await initialSnapshot(dependencies);
	if (snapshot === "building") {
		return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs };
	}
	if (snapshot === "not_found") return { state: "unavailable" };
	const identity = {
		environment: dependencies.environment,
		model: dependencies.model,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		personId: input.personId,
	};
	const cacheKey = await buildRelationshipBriefCacheKey(snapshot.input, identity);
	const cacheScope = privateScope(input);
	const runKey = `${cacheKey}:${input.refresh ? "refresh" : "normal"}`;
	const existing = activeRuns.get(runKey);
	if (existing) return existing;
	const work = (async () => {
		if (!input.refresh) {
			const cached = await tryCached(dependencies, input, snapshot, cacheKey, cacheScope);
			if (cached) return cached;
		}
		await requireAccess(dependencies);
		const claimToken = crypto.randomUUID();
		const now = (dependencies.now ?? Date.now)();
		if (!(await dependencies.claimGeneration(cacheKey, claimToken, now + CLAIM_TTL_MS))) {
			await requireAccess(dependencies);
			return { state: "preparing", retryAfterMs: RELATIONSHIP_BRIEF_LIMITS.retryAfterMs } as const;
		}
		let renewal: ReturnType<typeof setInterval> | undefined;
		let leaseLost = false;
		let leaseCheck: Promise<boolean> | null = null;
		let retainClaimUntilExpiry = false;
		const assertLease = async (): Promise<boolean> => {
			if (leaseLost) return false;
			if (leaseCheck) return leaseCheck;
			const check = (async () => {
				try {
					const held = await dependencies.claimGeneration(
						cacheKey,
						claimToken,
						(dependencies.now ?? Date.now)() + CLAIM_TTL_MS,
					);
					if (!held) leaseLost = true;
				} catch {
					leaseLost = true;
				}
				return !leaseLost;
			})();
			leaseCheck = check;
			try {
				return await check;
			} finally {
				if (leaseCheck === check) leaseCheck = null;
			}
		};
		try {
			if (!input.refresh) {
				const cached = await tryCached(dependencies, input, snapshot, cacheKey, cacheScope);
				if (cached) return cached;
			}
			renewal = setInterval(() => {
				void assertLease();
			}, dependencies.claimRenewalIntervalMs ?? CLAIM_RENEWAL_INTERVAL_MS);
			return await generate(
				dependencies,
				input,
				snapshot,
				cacheKey,
				cacheScope,
				assertLease,
				() => { retainClaimUntilExpiry = true; },
			);
		} finally {
			if (renewal !== undefined) clearInterval(renewal);
			if (!retainClaimUntilExpiry) {
				await dependencies.releaseGeneration(cacheKey, claimToken).catch(() => undefined);
			}
		}
	})();
	activeRuns.set(runKey, work);
	try {
		return await work;
	} finally {
		if (activeRuns.get(runKey) === work) activeRuns.delete(runKey);
	}
}

type RelationshipBriefStub = {
	getRelationshipBriefEvidence(mailboxAddress: string, personId: string): Promise<Projection>;
	claimRelationshipBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
		expiresAt: number,
	): Promise<boolean>;
	releaseRelationshipBriefGeneration(
		cacheKey: string,
		ownerUserId: string,
		claimToken: string,
	): Promise<boolean>;
};

export function createRelationshipBriefRuntime(
	env: Env,
	input: { actorUserId: string; mailboxId: string; personId: string; stub: unknown },
): RelationshipBriefRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	const stub = input.stub as RelationshipBriefStub;
	const cacheScope = (scope: string) => scope;
	return {
		environment: config.environment,
		model: config.cheapModel,
		canAccess: () => mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		readProjection: () => stub.getRelationshipBriefEvidence(input.mailboxId, input.personId),
		getCached: (cacheKey, scope) => getCachedAiResponse(env, {
			cacheKey,
			mailboxId: input.mailboxId,
			cacheScope: cacheScope(scope),
		}),
		putCached: (cacheKey, scope, value) => putCachedAiResponse(env, {
			cacheKey,
			mailboxId: input.mailboxId,
			cacheScope: cacheScope(scope),
			feature: RELATIONSHIP_BRIEF_AI_CONFIG.feature,
			value,
			ttlMs: CACHE_TTL_MS,
		}),
		deleteCached: async (cacheKey, scope) => {
			await env.DB.prepare(
				"DELETE FROM ai_response_cache WHERE cache_key = ? AND environment = ? AND mailbox_scope = ?",
			).bind(cacheKey, config.environment, cacheScope(scope)).run();
		},
		claimGeneration: (cacheKey, claimToken, expiresAt) =>
			stub.claimRelationshipBriefGeneration(
				cacheKey,
				input.actorUserId,
				claimToken,
				expiresAt,
			),
		releaseGeneration: (cacheKey, claimToken) =>
			stub.releaseRelationshipBriefGeneration(cacheKey, input.actorUserId, claimToken),
		beginUsage: (usage) => cost.beginUsage(usage),
		startUsage: (reservationId) => cost.startUsage(reservationId),
		completeUsage: (reservationId, actual) => cost.completeUsage(reservationId, actual),
		failUsage: (reservationId, failure) => cost.failUsage(reservationId, failure),
		runModel: async (model, messages) => {
			const ai = env.AI as unknown as {
				run(modelName: string, modelInput: Record<string, unknown>): Promise<unknown>;
			};
			const response = await ai.run(model, {
				messages,
				max_tokens: RELATIONSHIP_BRIEF_AI_CONFIG.maxTokens,
				temperature: RELATIONSHIP_BRIEF_AI_CONFIG.temperature,
			}) as {
				response?: string;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			return {
				text: (response.response ?? "").trim(),
				promptTokens: Math.max(0, Math.floor(response.usage?.prompt_tokens ?? 0)),
				completionTokens: Math.max(0, Math.floor(response.usage?.completion_tokens ?? 0)),
			};
		},
	};
}
