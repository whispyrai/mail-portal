import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import {
	SemanticSearchCapacityError,
} from "../lib/global-semantic-search.ts";
import {
	createGlobalSemanticSearchRoutes,
	type GlobalSemanticSearchRouteContext,
	type GlobalSemanticSearchRouteInput,
} from "./global-semantic-search.ts";

const session = {
	sub: "user-1",
	email: "user@example.com",
	mailbox: "user@example.com",
	role: "AGENT",
	sessionVersion: 1,
} satisfies SessionClaims;

function app(options: {
	session?: SessionClaims;
	features?: string[];
	binding?: boolean;
	failure?: "capacity" | "provider" | "synchronous";
	rosters?: Array<{ mailboxIds: string[] } | null | Error>;
} = {}) {
	const calls: GlobalSemanticSearchRouteInput[] = [];
	const root = new Hono<GlobalSemanticSearchRouteContext>();
	root.use("*", async (c, next) => {
		if (options.session) c.set("session", options.session);
		await next();
	});
	root.route("/", createGlobalSemanticSearchRoutes({
		run: (input) => {
			calls.push(input);
			if (options.failure === "capacity") throw new SemanticSearchCapacityError(21);
			if (options.failure === "provider") throw new Error("private query or provider detail");
			if (options.failure === "synchronous") throw new Error("private synchronous factory detail");
			return Promise.resolve({
				state: "complete",
				accessChanged: false,
				results: [],
				mailboxes: [],
			});
		},
	}, async () => {
		const nextRoster = options.rosters?.shift();
		const roster = nextRoster === undefined
			? { mailboxIds: ["user@example.com"] }
			: nextRoster;
		if (roster instanceof Error) throw roster;
		return roster;
	}));
	const env = {
		BRAND: "wiser",
		FEATURES: options.features ?? [],
		SEMANTIC_INDEX: options.binding ? {} : undefined,
	};
	return { root, calls, env };
}

function request(body: string, headers: Record<string, string> = {}) {
	return new Request("http://mail.example.com/api/v1/semantic-search", {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

test("semantic route authenticates and feature-gates before parsing or provider work", async () => {
	const unauthenticated = app({ features: ["semantic_search"], binding: true });
	const denied = await unauthenticated.root.request(request("not-json"), undefined, unauthenticated.env);
	assert.equal(denied.status, 401);
	assert.equal(unauthenticated.calls.length, 0);
	assert.equal(denied.headers.get("cache-control"), "private, no-store");

	const disabled = app({ session, binding: true });
	assert.equal((await disabled.root.request(request("not-json"), undefined, disabled.env)).status, 404);
	assert.equal(disabled.calls.length, 0);

	const missing = app({ session, features: ["semantic_search"] });
	assert.equal((await missing.root.request(request("not-json"), undefined, missing.env)).status, 503);
	assert.equal(missing.calls.length, 0);
});

test("semantic route accepts only exact bounded POST JSON and never caches it", async () => {
	const state = app({ session, features: ["semantic_search"], binding: true });
	const accepted = await state.root.request(
		request(JSON.stringify({ query: "contract timing" })),
		undefined,
		state.env,
	);
	assert.equal(accepted.status, 200);
	assert.equal(accepted.headers.get("cache-control"), "private, no-store");
	assert.equal(state.calls[0]?.query, "contract timing");
	assert.equal(state.calls[0]?.actorUserId, "user-1");

	for (const body of [
		"not-json",
		JSON.stringify({}),
		JSON.stringify({ query: "x" }),
		JSON.stringify({ query: "valid query", mailboxIds: ["private@example.com"] }),
	]) {
		const invalid = app({ session, features: ["semantic_search"], binding: true });
		assert.equal((await invalid.root.request(request(body), undefined, invalid.env)).status, 400);
	}
	const oversized = app({ session, features: ["semantic_search"], binding: true });
	assert.equal((await oversized.root.request(
		request(JSON.stringify({ query: "valid" }), { "content-length": "4096" }),
		undefined,
		oversized.env,
	)).status, 413);
});

test("semantic route exposes bounded capacity truth and redacts provider failures", async () => {
	const capacity = app({
		session,
		features: ["semantic_search"],
		binding: true,
		failure: "capacity",
	});
	const capacityResponse = await capacity.root.request(
		request(JSON.stringify({ query: "anything" })),
		undefined,
		capacity.env,
	);
	assert.equal(capacityResponse.status, 422);
	assert.deepEqual(await capacityResponse.json(), {
		error: "Meaning search currently supports up to 20 accessible Mailboxes",
		limit: 20,
		actual: 21,
	});

	const failed = app({
		session,
		features: ["semantic_search"],
		binding: true,
		failure: "provider",
	});
	const failedResponse = await failed.root.request(
		request(JSON.stringify({ query: "private query" })),
		undefined,
		failed.env,
	);
	assert.equal(failedResponse.status, 503);
	assert.equal(JSON.stringify(await failedResponse.json()).includes("private query"), false);
});

test("global semantic output requires the same exact live session and Mailbox roster after runtime", async () => {
	for (const failure of [undefined, "provider" as const]) {
		const state = app({
			session,
			features: ["semantic_search"],
			binding: true,
			failure,
			rosters: [
				{ mailboxIds: ["a@example.com"] },
				{ mailboxIds: ["a@example.com", "b@example.com"] },
			],
		});
		const response = await state.root.request(
			request(JSON.stringify({ query: "private query" })),
			undefined,
			state.env,
		);
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: "Forbidden" });
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}

	const stale = app({
		session,
		features: ["semantic_search"],
		binding: true,
		rosters: [{ mailboxIds: [] }, null],
	});
	assert.equal((await stale.root.request(
		request(JSON.stringify({ query: "anything" })),
		undefined,
		stale.env,
	)).status, 401);

	const outage = app({
		session,
		features: ["semantic_search"],
		binding: true,
		rosters: [{ mailboxIds: [] }, new Error("private SQL")],
	});
	assert.equal((await outage.root.request(
		request(JSON.stringify({ query: "anything" })),
		undefined,
		outage.env,
	)).status, 503);

	const activeEmpty = app({
		session,
		features: ["semantic_search"],
		binding: true,
		rosters: [{ mailboxIds: [] }, { mailboxIds: [] }],
	});
	assert.equal((await activeEmpty.root.request(
		request(JSON.stringify({ query: "anything" })),
		undefined,
		activeEmpty.env,
	)).status, 200);
});

test("global roster drift overrides a synchronous private runtime-factory failure", async () => {
	const state = app({
		session,
		features: ["semantic_search"],
		binding: true,
		failure: "synchronous",
		rosters: [
			{ mailboxIds: ["a@example.com"] },
			{ mailboxIds: ["a@example.com", "b@example.com"] },
		],
	});
	const response = await state.root.request(
		request(JSON.stringify({ query: "private query" })),
		undefined,
		state.env,
	);
	assert.equal(response.status, 403);
	const body = await response.text();
	assert.deepEqual(JSON.parse(body), { error: "Forbidden" });
	assert.doesNotMatch(body, /private synchronous factory detail/);
});
