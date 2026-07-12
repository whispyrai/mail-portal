import {
	parseAiSearchInterpreterRequest,
	type AiSearchInterpreterRequest,
	type AiSearchInterpreterResponse,
} from "../../shared/ai-search-interpreter.ts";
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
import {
	AI_SEARCH_INTERPRETER_AI_CONFIG,
	buildAiSearchInterpreterCacheKey,
	buildAiSearchInterpreterModelMessages,
	localDateForTimezone,
	parseAiSearchInterpreterModelOutput,
	parseCachedAiSearchInterpreterModelOutput,
	snapshotAiSearchCatalog,
	type AiSearchCatalogSnapshot,
	type AiSearchInterpreterModelMessage,
	type AiSearchInterpreterModelOutput,
} from "./ai-search-interpreter.ts";
import { mailboxAccess } from "./mailbox-access.ts";

const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const activeRuns = new Map<string, Promise<AiSearchInterpreterResponse>>();

type CachedAiSearchInterpreter = {
	catalogFingerprint: string;
	modelOutput: AiSearchInterpreterModelOutput;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export class AiSearchInterpreterAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "AiSearchInterpreterAccessRevokedError";
	}
}

export interface AiSearchInterpreterRuntimeDependencies {
	environment: string;
	model: string;
	now(): number;
	canAccess(): Promise<boolean>;
	readCatalog(): Promise<unknown>;
	getCached(
		cacheKey: string,
		cacheScope: string,
	): Promise<CachedAiSearchInterpreter | null>;
	putCached(
		cacheKey: string,
		cacheScope: string,
		value: CachedAiSearchInterpreter,
	): Promise<void>;
	deleteCached(cacheKey: string, cacheScope: string): Promise<void>;
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
	runModel(
		model: string,
		messages: AiSearchInterpreterModelMessage[],
	): Promise<ModelResult>;
}

export type RunAiSearchInterpreterInput = {
	actorUserId: string;
	mailboxId: string;
	request: unknown;
};

type NormalizedRunInput = {
	actorUserId: string;
	mailboxId: string;
	request: AiSearchInterpreterRequest;
	localDate: string;
};

function privateCacheScope(actorUserId: string, mailboxId: string): string {
	return `search-interpreter:owner:${actorUserId}:mailbox:${mailboxId}`;
}

async function requireAccess(
	dependencies: AiSearchInterpreterRuntimeDependencies,
): Promise<void> {
	if (!(await dependencies.canAccess())) {
		throw new AiSearchInterpreterAccessRevokedError();
	}
}

async function readCatalogSnapshot(
	dependencies: AiSearchInterpreterRuntimeDependencies,
): Promise<AiSearchCatalogSnapshot> {
	await requireAccess(dependencies);
	const snapshot = await snapshotAiSearchCatalog(await dependencies.readCatalog());
	await requireAccess(dependencies);
	return snapshot;
}

async function readCurrentCatalog(
	dependencies: AiSearchInterpreterRuntimeDependencies,
	expectedFingerprint: string,
): Promise<AiSearchCatalogSnapshot | null> {
	const current = await readCatalogSnapshot(dependencies);
	return current.fingerprint === expectedFingerprint ? current : null;
}

async function tryCachedInterpretation(
	dependencies: AiSearchInterpreterRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: AiSearchCatalogSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<AiSearchInterpreterResponse | null> {
	if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	let cached: CachedAiSearchInterpreter | null;
	try {
		cached = await dependencies.getCached(cacheKey, cacheScope);
	} catch {
		return null;
	}
	if (!cached || cached.catalogFingerprint !== snapshot.fingerprint) return null;
	let parsed: ReturnType<typeof parseCachedAiSearchInterpreterModelOutput>;
	try {
		parsed = parseCachedAiSearchInterpreterModelOutput(
			cached.modelOutput,
			snapshot.catalog,
		);
	} catch {
		await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
		return null;
	}
	if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	await dependencies.beginUsage({
		feature: AI_SEARCH_INTERPRETER_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: AI_SEARCH_INTERPRETER_AI_CONFIG.requestedTier,
		estimatedCostMicros: AI_SEARCH_INTERPRETER_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	});
	if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	return parsed.response;
}

async function generateInterpretation(
	dependencies: AiSearchInterpreterRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: AiSearchCatalogSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<AiSearchInterpreterResponse> {
	const messages = buildAiSearchInterpreterModelMessages({
		intent: input.request.intent,
		timezone: input.request.timezone,
		localDate: input.localDate,
		catalog: snapshot.catalog,
	});
	if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	const decision = await dependencies.beginUsage({
		feature: AI_SEARCH_INTERPRETER_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: AI_SEARCH_INTERPRETER_AI_CONFIG.requestedTier,
		estimatedCostMicros: AI_SEARCH_INTERPRETER_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
			return { state: "stale" };
		}
		return { state: "budget_paused" };
	}

	let promptTokens = 0;
	let completionTokens = 0;
	let usageSettled = false;
	try {
		if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "search_interpreter_catalog_changed",
				promptTokens: 0,
				completionTokens: 0,
			});
			usageSettled = true;
			return { state: "stale" };
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("AI usage reservation could not be started");
		}
		const model = await dependencies.runModel(decision.model, messages);
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const parsed = parseAiSearchInterpreterModelOutput(
			model.text,
			snapshot.catalog,
		);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros:
				actualCostMicros || AI_SEARCH_INTERPRETER_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		usageSettled = true;

		if (!(await readCurrentCatalog(dependencies, snapshot.fingerprint))) {
			return { state: "stale" };
		}
		let cached = false;
		try {
			await dependencies.putCached(cacheKey, cacheScope, {
				catalogFingerprint: snapshot.fingerprint,
				modelOutput: parsed.modelOutput,
			});
			cached = true;
		} catch {
			// A cache outage does not invalidate a completed provider call.
		}
		let current: AiSearchCatalogSnapshot | null;
		try {
			current = await readCurrentCatalog(dependencies, snapshot.fingerprint);
		} catch (error) {
			if (cached) {
				await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
			}
			throw error;
		}
		if (!current) {
			if (cached) {
				await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
			}
			return { state: "stale" };
		}
		return parsed.response;
	} catch (error) {
		if (!usageSettled) {
			const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
				promptTokens,
				completionTokens,
			});
			await dependencies.failUsage(decision.reservationId, {
				errorCode:
					error instanceof Error &&
					error.name === "AiSearchInterpreterValidationError"
						? "invalid_search_interpreter_output"
						: "search_interpreter_failed",
				...(actualCostMicros > 0 ? { actualCostMicros } : {}),
				promptTokens,
				completionTokens,
			});
		}
		throw error;
	}
}

export async function runAiSearchInterpreter(
	dependencies: AiSearchInterpreterRuntimeDependencies,
	rawInput: RunAiSearchInterpreterInput,
): Promise<AiSearchInterpreterResponse> {
	const request = parseAiSearchInterpreterRequest(rawInput.request);
	const input: NormalizedRunInput = {
		actorUserId: rawInput.actorUserId.trim(),
		mailboxId: rawInput.mailboxId.trim().toLowerCase(),
		request,
		localDate: localDateForTimezone(dependencies.now(), request.timezone),
	};
	await requireAccess(dependencies);
	const snapshot = await readCatalogSnapshot(dependencies);
	await requireAccess(dependencies);
	const cacheKey = await buildAiSearchInterpreterCacheKey({
		environment: dependencies.environment,
		model: dependencies.model,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		intent: request.intent,
		timezone: request.timezone,
		localDate: input.localDate,
		catalogFingerprint: snapshot.fingerprint,
	});
	const cacheScope = privateCacheScope(input.actorUserId, input.mailboxId);
	const existing = activeRuns.get(cacheKey);
	if (existing) return existing;
	const work = (async () => {
		const cached = await tryCachedInterpretation(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		);
		if (cached) return cached;
		return generateInterpretation(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		);
	})();
	activeRuns.set(cacheKey, work);
	try {
		return await work;
	} finally {
		if (activeRuns.get(cacheKey) === work) activeRuns.delete(cacheKey);
	}
}

type AiSearchInterpreterCatalogStub = {
	getAiSearchInterpreterCatalog(): Promise<unknown>;
};

export function createAiSearchInterpreterRuntime(
	env: Env,
	input: { stub: unknown; actorUserId: string; mailboxId: string },
): AiSearchInterpreterRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	return {
		environment: config.environment,
		model: config.cheapModel,
		now: Date.now,
		canAccess: () =>
			mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		readCatalog: () =>
			(input.stub as AiSearchInterpreterCatalogStub).getAiSearchInterpreterCatalog(),
		getCached: (cacheKey, cacheScope) =>
			getCachedAiResponse<CachedAiSearchInterpreter>(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
			}),
		putCached: (cacheKey, cacheScope, value) =>
			putCachedAiResponse(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
				feature: AI_SEARCH_INTERPRETER_AI_CONFIG.feature,
				value,
				ttlMs: CACHE_TTL_MS,
			}),
		deleteCached: async (cacheKey, cacheScope) => {
			await env.DB.prepare(
				`DELETE FROM ai_response_cache
				 WHERE cache_key = ? AND environment = ? AND mailbox_scope = ?`,
			)
				.bind(cacheKey, config.environment, cacheScope)
				.run();
		},
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
				max_tokens: AI_SEARCH_INTERPRETER_AI_CONFIG.maxTokens,
				temperature: AI_SEARCH_INTERPRETER_AI_CONFIG.temperature,
			})) as {
				response?: string;
				usage?: { prompt_tokens?: number; completion_tokens?: number };
			};
			return {
				text: response.response ?? "",
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
