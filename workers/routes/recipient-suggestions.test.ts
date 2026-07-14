import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import {
	createRecipientSuggestionRoutes,
	type RecipientSuggestionOperations,
	type RecipientSuggestionRouteContext,
} from "./recipient-suggestions.ts";

const session: SessionClaims = {
	sub: "user-1",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "user@example.com",
};

function app(input: {
	session?: SessionClaims;
	mailboxStub?: unknown;
	operations?: RecipientSuggestionOperations;
}) {
	const root = new Hono<RecipientSuggestionRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.mailboxStub) c.set("mailboxStub", input.mailboxStub as never);
		c.set("authorizedMailboxId", "team@example.com");
		await next();
	});
	root.route(
		"/",
		createRecipientSuggestionRoutes({
			operations: () => input.operations ?? {
				async list() {
					return [];
				},
			},
		}),
	);
	return root;
}

function request(
	app: Hono<RecipientSuggestionRouteContext>,
	query = "",
) {
	return app.request(
		`http://mail.example.com/api/v1/mailboxes/team%40example.com/recipient-suggestions${query}`,
		{},
		{} as Env,
	);
}

test("recipient suggestions require authentication and the authorized mailbox seam", async () => {
	assert.equal((await request(app({ mailboxStub: {} }))).status, 401);
	assert.equal((await request(app({ session }))).status, 403);
});

test("recipient suggestions derive mailbox scope and return only bounded projection fields", async () => {
	let received: unknown;
	const response = await request(
		app({
			session,
			mailboxStub: { authorized: true },
			operations: {
				async list(input) {
					received = input;
					return [{
						address: "person@example.com",
						sentCount: 3,
						receivedCount: 2,
						lastSentAt: "2026-07-11T10:00:00.000Z",
						lastReceivedAt: "2026-07-10T10:00:00.000Z",
						subject: "must not leak",
					}];
				},
			},
		}),
		"?q=Per&limit=10",
	);
	assert.equal(response.status, 200);
	assert.deepEqual(received, {
		mailboxAddress: "team@example.com",
		query: "per",
		limit: 10,
		stub: { authorized: true },
	});
	assert.deepEqual(await response.json(), {
		suggestions: [{
			address: "person@example.com",
			sentCount: 3,
			receivedCount: 2,
			lastSentAt: "2026-07-11T10:00:00.000Z",
			lastReceivedAt: "2026-07-10T10:00:00.000Z",
		}],
	});
});

test("recipient suggestions reject invalid query bounds before mailbox work", async () => {
	let called = false;
	const target = app({
		session,
		mailboxStub: {},
		operations: {
			async list() {
				called = true;
				return [];
			},
		},
	});
	for (const query of ["?limit=0", "?limit=21", `?q=${"x".repeat(321)}`]) {
		assert.equal((await request(target, query)).status, 400, query);
	}
	assert.equal(called, false);
});
