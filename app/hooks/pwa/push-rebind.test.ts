import assert from "node:assert/strict";
import test from "node:test";
import { rebindExistingPushSubscription } from "./push-rebind.ts";

test("an existing browser subscription is rebound to the authenticated mailbox user", async () => {
	const payloads: unknown[] = [];
	const result = await rebindExistingPushSubscription(
		{
			pushManager: {
				async getSubscription() {
					return {
						toJSON: () => ({
							endpoint: "https://push.example/device",
							keys: { p256dh: "public-key", auth: "auth-secret" },
						}),
					};
				},
			},
		},
		async (payload) => {
			payloads.push(payload);
		},
	);

	assert.equal(result, "rebound");
	assert.deepEqual(payloads, [
		{
			endpoint: "https://push.example/device",
			keys: { p256dh: "public-key", auth: "auth-secret" },
		},
	]);
});

test("rebind safely skips browsers without an existing subscription", async () => {
	let registered = false;
	const result = await rebindExistingPushSubscription(
		{
			pushManager: {
				async getSubscription() {
					return null;
				},
			},
		},
		async () => {
			registered = true;
		},
	);

	assert.equal(result, "skipped");
	assert.equal(registered, false);
});
