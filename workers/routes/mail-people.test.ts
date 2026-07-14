import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createMailPeopleRoutes,
	type MailPeopleOperations,
} from "./mail-people.ts";

function app(
	operations: MailPeopleOperations,
	revalidateAccess: () => Promise<boolean> = async () => true,
) {
	const root = new Hono<MailboxContext>();
	root.use("*", async (c, next) => {
		c.set("authorizedMailboxId", "team@example.com");
		await next();
	});
	root.route("/", createMailPeopleRoutes({
		operations: () => operations,
		revalidateAccess,
	}));
	return root;
}

const building = {
	status: "building" as const,
	schemaVersion: 1 as const,
	processedMessages: 100,
	retryAfterMs: 750,
};

test("People list route passes one canonical bounded query to mailbox storage", async () => {
	let received: unknown;
	const response = await app({
		async list(mailbox, query) {
			received = { mailbox, query };
			return building;
		},
		async detail() { return building; },
		async timeline() { return building; },
	}).request("/api/v1/mailboxes/TEAM%40Example.com/people?q=%20CLIENT%20&sort=frequent&limit=10");

	assert.equal(response.status, 200);
	assert.deepEqual(received, {
		mailbox: "team@example.com",
		query: { q: "client", sort: "frequent", limit: 10, cursor: null },
	});
	assert.deepEqual(await response.json(), building);
});

test("in-flight revocation suppresses successful, failed, and malformed People storage outcomes", async () => {
	const revoked = async () => false;
	for (const operations of [
		{
			async list() { return building; },
			async detail() { return building; },
			async timeline() { return building; },
		},
		{
			async list(): Promise<never> { throw new Error("private storage failure"); },
			async detail(): Promise<never> { throw new Error("private storage failure"); },
			async timeline(): Promise<never> { throw new Error("private storage failure"); },
		},
	] satisfies MailPeopleOperations[]) {
		const routes = app(operations, revoked);
		for (const path of [
			"/api/v1/mailboxes/team%40example.com/people",
			"/api/v1/mailboxes/team%40example.com/people/person-1",
			"/api/v1/mailboxes/team%40example.com/people/person-1/timeline",
		]) {
			const response = await routes.request(path);
			assert.equal(response.status, 403, path);
			assert.deepEqual(await response.json(), { error: "Forbidden" });
		}
	}
});

test("People routes reject malformed queries and identities without mailbox storage work", async () => {
	let calls = 0;
	const routes = app({
		async list() { calls += 1; return building; },
		async detail() { calls += 1; return building; },
		async timeline() { calls += 1; return building; },
	});
	for (const path of [
		"/api/v1/mailboxes/team%40example.com/people?limit=51",
		"/api/v1/mailboxes/team%40example.com/people?unknown=1",
		`/api/v1/mailboxes/team%40example.com/people/${encodeURIComponent("person\u202E1")}`,
		"/api/v1/mailboxes/team%40example.com/people/person-1/timeline?limit=0",
	]) {
		const response = await routes.request(path);
		assert.equal(response.status, 400, path);
		assert.equal((await response.json()).code, "INVALID_QUERY");
	}
	assert.equal(calls, 0);
});

test("People detail returns truthful missing state only after live access survives", async () => {
	const response = await app({
		async list() { return building; },
		async detail() { return { status: "ready", person: null }; },
		async timeline() { return building; },
	}).request("/api/v1/mailboxes/team%40example.com/people/missing-person");
	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Person not found" });
});
