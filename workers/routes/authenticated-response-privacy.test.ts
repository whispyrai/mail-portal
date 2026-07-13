import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	isSensitiveAuthenticationPath,
	privateNoStore,
	withPrivateNoStore,
} from "../lib/response-privacy.ts";

test("API responses are private and non-cacheable while public assets stay unaffected", async () => {
	const app = new Hono();
	app.use("/api/*", privateNoStore);
	app.get("/api/private", () =>
		new Response(JSON.stringify({ subject: "private mail" }), {
			headers: { "Content-Type": "application/json" },
		}),
	);
	app.get("/manifest.webmanifest", (c) => c.json({ name: "Mail" }));

	const apiResponse = await app.request("/api/private");
	assert.equal(apiResponse.status, 200);
	assert.deepEqual(await apiResponse.json(), { subject: "private mail" });
	assert.equal(apiResponse.headers.get("cache-control"), "private, no-store");

	const manifestResponse = await app.request("/manifest.webmanifest");
	assert.equal(manifestResponse.status, 200);
	assert.equal(manifestResponse.headers.get("cache-control"), null);
});

test("private response middleware covers empty, error, and missing API responses", async () => {
	const app = new Hono();
	app.onError((_error, c) => c.json({ error: "Unavailable" }, 500));
	app.use("/api/*", privateNoStore);
	app.get("/api/empty", (c) => c.body(null, 204));
	app.get("/api/redirect", () => Response.redirect("https://example.com/private"));
	app.get("/api/error", () => {
		throw new Error("private infrastructure detail");
	});

	for (const [path, status] of [
		["/api/empty", 204],
		["/api/redirect", 302],
		["/api/error", 500],
		["/api/missing", 404],
	] as const) {
		const response = await app.request(path);
		assert.equal(response.status, status);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
});

test("MCP response hardening preserves streaming transport metadata and body", async () => {
	const source = new Response("event: message\ndata: private mail\n\n", {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream",
			"mcp-session-id": "session-1",
			"Cache-Control": "no-cache",
		},
	});

	const response = withPrivateNoStore(source);

	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "text/event-stream");
	assert.equal(response.headers.get("mcp-session-id"), "session-1");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(await response.text(), "event: message\ndata: private mail\n\n");
});

test("OAuth credentials and authentication state are private while discovery stays public", () => {
	for (const path of [
		"/authorize",
		"/token",
		"/register",
		"/mcp",
		"/login",
		"/logout",
		"/account/recover",
		"/account/recover/request",
	]) {
		assert.equal(isSensitiveAuthenticationPath(path), true, path);
	}
	for (const path of [
		"/.well-known/oauth-authorization-server",
		"/.well-known/oauth-protected-resource/mcp",
		"/landing",
		"/assets/app.js",
	]) {
		assert.equal(isSensitiveAuthenticationPath(path), false, path);
	}
});
