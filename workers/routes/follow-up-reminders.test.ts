import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";
import type { SessionClaims } from "../lib/auth.ts";
import {
	createFollowUpReminderService,
	FollowUpReminderError,
	type FollowUpReminderErrorCode,
} from "../lib/follow-up-reminders.ts";
import type { Env } from "../types.ts";
import {
	createFollowUpReminderRoutes,
	type FollowUpReminderRouteContext,
	type FollowUpReminderRouteService,
} from "./follow-up-reminders.ts";

const session: SessionClaims = {
	sub: "usr_1",
	email: "one@example.com",
	role: "AGENT",
	mailbox: "one@example.com",
};

const reminder: FollowUpReminderView = {
	id: "reminder_1",
	ownerUserId: "usr_1",
	mailboxAddress: "support@example.com",
	conversationKey: "conversation_1",
	baselineMessageId: "message_1",
	baselineMessageDate: "2026-07-10T12:00:00.000Z",
	remindAt: "2026-07-12T12:00:00.000Z",
	state: "active",
	resolutionReason: null,
	version: 1,
	createdAt: 1,
	updatedAt: 1,
	resolvedAt: null,
	preview: {
		subject: "Quarterly proposal",
		counterparty: "Client <client@example.com>",
	},
};

function service(
	overrides: Partial<FollowUpReminderRouteService> = {},
): FollowUpReminderRouteService {
	return {
		async list() {
			return { reminders: [reminder], nextCursor: null };
		},
		async create() {
			return reminder;
		},
		async apply() {
			return { ...reminder, version: 2 };
		},
		...overrides,
	};
}

function testApp(input?: {
	session?: SessionClaims | null;
	service?: FollowUpReminderRouteService;
}) {
	const app = new Hono<FollowUpReminderRouteContext>();
	app.use("*", async (c, next) => {
		if (input?.session !== null) c.set("session", input?.session ?? session);
		c.set("authorizedMailboxId", "support@example.com");
		await next();
	});
	app.route(
		"/",
		createFollowUpReminderRoutes({
			service: () => input?.service ?? service(),
		}),
	);
	return app;
}

function request(app: Hono<FollowUpReminderRouteContext>, path: string, init?: RequestInit) {
	return app.request(`http://mail.example.com${path}`, init, {} as Env);
}

function jsonBody(value: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(value),
	};
}

test("follow-up reminder routes require a signed-in owner", async () => {
	const app = testApp({ session: null });
	const collection = "/api/v1/mailboxes/support%40example.com/follow-up-reminders";
	const [list, create, operation] = await Promise.all([
		request(app, collection),
		request(app, collection, jsonBody({})),
		request(app, `${collection}/reminder_1/operations`, jsonBody({})),
	]);

	for (const response of [list, create, operation]) {
		assert.equal(response.status, 401);
		assert.deepEqual(await response.json(), { error: "Unauthorized" });
	}
});

test("list is owner and mailbox scoped with a strict bounded limit", async () => {
	const calls: unknown[][] = [];
	const app = testApp({
		service: service({
			async list(...input) {
				calls.push(input);
				return { reminders: [reminder], nextCursor: "next-page" };
			},
		}),
	});
	const path = "/api/v1/mailboxes/SUPPORT%40EXAMPLE.COM/follow-up-reminders";
	const [defaults, bounded] = await Promise.all([
		request(app, path),
		request(app, `${path}?limit=25&cursor=current-page`),
	]);

	assert.equal(defaults.status, 200);
	assert.deepEqual(await defaults.json(), { reminders: [reminder], nextCursor: "next-page" });
	assert.equal(bounded.status, 200);
	assert.deepEqual(calls, [
		["usr_1", "support@example.com", 100, undefined],
		["usr_1", "support@example.com", 25, "current-page"],
	]);

	for (const limit of ["", "0", "1.5", "101", "not-a-number"]) {
		const invalid = await request(app, `${path}?limit=${limit}`);
		assert.equal(invalid.status, 400);
		assert.deepEqual(await invalid.json(), {
			error: "Reminder list limit is invalid",
			code: "INVALID",
		});
	}
});

test("create accepts the minimal definition and returns the private reminder", async () => {
	let call: unknown[] | undefined;
	const app = testApp({
		service: service({
			async create(...input) {
				call = input;
				return reminder;
			},
		}),
	});
	const body = {
		emailId: "message_1",
		remindAt: "2026-07-12T12:00:00.000Z",
		idempotencyKey: "create_operation_1",
	};
	const response = await request(
		app,
		"/api/v1/mailboxes/SUPPORT%40EXAMPLE.COM/follow-up-reminders",
		jsonBody(body),
	);

	assert.equal(response.status, 201);
	assert.deepEqual(call, ["usr_1", "support@example.com", body]);
	assert.deepEqual(await response.json(), { reminder });
});

test("operation routes preserve CAS and idempotency input", async () => {
	let call: unknown[] | undefined;
	const updated = { ...reminder, remindAt: "2026-07-13T12:00:00.000Z", version: 2 };
	const app = testApp({
		service: service({
			async apply(...input) {
				call = input;
				return updated;
			},
		}),
	});
	const body = {
		action: "snooze",
		operationId: "snooze_operation_1",
		expectedVersion: 1,
		remindAt: updated.remindAt,
	};
	const response = await request(
		app,
		"/api/v1/mailboxes/support%40example.com/follow-up-reminders/reminder_1/operations",
		jsonBody(body),
	);

	assert.equal(response.status, 200);
	assert.deepEqual(call, [
		"usr_1",
		"support@example.com",
		"reminder_1",
		body,
	]);
	assert.deepEqual(await response.json(), { reminder: updated });
});

test("HTTP requests retain the service strict-body contract", async () => {
	let anchorCalls = 0;
	const strictService = createFollowUpReminderService({
		store: {
			async list() {
				return { reminders: [], nextCursor: null };
			},
			async findCreateReplay() {
				return null;
			},
			async createOrReplay() {
				throw new Error("create should not be reached");
			},
			async applyOperation() {
				throw new Error("apply should not be reached");
			},
			async completeForInboundReply() {
				return 0;
			},
		},
		async canAccessMailbox() {
			return true;
		},
		async resolveReminderAnchor() {
			anchorCalls++;
			return null;
		},
		now: () => Date.parse("2026-07-11T12:00:00.000Z"),
	});
	const app = testApp({ service: strictService });
	const collection = "/api/v1/mailboxes/support%40example.com/follow-up-reminders";
	const create = await request(app, collection, jsonBody({
		emailId: "message_1",
		remindAt: "2026-07-12T12:00:00.000Z",
		idempotencyKey: "create_operation_1",
		ownerUserId: "usr_2",
	}));
	const operation = await request(
		app,
		`${collection}/reminder_1/operations`,
		jsonBody({
			action: "complete",
			operationId: "complete_operation_1",
			expectedVersion: 1,
			mailboxAddress: "other@example.com",
		}),
	);

	for (const response of [create, operation]) {
		assert.equal(response.status, 400);
		assert.equal((await response.json() as { code: string }).code, "INVALID");
	}
	assert.equal(anchorCalls, 0);
});

test("list rejects malformed cursors through the stable route error contract", async () => {
	const strictService = createFollowUpReminderService({
		store: {
			async list() {
				throw new Error("list store should not be reached");
			},
			async findCreateReplay() {
				return null;
			},
			async createOrReplay() {
				throw new Error("create should not be reached");
			},
			async applyOperation() {
				throw new Error("operation should not be reached");
			},
			async completeForInboundReply() {
				return 0;
			},
		},
		async canAccessMailbox() {
			return true;
		},
		async resolveReminderAnchor() {
			return null;
		},
	});
	const response = await request(
		testApp({ service: strictService }),
		"/api/v1/mailboxes/support%40example.com/follow-up-reminders?cursor=malformed",
	);
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Reminder list cursor is invalid",
		code: "INVALID",
	});
});

test("both mutation routes reject oversized streams before JSON parsing", async () => {
	let mutationCalls = 0;
	const app = testApp({
		service: service({
			async create() {
				mutationCalls++;
				return reminder;
			},
			async apply() {
				mutationCalls++;
				return reminder;
			},
		}),
	});
	const collection = "/api/v1/mailboxes/support%40example.com/follow-up-reminders";
	const validOversized = JSON.stringify({
		emailId: "message_1",
		remindAt: "2026-07-12T12:00:00.000Z",
		idempotencyKey: "x".repeat(3_000),
	});
	const invalidOversized = `{${"x".repeat(3_000)}`;
	const cases: Array<{ path: string; body: string; contentLength?: string }> = [
		{ path: collection, body: validOversized },
		{
			path: `${collection}/reminder_1/operations`,
			body: invalidOversized,
		},
		{ path: collection, body: validOversized, contentLength: "1" },
		{
			path: `${collection}/reminder_1/operations`,
			body: invalidOversized,
			contentLength: "8",
		},
	];

	for (const input of cases) {
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		if (input.contentLength) headers["content-length"] = input.contentLength;
		const response = await request(app, input.path, {
			method: "POST",
			headers,
			body: input.body,
		});
		assert.equal(response.status, 413);
		assert.deepEqual(await response.json(), {
			error: "Reminder request body is too large",
			code: "REQUEST_TOO_LARGE",
		});
	}
	assert.equal(mutationCalls, 0);
});

test("declared oversize rejects before body consumption while auth still wins first", async () => {
	const path = "/api/v1/mailboxes/support%40example.com/follow-up-reminders";
	const declared = await request(testApp(), path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"content-length": "3000",
		},
		body: "{}",
	});
	assert.equal(declared.status, 413);
	assert.deepEqual(await declared.json(), {
		error: "Reminder request body is too large",
		code: "REQUEST_TOO_LARGE",
	});

	const unauthorized = await request(testApp({ session: null }), path, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"content-length": "3000",
		},
		body: "{}",
	});
	assert.equal(unauthorized.status, 401);
	assert.deepEqual(await unauthorized.json(), { error: "Unauthorized" });
});

test("domain errors map to stable status and code responses", async () => {
	const cases: Array<[FollowUpReminderErrorCode, number]> = [
		["INVALID", 400],
		["FORBIDDEN", 403],
		["NOT_FOUND", 404],
		["ACTIVE_CONFLICT", 409],
		["STATE_CONFLICT", 409],
		["IDEMPOTENCY_CONFLICT", 409],
	];
	for (const [code, status] of cases) {
		const response = await request(
			testApp({
				service: service({
					async list() {
						throw new FollowUpReminderError(code, `Stable ${code}`);
					},
				}),
			}),
			"/api/v1/mailboxes/support%40example.com/follow-up-reminders",
		);
		assert.equal(response.status, status);
		assert.deepEqual(await response.json(), {
			error: `Stable ${code}`,
			code,
		});
	}
});
