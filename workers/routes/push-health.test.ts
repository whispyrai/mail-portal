import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { PushHealthResponse } from "../../shared/push-health.ts";
import { createPushHealthRoutes } from "./push-health.ts";
import type { MailboxContext } from "../lib/mailbox.ts";

const response: PushHealthResponse = {
	state: "no_devices",
	pendingCount: 0,
	refreshedAt: "2026-07-12T10:00:00.000Z",
	devices: [],
};

function app(input: {
	read?: (userId: string) => Promise<PushHealthResponse>;
	revalidate?: () => Promise<boolean>;
	withSession?: boolean;
}) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		if (input.withSession !== false) c.set("session", {
			sub: "actor-1", email: "actor@example.com", role: "AGENT", mailbox: "team@example.com",
		});
		await next();
	});
	root.route("/", createPushHealthRoutes({
		read: async (_c, userId) => (input.read ?? (async () => response))(userId),
		revalidateAccess: input.revalidate ?? (async () => true),
	}));
	return root;
}

test("push health derives the actor and returns only the strict content-free contract", async () => {
	let actor = "";
	const result = await app({ read: async (userId) => { actor = userId; return response; } })
		.request("https://mail.example/api/v1/mailboxes/team%40example.com/push-health");
	assert.equal(result.status, 200);
	assert.equal(actor, "actor-1");
	assert.deepEqual(await result.json(), response);
});

test("post-read revocation suppresses health and read failures", async () => {
	for (const read of [
		async () => response,
		async () => { throw new Error("storage secret"); },
	]) {
		const result = await app({ read, revalidate: async () => false })
			.request("https://mail.example/api/v1/mailboxes/team%40example.com/push-health");
		assert.equal(result.status, 403);
		assert.deepEqual(await result.json(), { error: "Forbidden" });
	}
});

test("missing session and malformed storage output disclose no health", async () => {
	const unauthenticated = await app({ withSession: false })
		.request("https://mail.example/api/v1/mailboxes/team%40example.com/push-health");
	assert.equal(unauthenticated.status, 401);
	const malformed = await app({ read: async () => ({ ...response, secret: "endpoint" }) as never })
		.request("https://mail.example/api/v1/mailboxes/team%40example.com/push-health");
	assert.equal(malformed.status, 502);
	assert.deepEqual(await malformed.json(), { error: "Push notification health is unavailable" });
});

test("storage failures return stable redacted health errors", async () => {
	const original = console.error;
	console.error = () => undefined;
	try {
		const result = await app({ read: async () => { throw new Error("secret endpoint"); } })
			.request("https://mail.example/api/v1/mailboxes/team%40example.com/push-health");
		assert.equal(result.status, 502);
		assert.doesNotMatch(await result.text(), /secret endpoint/);
	} finally {
		console.error = original;
	}
});
