import assert from "node:assert/strict";
import test from "node:test";
import { AgentActiveRunRegistry, throwIfAgentRunAborted } from "./agent-active-runs.ts";
import { trackAgentStreamResponse } from "./agent-stream-lifecycle.ts";
import { runLiveAuthorizedMutation } from "./live-authorized-read.ts";

function begin(
	registry: AgentActiveRunRegistry,
	input: Partial<Parameters<AgentActiveRunRegistry["begin"]>[0]> = {},
) {
	return registry.begin({
		requestId: "request-1",
		connectionId: "connection-1",
		actorUserId: "user-1",
		actorSessionVersion: 3,
		...input,
	});
}

test("client cancellation aborts once and cleanup is idempotent", () => {
	const registry = new AgentActiveRunRegistry();
	const client = new AbortController();
	const run = begin(registry, { clientSignal: client.signal });
	let aborts = 0;
	run.signal.addEventListener("abort", () => { aborts += 1; });
	client.abort(new DOMException("Stopped", "AbortError"));
	client.abort();
	assert.equal(run.signal.aborted, true);
	assert.equal(run.wasRevoked, false);
	assert.equal(aborts, 1);
	assert.throws(() => throwIfAgentRunAborted(run.signal), /Stopped/);
	run.finish();
	run.finish();
	assert.equal(registry.size, 0);
});

test("actor reconciliation aborts only stale exact generations", () => {
	const registry = new AgentActiveRunRegistry();
	const stale = begin(registry, { requestId: "stale", actorSessionVersion: 2 });
	const current = begin(registry, { requestId: "current", actorSessionVersion: 3 });
	const other = begin(registry, {
		requestId: "other",
		actorUserId: "user-2",
		actorSessionVersion: 1,
	});
	registry.abortStaleActorRuns("user-1", 3);
	assert.equal(stale.signal.aborted, true);
	assert.equal(stale.wasRevoked, true);
	assert.equal(current.signal.aborted, false);
	assert.equal(other.signal.aborted, false);
	registry.abortStaleActorRuns("user-1", null);
	assert.equal(current.signal.aborted, true);
	assert.equal(other.signal.aborted, false);
});

test("mailbox reconciliation preserves regranted connections and fails closed", () => {
	const registry = new AgentActiveRunRegistry();
	const regranted = begin(registry, { requestId: "valid" });
	const revoked = begin(registry, {
		requestId: "revoked",
		connectionId: "connection-2",
	});
	registry.abortUnauthorizedConnectionRuns(new Set(["connection-1"]));
	assert.equal(regranted.signal.aborted, false);
	assert.equal(revoked.signal.aborted, true);
	registry.abortAll();
	assert.equal(regranted.signal.aborted, true);
});

test("duplicate request identity aborts the displaced run", () => {
	const registry = new AgentActiveRunRegistry();
	const first = begin(registry);
	const second = begin(registry);
	assert.equal(first.signal.aborted, true);
	assert.equal(first.wasRevoked, false);
	assert.equal(second.signal.aborted, false);
	first.finish();
	assert.equal(registry.size, 1);
	second.finish();
	assert.equal(registry.size, 0);
});

test("revocation preserves a mutation already past its live gate and blocks the next tool", async () => {
	const registry = new AgentActiveRunRegistry();
	const run = begin(registry);
	let commit!: (value: { draftId: string }) => void;
	const committed = new Promise<{ draftId: string }>((resolve) => { commit = resolve; });
	let checks = 0;
	const mutation = runLiveAuthorizedMutation(
		async () => {
			checks += 1;
			return true;
		},
		() => committed,
	);
	await Promise.resolve();
	registry.abortStaleActorRuns("user-1", 4);
	commit({ draftId: "draft-1" });
	assert.deepEqual(await mutation, { draftId: "draft-1" });
	assert.equal(checks, 1);
	assert.throws(() => throwIfAgentRunAborted(run.signal), /Mail access revoked/);
});

test("nonterminal stream output keeps later work revocable until the body terminates", async () => {
	const registry = new AgentActiveRunRegistry();
	const run = begin(registry);
	let continueStream!: () => void;
	const gate = new Promise<void>((resolve) => { continueStream = resolve; });
	let pulls = 0;
	const source = new ReadableStream<Uint8Array>({
		async pull(controller) {
			pulls += 1;
			if (pulls === 1) {
				controller.enqueue(new TextEncoder().encode("nonterminal-error-part"));
				return;
			}
			await gate;
			throwIfAgentRunAborted(run.signal);
			controller.enqueue(new TextEncoder().encode("later-provider-work"));
			controller.close();
		},
	});
	const response = trackAgentStreamResponse(
		new Response(source),
		run.signal,
		() => run.finish(),
	);
	const reader = response.body!.getReader();
	const first = await reader.read();
	assert.equal(new TextDecoder().decode(first.value), "nonterminal-error-part");
	assert.equal(registry.size, 1);
	registry.abortAll();
	continueStream();
	assert.deepEqual(await reader.read(), { done: true, value: undefined });
	assert.equal(registry.size, 0);
});
