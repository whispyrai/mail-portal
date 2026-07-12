import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { AiSearchInterpreterAccessRevokedError } from "../lib/ai-search-interpreter-runtime.ts";
import type { Env } from "../types.ts";
import {
	createAiSearchInterpreterRoutes,
	type AiSearchInterpreterRouteContext,
	type AiSearchInterpreterRouteDependencies,
} from "./ai-search-interpreter.ts";

const session = {
	sub: "user-1",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "team@example.com",
} as SessionClaims;

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: AiSearchInterpreterRouteDependencies["run"];
}) {
	const root = new Hono<AiSearchInterpreterRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		await next();
	});
	root.route(
		"/",
		createAiSearchInterpreterRoutes({
			run: input.run ?? (async () => ({ state: "unsupported" })),
		}),
	);
	return root;
}

function request(body: BodyInit, mailboxId = "Team%40Example.com") {
	return new Request(
		`http://test/api/v1/mailboxes/${mailboxId}/search/interpret`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
	);
}

const validBody = JSON.stringify({
	intent: "  unread\n proposals from Sam  ",
	timezone: "Africa/Cairo",
});

test("authentication and authorized Mailbox resolution precede body consumption", async () => {
	let calls = 0;
	const run = async () => { calls += 1; return { state: "unsupported" as const }; };
	assert.equal((await app({ stub: {}, run }).request(request("not-json"))).status, 401);
	assert.equal((await app({ session, run }).request(request("not-json"))).status, 403);
	assert.equal(calls, 0);
});

test("route derives trusted actor and mailbox and passes normalized strict intent only", async () => {
	let received: Record<string, unknown> | undefined;
	const response = await app({
		session,
		stub: { authorized: true },
		run: async (input) => {
			received = input as unknown as Record<string, unknown>;
			return { state: "ambiguous" };
		},
	}).request(request(validBody));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { state: "ambiguous" });
	assert.deepEqual(
		{
			actorUserId: received?.actorUserId,
			mailboxId: received?.mailboxId,
			request: received?.request,
			stub: received?.stub,
		},
		{
			actorUserId: "user-1",
			mailboxId: "team@example.com",
			request: {
				intent: "unread proposals from Sam",
				timezone: "Africa/Cairo",
			},
			stub: { authorized: true },
		},
	);
});

test("request body is exact, stream-bounded, valid UTF-8, and timezone-aware", async () => {
	const server = app({ session, stub: {} });
	for (const body of [
		{},
		{ intent: "mail" },
		{ intent: "mail", timezone: "Not/AZone" },
		{ intent: "mail", timezone: "UTC", execute: true },
		{ intent: "x".repeat(501), timezone: "UTC" },
	]) {
		assert.equal(
			(await server.request(request(JSON.stringify(body)))).status,
			400,
		);
	}
	assert.equal(
		(await server.request(request(JSON.stringify({
			intent: "x".repeat(2_050),
			timezone: "UTC",
		})))).status,
		413,
	);
	assert.equal(
		(await server.request(request(new Uint8Array([0xff])))).status,
		400,
	);
});

test("revocation is forbidden and generic failure exposes no intent or model output", async () => {
	const revoked = await app({
		session,
		stub: {},
		run: async () => { throw new AiSearchInterpreterAccessRevokedError(); },
	}).request(request(validBody));
	assert.equal(revoked.status, 403);

	const failed = await app({
		session,
		stub: {},
		run: async () => {
			throw new Error("unread proposals and private model output");
		},
	}).request(request(validBody));
	assert.equal(failed.status, 502);
	const text = await failed.text();
	assert.doesNotMatch(text, /unread proposals|private model output/);
	assert.match(text, /Ordinary search remains available/);
});

test("interpreter route has no search execution or content logging seam", async () => {
	const source = await import("node:fs/promises").then(({ readFile }) =>
		readFile(new URL("./ai-search-interpreter.ts", import.meta.url), "utf8"),
	);
	assert.doesNotMatch(source, /searchEmails|countSearchResults|SearchOperations/);
	assert.doesNotMatch(source, /console\.(?:log|error)|intent\s*:/);
});
