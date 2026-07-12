import type { Env } from "../types.ts";
import type { NormalizedInboxTriageSuggestionRequest } from "../../shared/inbox-triage-suggestions.ts";
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
import type {
	InboxTriageCandidateProjection,
	InboxTriageCandidateSnapshot,
} from "./inbox-triage-candidates.ts";
import {
	INBOX_TRIAGE_SUGGESTION_AI_CONFIG,
	buildInboxTriageSuggestionCacheKey,
	buildInboxTriageSuggestionModelMessages,
	fingerprintInboxTriageSuggestionInput,
	parseInboxTriageSuggestionOutput,
	type InboxTriageSuggestionModelMessage,
	type InboxTriageSuggestionModelOutput,
} from "./inbox-triage-suggestions.ts";
import {
	parseInboxTriageSuggestionRequest,
	type InboxTriageSuggestionResult,
} from "../../shared/inbox-triage-suggestions.ts";
import { mailboxAccess } from "./mailbox-access.ts";

const CACHE_TTL_MS = 60 * 60 * 1_000;
const activeRuns = new Map<string, Promise<InboxTriageSuggestionRuntimeResponse>>();

type CachedInboxTriageSuggestion = {
	fingerprint: string;
	modelOutput: InboxTriageSuggestionModelOutput;
};

type Snapshot = {
	snapshot: InboxTriageCandidateSnapshot;
	fingerprint: string;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export class InboxTriageSuggestionAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "InboxTriageSuggestionAccessRevokedError";
	}
}

export type InboxTriageSuggestionRuntimeResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: InboxTriageSuggestionResult;
	  }
	| { state: "budget_paused"; reason: string }
	| { state: "stale" };

export interface InboxTriageSuggestionRuntimeDependencies {
	environment: string;
	model: string;
	canAccess(): Promise<boolean>;
	readProjection(
		request: NormalizedInboxTriageSuggestionRequest,
	): Promise<InboxTriageCandidateProjection>;
	getCached(
		cacheKey: string,
		cacheScope: string,
	): Promise<CachedInboxTriageSuggestion | null>;
	putCached(
		cacheKey: string,
		cacheScope: string,
		value: CachedInboxTriageSuggestion,
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
		messages: InboxTriageSuggestionModelMessage[],
	): Promise<ModelResult>;
}

export type RunInboxTriageSuggestionInput = {
	actorUserId: string;
	mailboxId: string;
	request: unknown;
};

type NormalizedRunInput = {
	actorUserId: string;
	mailboxId: string;
	request: NormalizedInboxTriageSuggestionRequest;
};

function privateCacheScope(actorUserId: string, mailboxId: string): string {
	return `inbox-triage:owner:${actorUserId}:mailbox:${mailboxId}`;
}

async function requireAccess(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
): Promise<void> {
	if (!(await dependencies.canAccess())) {
		throw new InboxTriageSuggestionAccessRevokedError();
	}
}

async function readSnapshot(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
	input: NormalizedRunInput,
): Promise<Snapshot | null> {
	const projection = await dependencies.readProjection(input.request);
	if (projection.state !== "ready") return null;
	return {
		snapshot: projection.snapshot,
		fingerprint: await fingerprintInboxTriageSuggestionInput(
			projection.snapshot,
			{
				environment: dependencies.environment,
				model: dependencies.model,
				actorUserId: input.actorUserId,
				mailboxId: input.mailboxId,
			},
		),
	};
}

async function readCurrentSnapshot(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
	input: NormalizedRunInput,
	expectedFingerprint: string,
): Promise<Snapshot | null> {
	await requireAccess(dependencies);
	const current = await readSnapshot(dependencies, input);
	await requireAccess(dependencies);
	return current?.fingerprint === expectedFingerprint ? current : null;
}

async function tryCached(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: Snapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<InboxTriageSuggestionRuntimeResponse | null> {
	if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	let cached: CachedInboxTriageSuggestion | null;
	try {
		cached = await dependencies.getCached(cacheKey, cacheScope);
	} catch {
		return null;
	}
	if (!cached || cached.fingerprint !== snapshot.fingerprint) return null;
	let result: InboxTriageSuggestionResult;
	try {
		result = parseInboxTriageSuggestionOutput(
			JSON.stringify(cached.modelOutput),
			snapshot.snapshot,
		).result;
	} catch {
		await dependencies.deleteCached(cacheKey, cacheScope).catch(() => undefined);
		return null;
	}
	if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	await dependencies.beginUsage({
		feature: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.requestedTier,
		estimatedCostMicros: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	});
	const current = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!current) return { state: "stale" };
	return {
		state: "cached",
		fingerprint: current.fingerprint,
		result,
	};
}

async function generate(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
	input: NormalizedRunInput,
	snapshot: Snapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<InboxTriageSuggestionRuntimeResponse> {
	const messages = buildInboxTriageSuggestionModelMessages(snapshot.snapshot);
	if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
		return { state: "stale" };
	}
	const decision = await dependencies.beginUsage({
		feature: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.requestedTier,
		estimatedCostMicros: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
			return { state: "stale" };
		}
		return {
			state: "budget_paused",
			reason: decision.reason ?? "inference_unavailable",
		};
	}

	let promptTokens = 0;
	let completionTokens = 0;
	let usageSettled = false;
	try {
		if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "inbox_triage_snapshot_changed",
				promptTokens: 0,
				completionTokens: 0,
			});
			usageSettled = true;
			return { state: "stale" };
		}
		if (!(await dependencies.startUsage(decision.reservationId))) {
			throw new Error("AI usage reservation could not be started");
		}
		if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "inbox_triage_snapshot_changed_before_dispatch",
				promptTokens: 0,
				completionTokens: 0,
			});
			usageSettled = true;
			return { state: "stale" };
		}

		const model = await dependencies.runModel(decision.model, messages);
		promptTokens = model.promptTokens;
		completionTokens = model.completionTokens;
		const parsed = parseInboxTriageSuggestionOutput(
			model.text,
			snapshot.snapshot,
		);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros:
				actualCostMicros ||
				INBOX_TRIAGE_SUGGESTION_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		usageSettled = true;

		if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
			return { state: "stale" };
		}
		if (!(await readCurrentSnapshot(dependencies, input, snapshot.fingerprint))) {
			return { state: "stale" };
		}
		let cached = false;
		try {
			await dependencies.putCached(cacheKey, cacheScope, {
				fingerprint: snapshot.fingerprint,
				modelOutput: parsed.modelOutput,
			});
			cached = true;
		} catch {
			// A cache outage does not invalidate a completed provider call.
		}
		let current: Snapshot | null;
		try {
			current = await readCurrentSnapshot(
				dependencies,
				input,
				snapshot.fingerprint,
			);
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
		return {
			state: "generated",
			fingerprint: current.fingerprint,
			result: parsed.result,
		};
	} catch (error) {
		if (!usageSettled) {
			const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
				promptTokens,
				completionTokens,
			});
			await dependencies.failUsage(decision.reservationId, {
				errorCode:
					error instanceof Error &&
					error.name === "InboxTriageSuggestionValidationError"
						? "invalid_inbox_triage_output"
						: "inbox_triage_failed",
				...(actualCostMicros > 0 ? { actualCostMicros } : {}),
				promptTokens,
				completionTokens,
			});
		}
		throw error;
	}
}

export async function runInboxTriageSuggestions(
	dependencies: InboxTriageSuggestionRuntimeDependencies,
	rawInput: RunInboxTriageSuggestionInput,
): Promise<InboxTriageSuggestionRuntimeResponse> {
	const input: NormalizedRunInput = {
		actorUserId: rawInput.actorUserId.trim(),
		mailboxId: rawInput.mailboxId.trim().toLowerCase(),
		request: parseInboxTriageSuggestionRequest(rawInput.request),
	};
	await requireAccess(dependencies);
	const snapshot = await readSnapshot(dependencies, input);
	if (!snapshot) return { state: "stale" };
	await requireAccess(dependencies);
	const identity = {
		environment: dependencies.environment,
		model: dependencies.model,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
	};
	const cacheKey = await buildInboxTriageSuggestionCacheKey(
		snapshot.snapshot,
		identity,
	);
	const cacheScope = privateCacheScope(input.actorUserId, input.mailboxId);
	const existing = activeRuns.get(cacheKey);
	if (existing) return existing;
	const work = (async () => {
		const cached = await tryCached(
			dependencies,
			input,
			snapshot,
			cacheKey,
			cacheScope,
		);
		if (cached) return cached;
		return generate(
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

type InboxTriageProjectionStub = {
	getInboxTriageCandidates(
		request: NormalizedInboxTriageSuggestionRequest,
		mailboxId: string,
	): Promise<InboxTriageCandidateProjection>;
};

export function createInboxTriageSuggestionRuntime(
	env: Env,
	input: { stub: unknown; actorUserId: string; mailboxId: string },
): InboxTriageSuggestionRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	return {
		environment: config.environment,
		model: config.cheapModel,
		canAccess: () =>
			mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		readProjection: (request) =>
			(input.stub as InboxTriageProjectionStub).getInboxTriageCandidates(
				request,
				input.mailboxId,
			),
		getCached: (cacheKey, cacheScope) =>
			getCachedAiResponse<CachedInboxTriageSuggestion>(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
			}),
		putCached: (cacheKey, cacheScope, value) =>
			putCachedAiResponse(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
				feature: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.feature,
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
				max_tokens: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.maxTokens,
				temperature: INBOX_TRIAGE_SUGGESTION_AI_CONFIG.temperature,
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
