import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import {
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "../lib/conversation-intelligence-runtime.ts";
import { ConversationAnswerAccessRevokedError } from "../lib/conversation-answer-runtime.ts";
import type { Env } from "../types.ts";
import {
	createConversationAnswerRoutes,
	type ConversationAnswerRouteContext,
	type ConversationAnswerRouteDependencies,
} from "./conversation-answer.ts";

const session = {
	sub: "user-a",
	email: "user@example.com",
	role: "AGENT",
} as SessionClaims;

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: ConversationAnswerRouteDependencies["run"];
}) {
	const root = new Hono<ConversationAnswerRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		await next();
	});
	root.route(
		"/",
		createConversationAnswerRoutes({
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
		`http://test/api/v1/mailboxes/${mailboxId}/emails/message-1/question`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
	);
}

test("auth and the authorized mailbox seam win before question consumption", async () => {
	const body = JSON.stringify({ question: "What was promised?" });
	assert.equal((await app({ stub: {} }).request(request(body))).status, 401);
	assert.equal(
		(await app({ session }).request(request(body), undefined, {} as Env))
			.status,
		403,
	);
});

test("route derives actor, mailbox, conversation, and question server-side", async () => {
	let received: unknown;
	const response = await app({
		session,
		stub: { authorized: true },
		run: async (input) => {
			received = input;
			return { state: "stale" };
		},
	}).request(request(JSON.stringify({ question: "  What was promised?  " })));
	assert.equal(response.status, 200);
	assert.deepEqual(
		{
			actorUserId: (received as Record<string, unknown>).actorUserId,
			mailboxId: (received as Record<string, unknown>).mailboxId,
			emailId: (received as Record<string, unknown>).emailId,
			question: (received as Record<string, unknown>).question,
			stub: (received as Record<string, unknown>).stub,
		},
		{
			actorUserId: "user-a",
			mailboxId: "team@example.com",
			emailId: "message-1",
			question: "What was promised?",
			stub: { authorized: true },
		},
	);
});

test("question bodies are strict, bounded, and valid UTF-8", async () => {
	const server = app({ session, stub: {} });
	for (const body of [
		{},
		{ question: "" },
		{ question: "hello", automate: "send" },
		{ question: "x".repeat(501) },
		{ question: "unsafe\u0000control" },
	]) {
		assert.equal(
			(await server.request(request(JSON.stringify(body)))).status,
			400,
		);
	}
	assert.equal(
		(
			await server.request(
				request(JSON.stringify({ question: "x".repeat(2_100) })),
			)
		).status,
		413,
	);
	assert.equal(
		(await server.request(request(new Uint8Array([0xff])))).status,
		400,
	);
});

test("route maps revoked, missing, and unsupported states without content leaks", async () => {
	const cases = [
		[new ConversationAnswerAccessRevokedError(), 403],
		[new ConversationIntelligenceNotFoundError(), 404],
		[new ConversationIntelligenceUnsupportedStateError("draft"), 409],
	] as const;
	for (const [failure, status] of cases) {
		const response = await app({
			session,
			stub: {},
			run: async () => {
				throw failure;
			},
		}).request(request(JSON.stringify({ question: "What was promised?" })));
		assert.equal(response.status, status);
	}

	const failed = await app({
		session,
		stub: {},
		run: async () => {
			throw new Error("secret question, prompt, and sender content");
		},
	}).request(request(JSON.stringify({ question: "What was promised?" })));
	assert.equal(failed.status, 502);
	const text = await failed.text();
	assert.doesNotMatch(text, /secret question|prompt|sender content/);
	assert.match(text, /Mail remains fully usable/);
});
