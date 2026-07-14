import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { InboxTriageSuggestionAccessRevokedError } from "../lib/inbox-triage-suggestions-runtime.ts";
import {
	createInboxTriageSuggestionRoutes,
	type InboxTriageSuggestionRouteContext,
	type InboxTriageSuggestionRouteDependencies,
} from "./inbox-triage-suggestions.ts";

const session = {
	sub: "user-a",
	email: "user@example.com",
	role: "AGENT",
} as SessionClaims;

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: InboxTriageSuggestionRouteDependencies["run"];
}) {
	const root = new Hono<InboxTriageSuggestionRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		c.set("authorizedMailboxId", "team@example.com");
		await next();
	});
	root.route(
		"/",
		createInboxTriageSuggestionRoutes({
			run:
				input.run ??
				(async () => ({
					state: "budget_paused",
					reason: "admin_review_required",
				})),
		}),
	);
	return root;
}

function request(body: BodyInit, mailboxId = "Team%40Example.com") {
	return new Request(
		`http://test/api/v1/mailboxes/${mailboxId}/inbox-triage-suggestions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
	);
}

const validBody = JSON.stringify({
	page: 3,
	labelId: "vip",
	visibleEmailIds: ["email-1", "email-2"],
});

test("authentication and live Mailbox resolution precede body consumption", async () => {
	assert.equal((await app({ stub: {} }).request(request("not-json"))).status, 401);
	assert.equal(
		(await app({ session }).request(request("not-json"))).status,
		403,
	);
});

test("route derives actor and Mailbox from trusted context and preserves ordered page identity", async () => {
	let received: unknown;
	const response = await app({
		session,
		stub: { authorized: true },
		run: async (input) => {
			received = input;
			return { state: "stale" };
		},
	}).request(request(validBody));
	assert.equal(response.status, 200);
	assert.deepEqual(
		{
			actorUserId: (received as Record<string, unknown>).actorUserId,
			mailboxId: (received as Record<string, unknown>).mailboxId,
			request: (received as Record<string, unknown>).request,
			stub: (received as Record<string, unknown>).stub,
		},
		{
			actorUserId: "user-a",
			mailboxId: "team@example.com",
			request: {
				version: 1,
				page: 3,
				labelId: "vip",
				visibleEmailIds: ["email-1", "email-2"],
			},
			stub: { authorized: true },
		},
	);
});

test("request is exact, bounded, unique, and valid UTF-8", async () => {
	const server = app({ session, stub: {} });
	for (const body of [
		{},
		{ page: 0, visibleEmailIds: ["email-1"] },
		{ page: 1, visibleEmailIds: [] },
		{ page: 1, visibleEmailIds: ["email-1", "email-1"] },
		{ page: 1, visibleEmailIds: ["email-1"], action: "archive" },
	]) {
		assert.equal(
			(await server.request(request(JSON.stringify(body)))).status,
			400,
		);
	}
	assert.equal(
		(
			await server.request(
				request(
					JSON.stringify({
						page: 1,
						visibleEmailIds: ["x".repeat(17_000)],
					}),
				),
			)
		).status,
		413,
	);
	assert.equal(
		(await server.request(request(new Uint8Array([0xff])))).status,
		400,
	);
});

test("revocation is forbidden and generic failure leaks no mail content", async () => {
	const revoked = await app({
		session,
		stub: {},
		run: async () => {
			throw new InboxTriageSuggestionAccessRevokedError();
		},
	}).request(request(validBody));
	assert.equal(revoked.status, 403);

	const failed = await app({
		session,
		stub: {},
		run: async () => {
			throw new Error("secret sender and message body");
		},
	}).request(request(validBody));
	assert.equal(failed.status, 502);
	const text = await failed.text();
	assert.doesNotMatch(text, /secret sender|message body/);
	assert.match(text, /No mail was changed/i);
});
