import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import {
	AI_DRAFT_REQUEST_LIMITS,
	createAiDraftRoutes,
	type AiDraftRouteContext,
	type AiDraftRouteOperations,
} from "./ai-drafts.ts";

const session: SessionClaims = {
	sub: "user-1",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "team@example.com",
};

function testApp(
	operations: AiDraftRouteOperations,
	activeSession: SessionClaims | null = session,
) {
	const app = new Hono<AiDraftRouteContext>();
	app.use("*", async (c, next) => {
		if (activeSession) c.set("session", activeSession);
		await next();
	});
	app.route("/", createAiDraftRoutes(operations));
	return app;
}

function request(
	app: Hono<AiDraftRouteContext>,
	path: "/ai-draft" | "/ai-compose",
	body: string,
	headers?: Record<string, string>,
) {
	return app.request(
		`http://mail.test/api/v1/mailboxes/team%40example.com${path}`,
		{ method: "POST", body, headers },
		{} as Env,
	);
}

function operations(overrides: Partial<AiDraftRouteOperations> = {}): AiDraftRouteOperations {
	return {
		async draftReply() {
			return { to: "person@example.com", subject: "Re: Hello", body: "<p>Reply</p>" };
		},
		async draftCompose() {
			return { subject: "Hello", body: "<p>Draft</p>" };
		},
		...overrides,
	};
}

test("AI draft routes preserve successful responses and attribute the signed-in actor", async () => {
	const calls: unknown[][] = [];
	const app = testApp(operations({
		async draftReply(...args) {
			calls.push(args);
			return { to: "person@example.com", subject: "Re: Hello", body: "<p>Reply</p>" };
		},
		async draftCompose(...args) {
			calls.push(args);
			return { subject: "Hello", body: "<p>Draft</p>" };
		},
	}));

	const reply = await request(app, "/ai-draft", JSON.stringify({ emailId: "  mail-1  " }));
	assert.equal(reply.status, 200);
	assert.deepEqual(await reply.json(), {
		to: "person@example.com",
		subject: "Re: Hello",
		body: "<p>Reply</p>",
	});
	const compose = await request(app, "/ai-compose", JSON.stringify({ prompt: "  Write a hello  " }));
	assert.equal(compose.status, 200);
	assert.deepEqual(await compose.json(), { subject: "Hello", body: "<p>Draft</p>" });
	assert.deepEqual(calls.map((call) => call.slice(1)), [
		["team@example.com", "mail-1", "user-1"],
		["team@example.com", { prompt: "Write a hello" }, "user-1"],
	]);
});

test("AI compose forwards optional authored subject and body without trimming draft data", async () => {
	let forwarded: unknown[] | undefined;
	const app = testApp(operations({
		async draftCompose(...args) {
			forwarded = args;
			return { subject: "Refined", body: "<p>Refined body</p>" };
		},
	}));
	const response = await request(
		app,
		"/ai-compose",
		JSON.stringify({
			prompt: "  Make this clearer  ",
			currentSubject: "  Existing subject  ",
			currentBody: "<p> Existing body </p>",
		}),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(forwarded?.slice(1), [
		"team@example.com",
		{
			prompt: "Make this clearer",
			currentSubject: "  Existing subject  ",
			currentBody: "<p> Existing body </p>",
		},
		"user-1",
	]);
});

test("AI draft routes require auth before parsing request bodies", async () => {
	let called = false;
	const app = testApp(operations({
		async draftReply() {
			called = true;
			return { to: "", subject: "", body: "" };
		},
		async draftCompose() {
			called = true;
			return { subject: "", body: "" };
		},
	}), null);
	for (const [path, body, limit] of [
		["/ai-draft", { emailId: "mail-1" }, AI_DRAFT_REQUEST_LIMITS.replyBytes],
		["/ai-compose", { prompt: "Write it" }, AI_DRAFT_REQUEST_LIMITS.composeBytes],
	] as const) {
		const response = await request(app, path, JSON.stringify(body), {
			"Content-Length": String(limit + 1),
		});
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "Unauthorized" });
	}
	assert.equal(called, false);
});

test("AI draft routes reject malformed, empty, extra, and oversized input before inference", async () => {
	let calls = 0;
	const app = testApp(operations({
		async draftReply() {
			calls++;
			return { to: "", subject: "", body: "" };
		},
		async draftCompose() {
			calls++;
			return { subject: "", body: "" };
		},
	}));

	for (const [path, body, expectedError] of [
		["/ai-draft", "not-json", "AI draft request is invalid"],
		["/ai-draft", JSON.stringify({ emailId: "", extra: true }), "emailId is required"],
		["/ai-compose", JSON.stringify({ prompt: "", extra: true }), "prompt is required"],
		["/ai-compose", JSON.stringify({ prompt: "valid", extra: true }), "AI compose request is invalid"],
	] as const) {
		const response = await request(app, path, body);
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: expectedError });
	}

	for (const [path, body] of [
		["/ai-draft", JSON.stringify({ emailId: "x".repeat(AI_DRAFT_REQUEST_LIMITS.replyBytes) })],
		["/ai-compose", JSON.stringify({ prompt: "x".repeat(AI_DRAFT_REQUEST_LIMITS.composeBytes) })],
	] as const) {
		const response = await request(app, path, body);
		assert.equal(response.status, 413);
		assert.deepEqual(await response.json(), { error: "AI draft request is too large" });
	}
	const declaredOversize = await request(
		app,
		"/ai-compose",
		JSON.stringify({ prompt: "small" }),
		{ "Content-Length": String(AI_DRAFT_REQUEST_LIMITS.composeBytes + 1) },
	);
	assert.equal(declaredOversize.status, 413);
	assert.equal(calls, 0);
});

test("AI compose enforces field limits and the combined safe model envelope", async () => {
	let calls = 0;
	const app = testApp(operations({
		async draftCompose() {
			calls++;
			return { subject: "ok", body: "<p>ok</p>" };
		},
	}));
	for (const body of [
		{ prompt: "p".repeat(8_000) },
		{
			prompt: "valid",
			currentSubject: "s".repeat(500),
			currentBody: "b".repeat(17_000),
			preserveSignature: true,
		},
	]) {
		const exact = await request(app, "/ai-compose", JSON.stringify(body));
		assert.equal(exact.status, 200);
	}
	assert.equal(calls, 2);

	const unsafeCombination = await request(
		app,
		"/ai-compose",
		JSON.stringify({
			prompt: "p".repeat(8_000),
			currentSubject: "s".repeat(500),
			currentBody: "b".repeat(20_000),
		}),
	);
	assert.equal(unsafeCombination.status, 400);
	assert.deepEqual(await unsafeCombination.json(), {
		error: "The current draft is too large to refine safely",
	});

	for (const body of [
		{ prompt: "p".repeat(8_001) },
		{ prompt: "valid", currentSubject: "s".repeat(501) },
		{ prompt: "valid", currentBody: "b".repeat(20_001) },
		{ prompt: "valid", currentSubject: 42 },
		{ prompt: "valid", currentBody: null },
	]) {
		const response = await request(app, "/ai-compose", JSON.stringify(body));
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), {
			error: "AI compose request is invalid",
		});
	}
	assert.equal(calls, 2);
});

test("AI compose enforces the streamed body cap at exactly 32 KiB", async () => {
	let calls = 0;
	const app = testApp(operations({
		async draftCompose() {
			calls++;
			return { subject: "", body: "" };
		},
	}));
	const base = JSON.stringify({ prompt: "valid", unknown: "" });
	const exactBody = JSON.stringify({
		prompt: "valid",
		unknown: "x".repeat(AI_DRAFT_REQUEST_LIMITS.composeBytes - base.length),
	});
	assert.equal(new TextEncoder().encode(exactBody).byteLength, 32 * 1_024);

	const exact = await request(app, "/ai-compose", exactBody);
	assert.equal(exact.status, 400);
	assert.deepEqual(await exact.json(), { error: "AI compose request is invalid" });

	const over = await request(app, "/ai-compose", `${exactBody} `);
	assert.equal(over.status, 413);
	assert.deepEqual(await over.json(), { error: "AI draft request is too large" });
	assert.equal(calls, 0);
});

test("AI draft routes preserve safe budget messages and redact arbitrary failures", async () => {
	for (const budgetMessage of [
		"AI drafting is paused pending an administrator budget review.",
		"AI drafting is temporarily unavailable. Your mail remains fully available.",
	]) {
		const budget = await request(
			testApp(operations({
				async draftCompose() {
					throw new Error(budgetMessage);
				},
			})),
			"/ai-compose",
			JSON.stringify({ prompt: "Write an update" }),
		);
		assert.equal(budget.status, 502);
		assert.deepEqual(await budget.json(), { error: budgetMessage });
	}

	const logged: unknown[][] = [];
	const originalError = console.error;
	console.error = (...args: unknown[]) => {
		logged.push(args);
	};
	let provider: Response;
	try {
		provider = await request(
			testApp(operations({
				async draftReply() {
					throw new Error("provider credential sk-secret failed with upstream payload");
				},
			})),
			"/ai-draft",
			JSON.stringify({ emailId: "mail-1" }),
		);
	} finally {
		console.error = originalError;
	}
	assert.equal(provider.status, 502);
	assert.deepEqual(await provider.json(), {
		error: "AI drafting is temporarily unavailable. Please try again.",
	});
	assert.doesNotMatch(JSON.stringify(logged), /sk-secret|upstream payload/);
});
