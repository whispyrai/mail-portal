import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { ConversationActivityProjection } from "../lib/conversation-activity.ts";
import type { Env } from "../types.ts";
import {
	ConversationActivityAccessRevokedError,
	createConversationActivityRoutes,
	readConversationActivityActorUsers,
	runConversationActivity,
	type ConversationActivityRouteContext,
	type ConversationActivityRouteDependencies,
} from "./conversation-activity.ts";

const session = {
	sub: "user-a",
	email: "user@example.com",
	role: "AGENT",
	mailbox: "team@example.com",
} as SessionClaims;

function app(input: {
	session?: SessionClaims;
	stub?: unknown;
	run?: ConversationActivityRouteDependencies["run"];
}) {
	const root = new Hono<ConversationActivityRouteContext>();
	root.use("*", async (c, next) => {
		if (input.session) c.set("session", input.session);
		if (input.stub) c.set("mailboxStub", input.stub as never);
		await next();
	});
	root.route(
		"/",
		createConversationActivityRoutes({
			run: input.run ?? (async () => ({ state: "not_found" })),
		}),
	);
	return root;
}

function url(query = "", mailboxId = "Team%40Example.com") {
	return `http://test/api/v1/mailboxes/${mailboxId}/emails/message-1/activity${query}`;
}

test("authentication and the authorized Mailbox seam precede query parsing", async () => {
	let calls = 0;
	const run = async () => {
		calls += 1;
		return { state: "not_found" as const };
	};
	assert.equal((await app({ stub: {}, run }).request(url("?limit=0&secret=x"))).status, 401);
	assert.equal((await app({ session, run }).request(url("?limit=0&secret=x"))).status, 403);
	assert.equal(calls, 0);

	const authorized = app({ session, stub: {}, run });
	for (const query of ["?limit=0", "?limit=51", "?cursor=%21", "?secret=x", "?limit=1&limit=2"]) {
		assert.equal((await authorized.request(url(query))).status, 400);
	}
	assert.equal(calls, 0);
});

test("route derives trusted identity and returns only the bounded public page", async () => {
	let received: Record<string, unknown> | undefined;
	const page = {
		items: [{
			id: "event-1",
			code: "message_received" as const,
			label: "Message received",
			actor: { kind: "person" as const, label: "member@example.com" },
			occurredAt: "2026-07-12T10:00:00.000Z",
		}],
		nextCursor: "opaque_cursor",
	};
	const response = await app({
		session,
		stub: { authorized: true },
		run: async (input) => {
			received = input as unknown as Record<string, unknown>;
			return { state: "ready", page };
		},
	}).request(url("?limit=50&cursor=opaque_cursor"));
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), page);
	assert.deepEqual(
		{
			actorUserId: received?.actorUserId,
			mailboxId: received?.mailboxId,
			emailId: received?.emailId,
			limit: received?.limit,
			cursor: received?.cursor,
			stub: received?.stub,
		},
		{
			actorUserId: "user-a",
			mailboxId: "team@example.com",
			emailId: "message-1",
			limit: 50,
			cursor: "opaque_cursor",
			stub: { authorized: true },
		},
	);
});

test("runtime rechecks access and enriches actors without exposing internal identity", async () => {
	const calls: string[] = [];
	const projection: ConversationActivityProjection = {
		state: "ready",
		items: [
			{ id: "1", code: "marked_read", label: "wrong", actorKind: "user", actorId: "active", occurredAt: "2026-07-12T10:00:08.000Z" },
			{ id: "2", code: "send_queued", label: "wrong", actorKind: "mcp", actorId: "active", occurredAt: "2026-07-12T10:00:07.000Z" },
			{ id: "3", code: "draft_updated", label: "wrong", actorKind: "agent", actorId: "active", occurredAt: "2026-07-12T10:00:06.000Z" },
			{ id: "4", code: "label_added", label: "wrong", actorKind: "rule", actorId: "rule-1", occurredAt: "2026-07-12T10:00:05.000Z" },
			{ id: "5", code: "message_received", label: "wrong", actorKind: "system", actorId: null, occurredAt: "2026-07-12T10:00:04.000Z" },
			{ id: "6", code: "trashed", label: "wrong", actorKind: "user", actorId: "inactive", occurredAt: "2026-07-12T10:00:03.000Z" },
			{ id: "7", code: "restored", label: "wrong", actorKind: "agent", actorId: "missing", occurredAt: "2026-07-12T10:00:02.000Z" },
			{ id: "8", code: "snoozed", label: "wrong", actorKind: "agent", actorId: null, occurredAt: "2026-07-12T10:00:01.000Z" },
		],
		nextCursor: null,
	};
	const result = await runConversationActivity(
		{
			canAccess: async () => { calls.push("access"); return true; },
			readProjection: async () => { calls.push("projection"); return projection; },
			readActorUsers: async (ids) => {
				calls.push(`users:${ids.join(",")}`);
				return new Map([
					["active", { id: "active", email: "ACTIVE@Example.com", is_active: 1 }],
					["inactive", { id: "inactive", email: "former@example.com", is_active: 0 }],
				]);
			},
		},
		{ actorUserId: "viewer", mailboxId: "team@example.com", emailId: "message-1", limit: 50, cursor: null },
	);
	assert.deepEqual(calls, ["access", "projection", "access", "users:active,inactive,missing", "access"]);
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(result.page.items.map((item) => [item.label, item.actor.kind, item.actor.label]), [
		["Marked read", "person", "active@example.com"],
		["Send queued", "mcp", "active@example.com via MCP"],
		["Draft updated", "assistant", "active@example.com via AI assistant"],
		["Label added", "automation", "Automation"],
		["Message received", "system", "Mail portal"],
		["Moved to Trash", "person", "Former team member"],
		["Restored", "assistant", "Former team member"],
		["Snoozed", "assistant", "AI assistant"],
	]);
	assert.doesNotMatch(JSON.stringify(result), /actorId|rule-1|inactive|missing/);
});

test("runtime stops on initial and mid-flight access revocation", async () => {
	let projectionCalls = 0;
	await assert.rejects(
		runConversationActivity({
			canAccess: async () => false,
			readProjection: async () => { projectionCalls += 1; return { state: "not_found" }; },
			readActorUsers: async () => new Map(),
		}, { actorUserId: "admin", mailboxId: "unassigned@example.com", emailId: "x", limit: 25, cursor: null }),
		ConversationActivityAccessRevokedError,
	);
	assert.equal(projectionCalls, 0);

	let accessCalls = 0;
	let userLookups = 0;
	await assert.rejects(
		runConversationActivity({
			canAccess: async () => ++accessCalls === 1,
			readProjection: async () => ({ state: "ready", items: [], nextCursor: null }),
			readActorUsers: async () => { userLookups += 1; return new Map(); },
		}, { actorUserId: "viewer", mailboxId: "team@example.com", emailId: "x", limit: 25, cursor: null }),
		ConversationActivityAccessRevokedError,
	);
	assert.equal(userLookups, 0);

	accessCalls = 0;
	userLookups = 0;
	await assert.rejects(
		runConversationActivity({
			canAccess: async () => ++accessCalls < 3,
			readProjection: async () => ({
				state: "ready",
				items: [{ id: "1", code: "marked_read", label: "Marked read", actorKind: "user", actorId: "member", occurredAt: "2026-07-12T10:00:00.000Z" }],
				nextCursor: null,
			}),
			readActorUsers: async () => { userLookups += 1; return new Map(); },
		}, { actorUserId: "viewer", mailboxId: "team@example.com", emailId: "x", limit: 25, cursor: null }),
		ConversationActivityAccessRevokedError,
	);
	assert.equal(userLookups, 1);
});

test("D1 actor lookup returns current active state and omits absent identities", async () => {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, is_active INTEGER NOT NULL)");
	db.prepare("INSERT INTO users VALUES (?, ?, ?)").run("active", "active@example.com", 1);
	db.prepare("INSERT INTO users VALUES (?, ?, ?)").run("inactive", "inactive@example.com", 0);
	const d1 = {
		prepare(sql: string) {
			const statement = db.prepare(sql);
			let values: unknown[] = [];
			const prepared = {
				bind(...bindings: unknown[]) { values = bindings; return prepared; },
				async all() { return { results: statement.all(...values) }; },
			};
			return prepared;
		},
	};
	const rows = await readConversationActivityActorUsers(
		{ DB: d1 } as unknown as Env,
		["active", "inactive", "absent", "active"],
	);
	assert.deepEqual([...rows.values()].map((row) => ({ ...row })), [
		{ id: "active", email: "active@example.com", is_active: 1 },
		{ id: "inactive", email: "inactive@example.com", is_active: 0 },
	]);
	db.close();
});

test("route maps stable errors and generic failures do not leak private content", async () => {
	for (const [state, status] of [["not_found", 404], ["invalid_request", 400], ["invalid_cursor", 400]] as const) {
		const response = await app({ session, stub: {}, run: async () => ({ state }) }).request(url());
		assert.equal(response.status, status);
	}
	const revoked = await app({
		session,
		stub: {},
		run: async () => { throw new ConversationActivityAccessRevokedError(); },
	}).request(url());
	assert.equal(revoked.status, 403);

	const originalError = console.error;
	console.error = () => undefined;
	try {
		const failed = await app({
			session,
			stub: {},
			run: async () => { throw new Error("secret sender and message body"); },
		}).request(url());
		assert.equal(failed.status, 502);
		assert.doesNotMatch(await failed.text(), /secret sender|message body/);
	} finally {
		console.error = originalError;
	}
});
