import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createPushSubscriptionRoutes,
	type PushSubscriptionOperations,
} from "./push-subscriptions.ts";

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

const subscription = {
	endpoint: "https://push.example/device",
	keys: {
		p256dh: b64url(Uint8Array.from({ length: 65 }, (_, index) => index === 0 ? 4 : index)),
		auth: b64url(Uint8Array.from({ length: 16 }, (_, index) => index)),
	},
};

function app(operations: PushSubscriptionOperations, revalidate: () => Promise<boolean>) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		c.set("session", { sub: "actor-1", email: "a@example.com", role: "AGENT", mailbox: "team@example.com" });
		await next();
	});
	root.route("/", createPushSubscriptionRoutes({ operations: () => operations, revalidateAccess: revalidate }));
	return root;
}

test("in-flight revocation removes a newly rebound capability before returning forbidden", async () => {
	const calls: string[] = [];
	const result = await app({
		upsert: async () => { calls.push("upsert"); return { id: "device-1", deviceLabel: "Chrome", generation: 7 }; },
		remove: async (id, userId, generation) => { calls.push(`remove:${id}:${userId}:${generation}`); return true; },
	}, async () => false).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/push-subscriptions",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) },
	);
	assert.equal(result.status, 403);
	assert.deepEqual(calls, ["upsert", "remove:device-1:actor-1:7"]);
});

test("stale post-revocation cleanup cannot delete a newer same-actor rebind", async () => {
	let currentGeneration = 1;
	let capabilityPresent = true;
	const result = await app({
		upsert: async () => ({
			id: "device-1",
			deviceLabel: "Chrome",
			generation: currentGeneration,
		}),
		remove: async (_id, _userId, generation) => {
			if (generation !== currentGeneration) return false;
			capabilityPresent = false;
			return true;
		},
	}, async () => {
		currentGeneration = 2;
		return false;
	}).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/push-subscriptions",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription) },
	);
	assert.equal(result.status, 403);
	assert.equal(currentGeneration, 2);
	assert.equal(capabilityPresent, true);
});

test("delete revalidates after mutation and legacy raw device-list GET is absent", async () => {
	const operations: PushSubscriptionOperations = {
		upsert: async () => ({ id: "device-1", deviceLabel: "Chrome", generation: 1 }),
		remove: async () => true,
	};
	const revoked = await app(operations, async () => false).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/push-subscriptions/device-1",
		{ method: "DELETE" },
	);
	assert.equal(revoked.status, 403);
	const legacy = await app(operations, async () => true).request(
		"https://mail.example/api/v1/mailboxes/team%40example.com/push-subscriptions",
	);
	assert.equal(legacy.status, 404);
});
