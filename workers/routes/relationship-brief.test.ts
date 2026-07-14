import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import type { Env } from "../types.ts";
import { RelationshipBriefAccessRevokedError } from "../lib/relationship-brief-runtime.ts";
import {
	createRelationshipBriefRoutes,
	type RelationshipBriefRouteDependencies,
} from "./relationship-brief.ts";

const session: SessionClaims = {
	sub: "user-a",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "user@example.com",
};

const unavailable = { state: "unavailable" as const };

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: RelationshipBriefRouteDependencies["run"];
	revalidate?: () => Promise<boolean>;
}) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		c.set("authorizedMailboxId", "team@example.com");
		await next();
	});
	root.route("/", createRelationshipBriefRoutes({
		run: input.run ?? (async () => unavailable),
		revalidateAccess: input.revalidate ?? (async () => true),
	}));
	return root;
}

const path = "/api/v1/mailboxes/team%40example.com/people/person%2F1/relationship-brief";

test("authentication and authorized mailbox context win before body consumption", async () => {
	const oversized = "x".repeat(10_000);
	const unauthenticated = await app({ stub: {} }).request(path, {
		method: "POST",
		body: oversized,
	}, {} as Env);
	assert.equal(unauthenticated.status, 401);
	const unauthorized = await app({ session }).request(path, {
		method: "POST",
		body: oversized,
	}, {} as Env);
	assert.equal(unauthorized.status, 403);
});

test("route accepts only explicit refresh and derives actor/mailbox/Person scope server-side", async () => {
	let received: unknown;
	const response = await app({
		session,
		stub: { authorized: true },
		run: async (input) => {
			received = input;
			return unavailable;
		},
	}).request(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refresh: true }),
	}, {} as Env);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), unavailable);
	assert.deepEqual(received, {
		env: {},
		actorUserId: "user-a",
		mailboxId: "team@example.com",
		personId: "person/1",
		refresh: true,
		stub: { authorized: true },
	});

	for (const body of [{}, { refresh: "yes" }, { refresh: false, send: true }]) {
		const invalid = await app({ session, stub: {} }).request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}, {} as Env);
		assert.equal(invalid.status, 400);
	}
});

test("in-flight revocation suppresses successful, failed, and malformed runtime output", async () => {
	for (const run of [
		async () => unavailable,
		async (): Promise<never> => { throw new Error("private provider prompt"); },
		async () => ({ state: "generated" as const, secret: "malformed" } as never),
	]) {
		const response = await app({
			session,
			stub: {},
			run,
			revalidate: async () => false,
		}).request(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh: false }),
		}, {} as Env);
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "Forbidden" });
	}
});

test("runtime revocation maps to 403 and arbitrary failures are redacted", async () => {
	const revoked = await app({
		session,
		stub: {},
		run: async () => { throw new RelationshipBriefAccessRevokedError(); },
	}).request(path, {
		method: "POST",
		body: JSON.stringify({ refresh: false }),
	}, {} as Env);
	assert.equal(revoked.status, 403);

	const failed = await app({
		session,
		stub: {},
		run: async () => { throw new Error("private provider prompt"); },
	}).request(path, {
		method: "POST",
		body: JSON.stringify({ refresh: false }),
	}, {} as Env);
	assert.equal(failed.status, 502);
	assert.deepEqual(await failed.json(), {
		error: "The relationship brief is temporarily unavailable.",
	});
});
