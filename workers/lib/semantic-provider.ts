import type { AiUsageDecision } from "./ai-cost-control.ts";
import { resolveAiCostControlConfig } from "./ai-cost-control.ts";
import { createAiCostController } from "./ai-cost-control-d1.ts";
import {
	SemanticIndexDeferredError,
	type SemanticIndexRuntimeProvider,
} from "./semantic-index-runtime.ts";
import { SEMANTIC_EMBEDDING_MODEL } from "./semantic-search.ts";
import type { Env } from "../types.ts";

const BGE_M3_MICROS_PER_MILLION_INPUT_TOKENS = 12_000;

export type SemanticEmbeddingFeature =
	| "semantic_message_index"
	| "semantic_query_embedding";

type SemanticEmbeddingCost = {
	beginUsage(input: {
		feature: SemanticEmbeddingFeature;
		actorUserId?: string;
		mailboxId?: string;
		requestedTier: "cheap";
		estimatedCostMicros: number;
	}): Promise<AiUsageDecision>;
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
		failure: { errorCode: string },
	): Promise<unknown>;
};

function embeddingInputBytes(texts: readonly string[]): number {
	return texts.reduce(
		(total, value) => total + new TextEncoder().encode(value).byteLength,
		0,
	);
}

export function estimateSemanticEmbeddingCostMicros(texts: readonly string[]): number {
	const conservativeTokens = embeddingInputBytes(texts);
	// Cloudflare lists BGE-M3 at $0.012 per million input tokens. UTF-8 bytes
	// conservatively upper-bound tokens, so the reservation cannot undercount.
	// https://developers.cloudflare.com/workers-ai/platform/pricing/
	return Math.max(
		1,
		Math.ceil(
			conservativeTokens * BGE_M3_MICROS_PER_MILLION_INPUT_TOKENS / 1_000_000,
		),
	);
}

function embeddingMatrix(value: unknown, expectedRows: number): number[][] {
	if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
		throw new Error("Semantic embedding provider returned an invalid response");
	}
	const matrix: number[][] = [];
	for (const row of value.data) {
		if (!Array.isArray(row) || row.length === 0 || row.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
			throw new Error("Semantic embedding provider returned an invalid vector");
		}
		matrix.push(row);
	}
	if (matrix.length !== expectedRows) {
		throw new Error("Semantic embedding provider returned an unexpected vector count");
	}
	const dimension = matrix[0]?.length ?? 0;
	if (matrix.some((row) => row.length !== dimension)) {
		throw new Error("Semantic embedding provider returned inconsistent dimensions");
	}
	return matrix;
}

export async function runCostedSemanticEmbedding(input: {
	cost: SemanticEmbeddingCost;
	runModel(texts: string[]): Promise<unknown>;
	feature: SemanticEmbeddingFeature;
	texts: string[];
	actorUserId?: string;
	mailboxId?: string;
}): Promise<number[][]> {
	if (input.texts.length === 0) return [];
	const estimatedCostMicros = estimateSemanticEmbeddingCostMicros(input.texts);
	const decision = await input.cost.beginUsage({
		feature: input.feature,
		actorUserId: input.actorUserId,
		mailboxId: input.mailboxId,
		requestedTier: "cheap",
		estimatedCostMicros,
	});
	if (decision.decision === "block" || !decision.reservationId) {
		throw new SemanticIndexDeferredError();
	}
	const started = await input.cost.startUsage(decision.reservationId);
	if (!started) {
		await input.cost.failUsage(decision.reservationId, {
			errorCode: "reservation_start_failed",
		}).catch(() => undefined);
		throw new SemanticIndexDeferredError();
	}

	try {
		const result = await input.runModel(input.texts);
		const vectors = embeddingMatrix(result, input.texts.length);
		await input.cost.completeUsage(decision.reservationId, {
			actualCostMicros: estimatedCostMicros,
			promptTokens: embeddingInputBytes(input.texts),
			completionTokens: 0,
		}).catch(() => undefined);
		return vectors;
	} catch (error) {
		await input.cost.failUsage(decision.reservationId, {
			errorCode: error instanceof Error ? error.name : "embedding_failed",
		}).catch(() => undefined);
		throw error;
	}
}

export function createSemanticEmbeddingRunner(
	env: Env,
	identity: {
		feature: SemanticEmbeddingFeature;
		actorUserId?: string;
		mailboxId?: string;
	},
) {
	const config = {
		...resolveAiCostControlConfig(env),
		cheapModel: SEMANTIC_EMBEDDING_MODEL,
	};
	const cost = createAiCostController(env, config);
	return (texts: string[]) => runCostedSemanticEmbedding({
		cost,
		feature: identity.feature,
		actorUserId: identity.actorUserId,
		mailboxId: identity.mailboxId,
		texts,
		runModel: async (values) => {
			// Workers AI model docs define BGE-M3's batched input as `{ text: string[] }`.
			// Keep the complete provider output behind the validator above.
			// https://developers.cloudflare.com/workers-ai/models/bge-m3/
			return env.AI.run(SEMANTIC_EMBEDDING_MODEL, { text: values });
		},
	});
}

export function createSemanticIndexProvider(
	env: Env,
	mailboxId: string,
): SemanticIndexRuntimeProvider {
	const index = env.SEMANTIC_INDEX;
	if (!index) throw new Error("Semantic Vectorize binding is unavailable");
	const embed = createSemanticEmbeddingRunner(env, {
		feature: "semantic_message_index",
		mailboxId,
	});
	return {
		embed,
		upsert: (vectors) => index.upsert(vectors),
		deleteByIds: (ids) => index.deleteByIds(ids),
		getByIds: async (ids) => (await index.getByIds(ids)).map((vector) => ({
			id: vector.id,
		})),
	};
}
