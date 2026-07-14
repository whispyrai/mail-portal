import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import {
	ConversationIntelligenceNotFoundError,
	ConversationIntelligenceUnsupportedStateError,
} from "../lib/conversation-intelligence-runtime.ts";
import {
	ReplyRefinementAccessRevokedError,
	ReplyRefinementSourceUnavailableError,
	ReplyRefinementWritingPromptUnavailableError,
} from "../lib/reply-refinement-runtime.ts";
import type { Env } from "../types.ts";
import {
	createReplyRefinementRoutes,
	type ReplyRefinementRouteContext,
	type ReplyRefinementRouteDependencies,
} from "./reply-refinement.ts";

const session = {
	sub: "user-a",
	email: "user@example.com",
	role: "AGENT",
} as SessionClaims;

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: ReplyRefinementRouteDependencies["run"];
}) {
	const root = new Hono<ReplyRefinementRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		c.set("authorizedMailboxId", "team@example.com");
		await next();
	});
	root.route(
		"/",
		createReplyRefinementRoutes({
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
		`http://test/api/v1/mailboxes/${mailboxId}/emails/message-1/reply-refinement`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		},
	);
}

const validBody = JSON.stringify({
	mode: "reply-all",
	prompt: "  Make it friendlier.  ",
	currentBody: "Hi Mona,",
	preserveSignature: true,
});

test("authentication and authorized Mailbox resolution win before body consumption", async () => {
	assert.equal((await app({ stub: {} }).request(request(validBody))).status, 401);
	assert.equal(
		(await app({ session }).request(request(validBody), undefined, {} as Env))
			.status,
		403,
	);
});

test("route derives actor, Mailbox, and source Message from trusted context and path", async () => {
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
			sourceEmailId: (received as Record<string, unknown>).sourceEmailId,
			request: (received as Record<string, unknown>).request,
			stub: (received as Record<string, unknown>).stub,
		},
		{
			actorUserId: "user-a",
			mailboxId: "team@example.com",
			sourceEmailId: "message-1",
			request: {
				version: 1,
				mode: "reply-all",
				prompt: "Make it friendlier.",
				currentBody: "Hi Mona,",
				preserveSignature: true,
			},
			stub: { authorized: true },
		},
	);
});

test("request bodies are exact, bounded, and valid UTF-8", async () => {
	const server = app({ session, stub: {} });
	for (const body of [
		{},
		{ mode: "forward", prompt: "Write" },
		{ mode: "reply", prompt: "" },
		{ mode: "reply", prompt: "Write", sourceEmailId: "forged" },
		{ mode: "reply", prompt: "Write", automate: "send" },
		{ mode: "reply", prompt: "bad\u0000text" },
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
						mode: "reply",
						prompt: "Refine",
						currentBody: "x".repeat(33_000),
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

test("route maps missing, unsupported, revoked, and stale states without leaking content", async () => {
	const cases = [
		[new ReplyRefinementAccessRevokedError(), 403],
		[new ConversationIntelligenceNotFoundError(), 404],
		[new ConversationIntelligenceUnsupportedStateError("draft"), 409],
		[new ReplyRefinementSourceUnavailableError(), 409],
		[new ReplyRefinementWritingPromptUnavailableError(), 409],
	] as const;
	for (const [failure, status] of cases) {
		const response = await app({
			session,
			stub: {},
			run: async () => {
				throw failure;
			},
		}).request(request(validBody));
		assert.equal(response.status, status);
	}

	const failed = await app({
		session,
		stub: {},
		run: async () => {
			throw new Error("secret draft, prompt, and sender content");
		},
	}).request(request(validBody));
	assert.equal(failed.status, 502);
	const text = await failed.text();
	assert.doesNotMatch(text, /secret draft|prompt|sender content/);
	assert.match(text, /draft remains unchanged/i);
});
