import assert from "node:assert/strict";
import test from "node:test";
import { fetchPushHealth, PushHealthApiError } from "./push-health.ts";

const validResponse = {
	state: "healthy",
	pendingCount: 0,
	refreshedAt: "2026-07-12T12:00:00.000Z",
	devices: [
		{
			id: "device-1",
			label: "Safari on iPhone",
			registeredAt: "2026-07-10T09:00:00.000Z",
			lastAttemptAt: "2026-07-12T11:59:00.000Z",
			lastAcceptedAt: "2026-07-12T11:59:00.000Z",
			health: "accepted",
			consecutiveFailures: 0,
		},
	],
} as const;

test("push health uses the actor-private Mailbox route and shared validator", async () => {
	let requestedUrl = "";
	let requestedInit: RequestInit | undefined;
	const result = await fetchPushHealth(
		"team+sales@example.com",
		async (input, init) => {
			requestedUrl = String(input);
			requestedInit = init;
			return Response.json(validResponse);
		},
	);

	assert.equal(
		requestedUrl,
		"/api/v1/mailboxes/team%2Bsales%40example.com/push-health",
	);
	assert.equal(requestedInit?.method, "GET");
	assert.equal(requestedInit?.credentials, "same-origin");
	assert.equal(requestedInit?.cache, "no-store");
	assert.deepEqual(result, validResponse);
});

test("push health rejects malformed public data before it can enter the cache", async () => {
	await assert.rejects(
		fetchPushHealth("team@example.com", async () => Response.json({
			...validResponse,
			devices: [{ ...validResponse.devices[0], endpoint: "https://secret.example" }],
		})),
		/Push health response is invalid/,
	);
});

test("push health preserves HTTP status for synchronous access-revocation handling", async () => {
	await assert.rejects(
		fetchPushHealth(
			"team@example.com",
			async () => Response.json({ error: "Forbidden" }, { status: 403 }),
		),
		(error: unknown) => error instanceof PushHealthApiError && error.status === 403,
	);
});
