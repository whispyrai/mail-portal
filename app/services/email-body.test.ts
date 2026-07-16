import assert from "node:assert/strict";
import test from "node:test";
import api from "./api.ts";

test("email body API returns text and links caller cancellation to fetch", async () => {
	const originalFetch = globalThis.fetch;
	let observedUrl = "";
	let observedSignal: AbortSignal | null | undefined;
	let releaseFetch: ((response: Response) => void) | undefined;
	let markIntercepted: (() => void) | undefined;
	const intercepted = new Promise<void>((resolve) => { markIntercepted = resolve; });
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		observedUrl = String(input);
		observedSignal = init?.signal;
		markIntercepted?.();
		return new Promise<Response>((resolve) => { releaseFetch = resolve; });
	}) as typeof fetch;
	try {
		const controller = new AbortController();
		const result = api.getEmailBody("team@example.com", "message-1", {
			signal: controller.signal,
		});
		await intercepted;
		assert.equal(
			observedUrl,
			"/api/v1/mailboxes/team@example.com/emails/message-1/body",
		);
		controller.abort();
		assert.equal(observedSignal?.aborted, true);
		releaseFetch?.(new Response("authoritative body", {
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		}));
		assert.equal(await result, "authoritative body");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
