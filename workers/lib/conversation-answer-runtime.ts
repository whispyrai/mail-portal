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
	CONVERSATION_ANSWER_AI_CONFIG,
	buildConversationAnswerCacheKey,
	buildConversationAnswerModelMessages,
	fingerprintConversationAnswerInput,
	normalizeConversationAnswerQuestion,
	parseConversationAnswerOutput,
	type ConversationAnswerGeneratedResult,
	type ConversationAnswerModelMessage,
} from "./conversation-answer.ts";
import {
	gatherConversationIntelligenceEvidence,
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "./conversation-intelligence-runtime.ts";
import type { NormalizedConversationIntelligenceInput } from "./conversation-intelligence.ts";
import { mailboxAccess } from "./mailbox-access.ts";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type CachedConversationAnswer = {
	fingerprint: string;
	result: ConversationAnswerGeneratedResult;
};

type ConversationAnswerSnapshot = {
	evidence: NormalizedConversationIntelligenceInput;
	fingerprint: string;
};

type ModelResult = {
	text: string;
	promptTokens: number;
	completionTokens: number;
};

export class ConversationAnswerAccessRevokedError extends Error {
	constructor() {
		super("Mailbox access was revoked");
		this.name = "ConversationAnswerAccessRevokedError";
	}
}

export type ConversationAnswerRuntimeResponse =
	| {
			state: "cached" | "generated";
			fingerprint: string;
			result: ConversationAnswerGeneratedResult;
	  }
	| { state: "budget_paused"; reason: string }
	| { state: "stale" };

export interface ConversationAnswerRuntimeDependencies {
	environment: string;
	model: string;
	canAccess(): Promise<boolean>;
	readEvidence(
		emailId: string,
	): Promise<NormalizedConversationIntelligenceInput>;
	getCached(
		cacheKey: string,
		cacheScope: string,
	): Promise<CachedConversationAnswer | null>;
	putCached(
		cacheKey: string,
		cacheScope: string,
		value: CachedConversationAnswer,
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
		messages: ConversationAnswerModelMessage[],
	): Promise<ModelResult>;
}

export type RunConversationAnswerInput = {
	actorUserId: string;
	mailboxId: string;
	emailId: string;
	question: unknown;
};

function privateCacheScope(actorUserId: string, mailboxId: string): string {
	return `conversation-answer:owner:${actorUserId}:mailbox:${mailboxId}`;
}

async function requireAccess(
	dependencies: ConversationAnswerRuntimeDependencies,
): Promise<void> {
	if (!(await dependencies.canAccess())) {
		throw new ConversationAnswerAccessRevokedError();
	}
}

async function readSnapshot(
	dependencies: ConversationAnswerRuntimeDependencies,
	input: {
		actorUserId: string;
		mailboxId: string;
		emailId: string;
		question: string;
	},
): Promise<ConversationAnswerSnapshot> {
	const evidence = await dependencies.readEvidence(input.emailId);
	return {
		evidence,
		fingerprint: await fingerprintConversationAnswerInput(
			evidence,
			input.question,
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
	dependencies: ConversationAnswerRuntimeDependencies,
	input: {
		actorUserId: string;
		mailboxId: string;
		emailId: string;
		question: string;
	},
	expectedFingerprint: string,
): Promise<ConversationAnswerSnapshot | null> {
	await requireAccess(dependencies);
	let current: ConversationAnswerSnapshot;
	try {
		current = await readSnapshot(dependencies, input);
	} catch (error) {
		if (
			error instanceof ConversationIntelligenceNotFoundError ||
			error instanceof ConversationIntelligenceUnsupportedStateError
		) {
			return null;
		}
		throw error;
	}
	await requireAccess(dependencies);
	return current.fingerprint === expectedFingerprint ? current : null;
}

async function tryCachedAnswer(
	dependencies: ConversationAnswerRuntimeDependencies,
	input: {
		actorUserId: string;
		mailboxId: string;
		emailId: string;
		question: string;
	},
	snapshot: ConversationAnswerSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<ConversationAnswerRuntimeResponse | null> {
	let cached: CachedConversationAnswer | null;
	try {
		cached = await dependencies.getCached(cacheKey, cacheScope);
	} catch {
		return null;
	}
	if (!cached || cached.fingerprint !== snapshot.fingerprint) return null;

	let result: ConversationAnswerGeneratedResult;
	try {
		result = parseConversationAnswerOutput(
			JSON.stringify(cached.result),
			snapshot.evidence,
		);
	} catch {
		return null;
	}

	const currentBeforeCacheResponse = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!currentBeforeCacheResponse) return { state: "stale" };

	await dependencies.beginUsage({
		feature: CONVERSATION_ANSWER_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: CONVERSATION_ANSWER_AI_CONFIG.requestedTier,
		estimatedCostMicros: CONVERSATION_ANSWER_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: true,
	});

	const currentBeforeResponse = await readCurrentSnapshot(
		dependencies,
		input,
		snapshot.fingerprint,
	);
	if (!currentBeforeResponse) return { state: "stale" };
	return {
		state: "cached",
		fingerprint: currentBeforeResponse.fingerprint,
		result,
	};
}

async function generateAnswer(
	dependencies: ConversationAnswerRuntimeDependencies,
	input: {
		actorUserId: string;
		mailboxId: string;
		emailId: string;
		question: string;
	},
	snapshot: ConversationAnswerSnapshot,
	cacheKey: string,
	cacheScope: string,
): Promise<ConversationAnswerRuntimeResponse> {
	// Prompt validation is local and happens before reserving any provider cost.
	const messages = buildConversationAnswerModelMessages(
		snapshot.evidence,
		input.question,
	);
	const decision = await dependencies.beginUsage({
		feature: CONVERSATION_ANSWER_AI_CONFIG.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: CONVERSATION_ANSWER_AI_CONFIG.requestedTier,
		estimatedCostMicros: CONVERSATION_ANSWER_AI_CONFIG.estimatedCostMicros,
		cacheKey,
		cacheHit: false,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		const current = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!current) return { state: "stale" };
		return {
			state: "budget_paused",
			reason: decision.reason ?? "inference_unavailable",
		};
	}

	let promptTokens = 0;
	let completionTokens = 0;
	let usageSettled = false;
	try {
		const currentBeforeProvider = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentBeforeProvider) {
			await dependencies.failUsage(decision.reservationId, {
				errorCode: "conversation_answer_snapshot_changed",
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
		const result = parseConversationAnswerOutput(
			model.text,
			snapshot.evidence,
		);
		const actualCostMicros = calculateAiUsageCostMicros(decision.tier, {
			promptTokens,
			completionTokens,
		});
		await dependencies.completeUsage(decision.reservationId, {
			actualCostMicros:
				actualCostMicros || CONVERSATION_ANSWER_AI_CONFIG.estimatedCostMicros,
			promptTokens,
			completionTokens,
		});
		usageSettled = true;

		const currentAfterInference = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentAfterInference) return { state: "stale" };
		const currentBeforeCacheWrite = await readCurrentSnapshot(
			dependencies,
			input,
			snapshot.fingerprint,
		);
		if (!currentBeforeCacheWrite) return { state: "stale" };

		const payload = { fingerprint: snapshot.fingerprint, result };
		let cached = false;
		try {
			await dependencies.putCached(cacheKey, cacheScope, payload);
			cached = true;
		} catch {
			// A cache outage does not turn a completed provider call into failure.
		}

		let currentBeforeResponse: ConversationAnswerSnapshot | null;
		try {
			currentBeforeResponse = await readCurrentSnapshot(
				dependencies,
				input,
				snapshot.fingerprint,
			);
		} catch (error) {
			if (cached) {
				await dependencies
					.deleteCached(cacheKey, cacheScope)
					.catch(() => undefined);
			}
			throw error;
		}
		if (!currentBeforeResponse) {
			if (cached) {
				await dependencies
					.deleteCached(cacheKey, cacheScope)
					.catch(() => undefined);
			}
			return { state: "stale" };
		}
		return {
			state: "generated",
			fingerprint: currentBeforeResponse.fingerprint,
			result,
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
					error.name === "ConversationAnswerValidationError"
						? "invalid_conversation_answer_output"
						: "conversation_answer_failed",
				...(actualCostMicros > 0 ? { actualCostMicros } : {}),
				promptTokens,
				completionTokens,
			});
		}
		throw error;
	}
}

export async function runConversationAnswer(
	dependencies: ConversationAnswerRuntimeDependencies,
	rawInput: RunConversationAnswerInput,
): Promise<ConversationAnswerRuntimeResponse> {
	await requireAccess(dependencies);
	const input = {
		actorUserId: rawInput.actorUserId.trim(),
		mailboxId: rawInput.mailboxId.trim().toLowerCase(),
		emailId: rawInput.emailId,
		question: normalizeConversationAnswerQuestion(rawInput.question),
	};
	const snapshot = await readSnapshot(dependencies, input);
	const cacheKey = await buildConversationAnswerCacheKey(
		snapshot.evidence,
		input.question,
		{
			environment: dependencies.environment,
			model: dependencies.model,
			actorUserId: input.actorUserId,
			mailboxId: input.mailboxId,
		},
	);
	const cacheScope = privateCacheScope(input.actorUserId, input.mailboxId);
	const cached = await tryCachedAnswer(
		dependencies,
		input,
		snapshot,
		cacheKey,
		cacheScope,
	);
	if (cached) return cached;
	return generateAnswer(dependencies, input, snapshot, cacheKey, cacheScope);
}

type ConversationAnswerEvidenceStub = Parameters<
	typeof gatherConversationIntelligenceEvidence
>[0];

export function createConversationAnswerRuntime(
	env: Env,
	input: { stub: unknown; actorUserId: string; mailboxId: string },
): ConversationAnswerRuntimeDependencies {
	const config = resolveAiCostControlConfig(env);
	const cost = createAiCostController(env, config);
	return {
		environment: config.environment,
		model: config.cheapModel,
		canAccess: () =>
			mailboxAccess(env).canAccessMailbox(input.actorUserId, input.mailboxId),
		readEvidence: (emailId) =>
			gatherConversationIntelligenceEvidence(
				input.stub as ConversationAnswerEvidenceStub,
				env.BUCKET,
				emailId,
			),
		getCached: (cacheKey, cacheScope) =>
			getCachedAiResponse<CachedConversationAnswer>(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
			}),
		putCached: (cacheKey, cacheScope, value) =>
			putCachedAiResponse(env, {
				cacheKey,
				mailboxId: input.mailboxId,
				cacheScope,
				feature: CONVERSATION_ANSWER_AI_CONFIG.feature,
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
				max_tokens: CONVERSATION_ANSWER_AI_CONFIG.maxTokens,
				temperature: CONVERSATION_ANSWER_AI_CONFIG.temperature,
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
