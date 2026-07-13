import assert from "node:assert/strict";
import test from "node:test";
import type {
	SemanticIndexJob,
	SemanticIndexReadiness,
	SemanticSubmittedJob,
} from "./semantic-index.ts";
import {
	advanceSemanticIndex,
	type SemanticIndexRuntimeMailbox,
	type SemanticIndexRuntimeProvider,
} from "./semantic-index-runtime.ts";

function readiness(state: SemanticIndexReadiness["state"]): SemanticIndexReadiness {
	return {
		state,
		processedMessages: 1,
		pendingJobs: state === "building" ? 1 : 0,
		submittedJobs: 0,
		sourceCurrentThrough: 1,
		currentSequence: 1,
	};
}

function setup(input?: {
	jobs?: SemanticIndexJob[];
	submitted?: SemanticSubmittedJob[];
	visible?: string[];
	embedError?: Error;
}) {
	const submittedJobs: SemanticSubmittedJob[] = [...(input?.submitted ?? [])];
	const retried: string[] = [];
	const confirmed: string[][] = [];
	const upserts: Array<Array<{ id: string; values: number[]; namespace: string }>> = [];
	const deletes: string[][] = [];
	const leaseDurations: number[] = [];
	const embeddingFeatures: string[] = [];
	const mailbox: SemanticIndexRuntimeMailbox = {
		async prepareSemanticIndex() {
			return readiness(submittedJobs.length === 0 && (input?.jobs?.length ?? 0) === 0 ? "complete" : "building");
		},
		async readSemanticIndexReadiness() {
			return readiness(submittedJobs.length === 0 ? "complete" : "building");
		},
		async listSubmittedSemanticIndexJobs() {
			return [...submittedJobs];
		},
		async confirmSemanticIndexVisibility(observations, observedAt) {
			confirmed.push(observations.filter((item) => item.visible).map((item) => item.vectorId));
			for (let index = submittedJobs.length - 1; index >= 0; index -= 1) {
				const job = submittedJobs[index]!;
				const isVisible = observations.find((item) => item.vectorId === job.vectorId)?.visible;
				if (
					(job.operation === "upsert" && isVisible) ||
					(job.operation === "delete" && !isVisible && observedAt - job.submittedAt >= 5 * 60 * 1_000)
				) {
					submittedJobs.splice(index, 1);
				}
			}
		},
		async leaseSemanticIndexJobs(_leaseToken, _leasedAt, leaseMs) {
			leaseDurations.push(leaseMs);
			return [...(input?.jobs ?? [])];
		},
		async submitSemanticIndexJobs(jobs, _mutationId, submittedAt) {
			const accepted: string[] = [];
			for (const job of jobs) {
				const operation = input?.jobs?.find((item) => item.vectorId === job.vectorId)?.operation;
				if (!operation) continue;
				submittedJobs.push({ vectorId: job.vectorId, operation, submittedAt });
				accepted.push(job.vectorId);
			}
			return accepted;
		},
		async retrySemanticIndexJobs(jobs) {
			retried.push(...jobs.map((job) => job.vectorId));
			return jobs.map((job) => job.vectorId);
		},
		async deferSemanticIndexJobs(jobs) {
			return jobs.map((job) => job.vectorId);
		},
	};
	const provider: SemanticIndexRuntimeProvider = {
		async embed(texts, feature) {
			embeddingFeatures.push(feature);
			if (input?.embedError) throw input.embedError;
			return texts.map((_, index) => [index + 1, 0.5]);
		},
		async upsert(vectors) {
			upserts.push(vectors);
			return { mutationId: "mutation-upsert" };
		},
		async deleteByIds(ids) {
			deletes.push(ids);
			return { mutationId: "mutation-delete" };
		},
		async getByIds() {
			return (input?.visible ?? []).map((id) => ({ id }));
		},
	};
	return {
		mailbox,
		provider,
		submittedJobs,
		retried,
		confirmed,
		upserts,
		deletes,
		leaseDurations,
		embeddingFeatures,
	};
}

test("semantic runtime leases beyond every mixed-turn provider timeout budget", async () => {
	const state = setup({
		jobs: [
			{ vectorId: "sm1_message", operation: "upsert", content: "message", leaseToken: "lease", attemptCount: 1 },
			{ vectorId: "sa1_attachment", operation: "upsert", content: "attachment", leaseToken: "lease", attemptCount: 1 },
			{ vectorId: "delete", operation: "delete", content: null, leaseToken: "lease", attemptCount: 1 },
		],
	});
	await advanceSemanticIndex({
		mailbox: state.mailbox,
		provider: state.provider,
		namespace: "mb1_namespace",
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(state.leaseDurations, [120_000]);
	assert.deepEqual(state.embeddingFeatures, [
		"semantic_message_index",
		"semantic_attachment_index",
	]);
	assert.deepEqual(state.deletes, [["delete"]]);
});

test("semantic runtime confirms eventual visibility and sends content-free vector records", async () => {
	const state = setup({
		submitted: [
			{ vectorId: "old-upsert", operation: "upsert", submittedAt: 1 },
			{ vectorId: "old-delete", operation: "delete", submittedAt: 1 },
		],
		visible: ["old-upsert"],
		jobs: [{
			vectorId: "sm1_next-upsert",
			operation: "upsert",
			content: "private evidence",
			leaseToken: "lease",
			attemptCount: 1,
		}],
	});
	await advanceSemanticIndex({
		mailbox: state.mailbox,
		provider: state.provider,
		namespace: "mb1_namespace",
		now: () => 1_000,
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(state.confirmed, [["old-upsert"]]);
	assert.deepEqual(state.submittedJobs, [
		{ vectorId: "old-delete", operation: "delete", submittedAt: 1 },
		{ vectorId: "sm1_next-upsert", operation: "upsert", submittedAt: 1_000 },
	]);
	assert.deepEqual(state.upserts, [[{
		id: "sm1_next-upsert",
		values: [1, 0.5],
		namespace: "mb1_namespace",
	}]]);
	assert.equal(JSON.stringify(state.upserts).includes("private evidence"), false);
});

test("semantic runtime batches deletes without embedding and retries provider failures", async () => {
	const deleteState = setup({
		jobs: [{ vectorId: "delete-me", operation: "delete", content: null, leaseToken: "lease", attemptCount: 1 }],
	});
	await advanceSemanticIndex({
		mailbox: deleteState.mailbox,
		provider: deleteState.provider,
		namespace: "mb1_namespace",
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(deleteState.deletes, [["delete-me"]]);
	assert.equal(deleteState.upserts.length, 0);

	const failed = setup({
		jobs: [{ vectorId: "sm1_retry-me", operation: "upsert", content: "evidence", leaseToken: "lease", attemptCount: 1 }],
		embedError: new TypeError("provider unavailable"),
	});
	await advanceSemanticIndex({
		mailbox: failed.mailbox,
		provider: failed.provider,
		namespace: "mb1_namespace",
		now: () => 5_000,
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(failed.retried, ["sm1_retry-me"]);
	assert.equal(failed.submittedJobs.length, 0);
});

test("semantic runtime rejects malformed embeddings before vector mutation", async () => {
	const state = setup({
		jobs: [{ vectorId: "sm1_bad-vector", operation: "upsert", content: "evidence", leaseToken: "lease", attemptCount: 1 }],
	});
	state.provider.embed = async () => [[Number.NaN]];
	await advanceSemanticIndex({
		mailbox: state.mailbox,
		provider: state.provider,
		namespace: "mb1_namespace",
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(state.retried, ["sm1_bad-vector"]);
	assert.equal(state.upserts.length, 0);
});

test("semantic runtime accounts attachment embeddings separately from Message embeddings", async () => {
	const state = setup({
		jobs: [
			{ vectorId: "sm1_message", operation: "upsert", content: "message", leaseToken: "lease", attemptCount: 1 },
			{ vectorId: "sa1_attachment", operation: "upsert", content: "attachment", leaseToken: "lease", attemptCount: 1 },
		],
	});
	await advanceSemanticIndex({
		mailbox: state.mailbox,
		provider: state.provider,
		namespace: "mb1_namespace",
		createLeaseToken: () => "lease",
	});
	assert.deepEqual(state.embeddingFeatures, [
		"semantic_message_index",
		"semantic_attachment_index",
	]);
	assert.equal(state.upserts.length, 2);
});
