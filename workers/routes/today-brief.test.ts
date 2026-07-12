import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	createTodayBriefRoutes,
	type TodayBriefRouteDependencies,
} from "./today-brief.ts";

function app(input: {
	session?: { sub: string };
	stub?: unknown;
	run?: TodayBriefRouteDependencies["run"];
}) {
	const root = new Hono();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session as never);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		await next();
	});
	root.route(
		"/",
		createTodayBriefRoutes({
			run: input.run ?? (async () => ({ state: "no_attention" })),
		}) as never,
	);
	return root;
}

function request(body: BodyInit, mailbox = "team%40example.com") {
	return new Request(
		`http://test/api/v1/mailboxes/${mailbox}/today-brief`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
	);
}

test("auth and an authorized mailbox stub win before request processing", async () => {
	let called = false;
	const withoutSession = await app({ stub: {} }).request(
		request(JSON.stringify({ timeZone: "UTC" })),
	);
	assert.equal(withoutSession.status, 401);

	const withoutStub = await app({ session: { sub: "user-a" } }).request(
		request(JSON.stringify({ timeZone: "UTC" })),
	);
	assert.equal(withoutStub.status, 403);

	const authorized = await app({
		session: { sub: "user-a" },
		stub: {},
		run: async (input) => {
			called = true;
			assert.equal(input.actorUserId, "user-a");
			assert.equal(input.mailboxId, "team@example.com");
			assert.equal(input.day.timeZone, "UTC");
			return { state: "no_attention" };
		},
	}).request(request(JSON.stringify({ timeZone: "UTC" })));
	assert.equal(authorized.status, 200);
	assert.equal(called, true);
});

test("strictly validates timezone-only input and UTF-8 body bounds", async () => {
	const server = app({ session: { sub: "user-a" }, stub: {} });
	for (const body of [
		{},
		{ timeZone: "Mars/Olympus_Mons" },
		{ timeZone: "UTC", candidateIds: ["mail-from-client"] },
	]) {
		const response = await server.request(request(JSON.stringify(body)));
		assert.equal(response.status, 400);
	}

	const oversized = await server.request(
		request(JSON.stringify({ timeZone: "x".repeat(2_000) })),
	);
	assert.equal(oversized.status, 413);

	const invalidUtf8 = await server.request(request(new Uint8Array([0xff])));
	assert.equal(invalidUtf8.status, 400);
});

test("provider failures expose no prompt or mail content", async () => {
	const response = await app({
		session: { sub: "user-a" },
		stub: {},
		run: async () => {
			throw new Error("secret prompt and sender content");
		},
	}).request(request(JSON.stringify({ timeZone: "UTC" })));
	assert.equal(response.status, 502);
	const text = await response.text();
	assert.doesNotMatch(text, /secret prompt|sender content/);
	assert.match(text, /Today remains fully usable/);
});
