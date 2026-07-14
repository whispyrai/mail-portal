import assert from "node:assert/strict";
import test from "node:test";
import {
	AgentUsageSettlement,
	isTerminalAgentStreamFailure,
	trackAgentStreamResponse,
	type AgentStreamTermination,
} from "./agent-stream-lifecycle.ts";

const liveSignal = () => new AbortController().signal;

test("a recovered error part with root usage remains a completed stream", () => {
	assert.equal(isTerminalAgentStreamFailure({
		finishReason: "stop",
		streamError: new Error("recoverable tool error"),
		totalUsage: { inputTokens: 10, outputTokens: 2 },
	}), false);
	assert.equal(isTerminalAgentStreamFailure({
		finishReason: "error",
		streamError: undefined,
		totalUsage: {},
	}), true);
});

test("tracked Agent responses terminate once on body completion", async () => {
	const terminations: AgentStreamTermination[] = [];
	const response = trackAgentStreamResponse(
		new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("first"));
				controller.enqueue(new TextEncoder().encode("second"));
				controller.close();
			},
		}), { status: 202, headers: { "x-agent": "tracked" } }),
		liveSignal(),
		(termination) => terminations.push(termination),
	);
	assert.equal(response.status, 202);
	assert.equal(response.headers.get("x-agent"), "tracked");
	assert.equal(await response.text(), "firstsecond");
	assert.deepEqual(terminations, [{ kind: "done" }]);
});

test("tracked Agent responses distinguish body errors and consumer cancellation", async () => {
	const streamError = new Error("provider stream failed");
	const errored: AgentStreamTermination[] = [];
	const errorResponse = trackAgentStreamResponse(
		new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(streamError);
			},
		})),
		liveSignal(),
		(termination) => errored.push(termination),
	);
	await assert.rejects(() => errorResponse.text(), /provider stream failed/);
	assert.deepEqual(errored, [{ kind: "error", error: streamError }]);

	let sourceCancelled: unknown;
	const cancelled: AgentStreamTermination[] = [];
	const cancelResponse = trackAgentStreamResponse(
		new Response(new ReadableStream<Uint8Array>({
			cancel(reason) {
				sourceCancelled = reason;
			},
		})),
		liveSignal(),
		(termination) => cancelled.push(termination),
	);
	await cancelResponse.body?.cancel("socket closed");
	assert.equal(sourceCancelled, "socket closed");
	assert.deepEqual(cancelled, [{ kind: "cancel", reason: "socket closed" }]);
});

test("Agent abort cancels a pending source read and terminates without provider output", async () => {
	const abort = new AbortController();
	const reason = new DOMException("Mail access revoked", "AbortError");
	let sourceCancelled: unknown;
	const terminations: AgentStreamTermination[] = [];
	const response = trackAgentStreamResponse(
		new Response(new ReadableStream<Uint8Array>({
			pull() {
				return new Promise<void>(() => {});
			},
			cancel(cancelReason) {
				sourceCancelled = cancelReason;
			},
		})),
		abort.signal,
		(termination) => terminations.push(termination),
	);
	const pendingRead = response.body!.getReader().read();
	abort.abort(reason);
	assert.deepEqual(await pendingRead, { done: true, value: undefined });
	assert.equal(sourceCancelled, reason);
	assert.deepEqual(terminations, [{ kind: "cancel", reason }]);
});

test("usage settlement shares concurrent work and retries one transient failure", async () => {
	const settlement = new AgentUsageSettlement();
	let attempts = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const operation = async () => {
		attempts += 1;
		if (attempts === 1) throw new Error("temporary D1 failure");
		await gate;
		return true;
	};
	const first = settlement.settle(operation);
	const concurrent = settlement.settle(async () => {
		assert.fail("concurrent terminal operation must share the first settlement");
		return false;
	});
	release();
	await first;
	await concurrent;
	assert.equal(attempts, 2);
	assert.equal(settlement.settled, true);
	await settlement.settle(async () => assert.fail("already settled"));
});

test("failed settlement remains retryable after both attempts reject", async () => {
	const settlement = new AgentUsageSettlement();
	let attempts = 0;
	await assert.rejects(
		() => settlement.settle(async () => {
			attempts += 1;
			throw new Error("D1 unavailable");
		}),
		/D1 unavailable/,
	);
	assert.equal(attempts, 2);
	assert.equal(settlement.settled, false);
	await settlement.settle(async () => true);
	assert.equal(settlement.settled, true);
});
