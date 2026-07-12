import assert from "node:assert/strict";
import test from "node:test";
import { sendWebPush } from "./send.ts";

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

test("web push transport timeout prevents or aborts provider fetch", async () => {
	const receiver = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
	);
	const vapidKeys = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
	);
	const vapidJwk = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
	assert.ok(vapidJwk.d);
	const originalFetch = globalThis.fetch;
	let observedSignal: AbortSignal | undefined;
	globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
		observedSignal = init?.signal ?? undefined;
		return new Promise<Response>((_resolve, reject) => {
			if (observedSignal?.aborted) {
				reject(new DOMException("aborted", "AbortError"));
				return;
			}
			observedSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
		});
	}) as typeof fetch;
	try {
		const result = await sendWebPush({
			endpoint: "https://push.example/device",
			p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
			auth: b64url(new Uint8Array(16)),
		}, "{}", {
			subject: "mailto:ops@example.com",
			publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey))),
			privateKey: vapidJwk.d,
		}, { timeoutMs: 5 });
		assert.equal(result.ok, false);
		assert.equal(observedSignal === undefined || observedSignal.aborted, true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an externally aborted transport never starts provider fetch after crypto", async () => {
	const receiver = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
	);
	const vapidKeys = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
	);
	const vapidJwk = await crypto.subtle.exportKey("jwk", vapidKeys.privateKey);
	assert.ok(vapidJwk.d);
	const controller = new AbortController();
	controller.abort();
	const originalFetch = globalThis.fetch;
	let fetched = false;
	globalThis.fetch = (async () => {
		fetched = true;
		return new Response(null, { status: 201 });
	}) as typeof fetch;
	try {
		const result = await sendWebPush({
			endpoint: "https://push.example/device",
			p256dh: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", receiver.publicKey))),
			auth: b64url(new Uint8Array(16)),
		}, "{}", {
			subject: "mailto:ops@example.com",
			publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey("raw", vapidKeys.publicKey))),
			privateKey: vapidJwk.d,
		}, { signal: controller.signal, timeoutMs: 50 });
		assert.equal(result.ok, false);
		assert.equal(fetched, false);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
