import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api.ts";
import { searchSemanticEvidence } from "./semantic-search.ts";

const completeResponse = {
	state: "complete",
	accessChanged: false,
	results: [],
	mailboxes: [{
		mailboxId: "mailbox-1",
		mailboxAddress: "team@example.com",
		state: "complete",
	}],
};

test("semantic search posts a normalized body without putting the query in the URL", async () => {
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	let observedUrl = "";
	let observedOptions: RequestInit | undefined;
	globalThis.fetch = async (url, options) => {
		observedUrl = String(url);
		observedOptions = options;
		return new Response(JSON.stringify(completeResponse), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	};
	try {
		assert.deepEqual(await searchSemanticEvidence({
			query: "  renewal risk  ",
			signal: controller.signal,
		}), completeResponse);
		assert.equal(observedUrl, "/api/v1/semantic-search");
		assert.equal(observedOptions?.method, "POST");
		assert.equal(observedOptions?.cache, "no-store");
		assert.equal(observedOptions?.credentials, "same-origin");
		assert.ok(observedOptions?.signal instanceof AbortSignal);
		assert.equal(observedOptions?.signal?.aborted, false);
		assert.deepEqual(JSON.parse(String(observedOptions?.body)), { query: "renewal risk" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("semantic search aborts a stalled browser request at its elapsed-time bound", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, options) => new Promise<Response>((_resolve, reject) => {
		options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
	});
	try {
		await assert.rejects(
			() => searchSemanticEvidence({ query: "renewal risk", timeoutMs: 5 }),
			(error) => error instanceof ApiError &&
				error.status === 504 &&
				error.message === "Meaning search took too long. Try again.",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("semantic search keeps its elapsed-time bound through response body parsing", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, options) => ({
		ok: true,
		status: 200,
		json: () => new Promise((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
		}),
	}) as Response;
	try {
		await assert.rejects(
			() => searchSemanticEvidence({ query: "renewal risk", timeoutMs: 5 }),
			(error) => error instanceof ApiError && error.status === 504,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("semantic search rejects malformed success responses", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		...completeResponse,
		results: [{ mailboxId: "mailbox-1", excerpt: "unsafe partial shape" }],
	}), { status: 200, headers: { "Content-Type": "application/json" } });
	try {
		await assert.rejects(() => searchSemanticEvidence({ query: "renewal risk" }));
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("semantic search maps server failures to safe status-aware errors", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({
		error: "query text should never be reflected",
	}), { status: 403, headers: { "Content-Type": "application/json" } });
	try {
		await assert.rejects(
			() => searchSemanticEvidence({ query: "private acquisition plan" }),
			(error) => error instanceof ApiError &&
				error.status === 403 &&
				error.message === "Mailbox access changed." &&
				!error.message.includes("acquisition"),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("semantic search validates requests before making a network call", async () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = async () => {
		calls += 1;
		return new Response();
	};
	try {
		await assert.rejects(() => searchSemanticEvidence({ query: "x" }));
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
