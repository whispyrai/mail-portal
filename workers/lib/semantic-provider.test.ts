import assert from "node:assert/strict";
import test from "node:test";
import type { AiUsageDecision } from "./ai-cost-control.ts";
import {
	estimateSemanticEmbeddingCostMicros,
	runCostedSemanticEmbedding,
} from "./semantic-provider.ts";
import { SemanticIndexDeferredError } from "./semantic-index-runtime.ts";

function allowDecision(): AiUsageDecision {
	return {
		decision: "allow",
		mode: "paid",
		tier: "cheap",
		model: "@cf/baai/bge-m3",
		reservationId: "reservation",
		ledgerRecorded: true,
		reviewRequired: false,
	};
}

test("semantic embedding reserves conservatively and settles one batched inference", async () => {
	const events: string[] = [];
	let reserved = 0;
	const vectors = await runCostedSemanticEmbedding({
		feature: "semantic_message_index",
		mailboxId: "team@example.com",
		texts: ["hello", "أهلاً"],
		cost: {
			async beginUsage(input) {
				events.push("reserve");
				reserved = input.estimatedCostMicros;
				return allowDecision();
			},
			async startUsage() {
				events.push("start");
				return true;
			},
			async completeUsage(_id, actual) {
				events.push(`complete:${actual.actualCostMicros}`);
			},
			async failUsage() {
				events.push("fail");
			},
		},
		async runModel() {
			events.push("provider");
			return { data: [[1, 0], [0, 1]], shape: [2, 2] };
		},
	});
	assert.deepEqual(vectors, [[1, 0], [0, 1]]);
	assert.equal(reserved, estimateSemanticEmbeddingCostMicros(["hello", "أهلاً"]));
	assert.deepEqual(events, ["reserve", "start", "provider", `complete:${reserved}`]);
});

test("semantic embedding never dispatches when the budget guard blocks", async () => {
	let providerCalls = 0;
	await assert.rejects(runCostedSemanticEmbedding({
		feature: "semantic_query_embedding",
		actorUserId: "user-1",
		texts: ["contract timing"],
		cost: {
			async beginUsage() {
				return {
					decision: "block",
					reason: "admin_review_required",
					reviewRequired: true,
					fallback: "deterministic_only",
					ledgerRecorded: true,
				};
			},
			async startUsage() { return true; },
			async completeUsage() {},
			async failUsage() {},
		},
		async runModel() {
			providerCalls += 1;
			return { data: [[1]] };
		},
	}), SemanticIndexDeferredError);
	assert.equal(providerCalls, 0);
});

test("semantic embedding rejects malformed provider output and fails the reservation", async () => {
	const failures: string[] = [];
	await assert.rejects(runCostedSemanticEmbedding({
		feature: "semantic_message_index",
		texts: ["one", "two"],
		cost: {
			async beginUsage() { return allowDecision(); },
			async startUsage() { return true; },
			async completeUsage() {},
			async failUsage(_id, failure) { failures.push(failure.errorCode); },
		},
		async runModel() { return { data: [[1, 2]] }; },
	}), /unexpected vector count/);
	assert.deepEqual(failures, ["Error"]);
});
