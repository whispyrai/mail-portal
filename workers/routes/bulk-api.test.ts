import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { BULK_LIMITS } from "../lib/bulk-job-admission.ts";
import {
	handleCancelBulkReservation,
	handleCreateBulkJob,
	handleGetBulkJob,
	handleRecoverBulkOperation,
	handleReserveBulkOperation,
} from "./bulk-api.ts";

function appWithResult(result: unknown) {
	const calls: Record<string, unknown>[] = [];
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("session", {
			sub: "user-1",
			email: "person@example.com",
			role: "AGENT",
			mailbox: "team@example.com",
		});
		c.set("mailboxStub", {
			async cancelBulkReservation(operationId: string, actorUserId: string) {
				calls.push({ cancelBulkReservation: operationId, actorUserId });
				if (result instanceof Error) throw result;
				return result;
			},
			async reserveBulkOperation(input: Record<string, unknown>) {
				calls.push({ reserveBulkOperation: input });
				if (result instanceof Error) throw result;
				return result;
			},
			async enqueueBulkJob(input: Record<string, unknown>) {
				calls.push(input);
				if (result instanceof Error) throw result;
				return result;
			},
			async getBulkJob(jobId: string) {
				calls.push({ getBulkJob: jobId });
				return result;
			},
			async getBulkJobByOperation(operationId: string, actorUserId: string) {
				calls.push({ getBulkJobByOperation: operationId, actorUserId });
				return result;
			},
		} as never);
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/bulk", handleCreateBulkJob);
	app.post(
		"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId/reserve",
		handleReserveBulkOperation,
	);
	app.delete(
		"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId/reservation",
		handleCancelBulkReservation,
	);
	app.get(
		"/api/v1/mailboxes/:mailboxId/bulk/operations/:operationId",
		handleRecoverBulkOperation,
	);
	app.get("/api/v1/mailboxes/:mailboxId/bulk/:jobId", handleGetBulkJob);
	return { app, calls };
}

test("an exact bulk admission replay returns the one authoritative job", async () => {
	const { app, calls } = appWithResult({
		status: "accepted",
		jobId: "job_stable",
		total: 2,
		replayed: true,
		admissionStatus: "queued",
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello {{company}}",
				text: "Hi {{first_name}}",
				recipients: [
					{ email: "a@example.com", company: "A", first_name: "Ada" },
					{ email: "b@example.com", company: "B", first_name: "Ben" },
				],
			}),
		},
		{
			BUCKET: {
				async get() {
					return {
						async json() {
							return { fromName: "Team" };
						},
					};
				},
			},
		} as never,
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		jobId: "job_stable",
		total: 2,
		replayed: true,
		admissionStatus: "queued",
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.operationId, "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147");
});

test("bulk reservation rejects malformed HTML before creating durable state", async () => {
	const { app, calls } = appWithResult({ status: "reserved" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147/reserve",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				html: "<div>",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Invalid bulk reservation request: Message HTML is malformed.",
		code: "invalid_bulk_request",
	});
	assert.deepEqual(calls, []);
});

test("bulk admission rejects CID images introduced by personalization before queueing", async () => {
	const { app, calls } = appWithResult({ status: "accepted" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				html: '<img src="{{image_url}}">',
				recipients: [
					{
						email: "a@example.com",
						image_url: "cid:missing@mail-portal.local",
					},
				],
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error:
			"Invalid bulk request: An inline image in the message is missing its attachment (missing@mail-portal.local).",
		code: "invalid_bulk_request",
	});
	assert.deepEqual(calls, []);
});

test("bulk reservation is durable before admission and never reads mailbox settings", async () => {
	const expiresAt = Date.parse("2026-07-14T12:10:00.000Z");
	const { app, calls } = appWithResult({
		status: "reserved",
		replayed: false,
		record: {
			operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
			actorUserId: "user-1",
			fingerprint: "a".repeat(64),
			total: 1,
			createdAt: expiresAt - 60_000,
			expiresAt,
		},
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147/reserve",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				text: "Body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{
			BUCKET: {
				async get() {
					throw new Error("reservation must not read R2");
				},
			},
		} as never,
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		state: "reserved",
		expiresAt: "2026-07-14T12:10:00.000Z",
	});
	assert.equal(calls.length, 1);
	const reservation = calls[0]?.reserveBulkOperation as Record<string, unknown>;
	assert.equal(reservation.operationId, "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147");
	assert.equal(reservation.actorUserId, "user-1");
	assert.equal(reservation.total, 1);
	assert.match(String(reservation.fingerprint), /^[0-9a-f]{64}$/);
});

test("unused reservation cancellation is actor-bound and content-free", async () => {
	const { app, calls } = appWithResult({ status: "cancelled" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147/reservation",
		{ method: "DELETE" },
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "cancelled" });
	assert.deepEqual(calls, [
		{
			cancelBulkReservation: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
			actorUserId: "user-1",
		},
	]);
});

test("an unconfirmed admission is retryable with the same operation identity", async () => {
	const { app } = appWithResult(new Error("alarm scheduling failed"));
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				text: "Body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{
			BUCKET: {
				async get() {
					return {
						async json() {
							return {};
						},
					};
				},
			},
		} as never,
	);

	assert.equal(response.status, 503);
	assert.equal(response.headers.get("retry-after"), "3");
	assert.deepEqual(await response.json(), {
		error:
			"The bulk job outcome could not be confirmed. Retry this exact submission safely.",
		code: "bulk_admission_unconfirmed",
	});
});

test("reusing a bulk operation identity for different content is a conflict", async () => {
	const { app } = appWithResult({
		status: "conflict",
		jobId: "job_original",
		total: 2,
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Changed",
				text: "Changed body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{
			BUCKET: {
				async get() {
					return {
						async json() {
							return {};
						},
					};
				},
			},
		} as never,
	);

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error:
			"This bulk operation identity was already used for different content.",
		code: "bulk_admission_conflict",
		jobId: "job_original",
	});
});

test("malformed JSON is a definitive invalid request", async () => {
	const { app, calls } = appWithResult({ status: "accepted" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"invalid_bulk_request",
	);
	assert.equal(calls.length, 0);
});

test("mailbox settings uncertainty is a retryable admission failure", async () => {
	const { app, calls } = appWithResult({ status: "accepted" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				text: "Body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{
			BUCKET: {
				async get() {
					throw new Error("R2 unavailable");
				},
			},
		} as never,
	);

	assert.equal(response.status, 503);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"bulk_admission_unconfirmed",
	);
	assert.equal(calls.length, 0);
});

test("bulk requests are byte-bounded before JSON parsing or storage", async () => {
	const { app, calls } = appWithResult({ status: "accepted" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "x".repeat(BULK_LIMITS.requestBytes + 1),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 413);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"bulk_request_too_large",
	);
	assert.equal(calls.length, 0);
});

test("missing operation identity is a definitive invalid request", async () => {
	const { app, calls } = appWithResult({ status: "accepted" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				subject: "Hello",
				text: "Body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 400);
	assert.equal(calls.length, 0);
});

test("bounded mailbox backlog returns a retryable capacity result", async () => {
	const retryAt = Date.now() + 60_000;
	const { app } = appWithResult({
		status: "capacity",
		code: "bulk_capacity_reached",
		error: "Wait for current jobs to finish.",
		reason: "active_backlog",
		retryAt,
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
				subject: "Hello",
				text: "Body",
				recipients: [{ email: "a@example.com" }],
			}),
		},
		{
			BUCKET: {
				async get() {
					return null;
				},
			},
		} as never,
	);

	assert.equal(response.status, 429);
	assert.ok(Number(response.headers.get("retry-after")) <= 60);
	const body = (await response.json()) as {
		code: string;
		reason: string;
		retryAt: string;
	};
	assert.equal(body.code, "bulk_capacity_reached");
	assert.equal(body.reason, "active_backlog");
	assert.equal(body.retryAt, new Date(retryAt).toISOString());
});

test("bulk progress rejects malformed job identities before Durable Object work", async () => {
	const { app, calls } = appWithResult({ status: "done" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/not-a-job",
		undefined,
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 404);
	assert.equal(calls.length, 0);
});

test("an opaque operation identity recovers only the current actor's job", async () => {
	const { app, calls } = appWithResult({
		state: "admitted",
		jobId: "job_stable",
		total: 2,
		admissionStatus: "preparing",
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		undefined,
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		state: "admitted",
		jobId: "job_stable",
		total: 2,
		admissionStatus: "preparing",
	});
	assert.deepEqual(calls, [
		{
			getBulkJobByOperation: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
			actorUserId: "user-1",
		},
	]);
});

test("operation recovery keeps a content-free reservation locked until expiry", async () => {
	const { app } = appWithResult({
		state: "reserved",
		expiresAt: Date.parse("2026-07-14T12:10:00.000Z"),
	});
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		undefined,
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), {
		state: "reserved",
		expiresAt: "2026-07-14T12:10:00.000Z",
	});
});

test("operation recovery reports an expired reservation authoritatively", async () => {
	const { app } = appWithResult({ state: "expired" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
		undefined,
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 410);
	assert.deepEqual(await response.json(), {
		error: "Bulk operation reservation expired.",
		code: "bulk_reservation_expired",
	});
});

test("bulk operation recovery rejects malformed identities before Durable Object work", async () => {
	const { app, calls } = appWithResult({ jobId: "job_stable" });
	const response = await app.request(
		"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk/operations/not-a-uuid",
		undefined,
		{ BUCKET: {} } as never,
	);

	assert.equal(response.status, 404);
	assert.equal(calls.length, 0);
});

test("bulk admission logs a content-free completed boundary", async () => {
	const events: unknown[][] = [];
	const prior = console.info;
	console.info = (...args: unknown[]) => events.push(args);
	try {
		const { app } = appWithResult({
			status: "accepted",
			jobId: "job_stable",
			total: 1,
			replayed: false,
			admissionStatus: "preparing",
		});
		const response = await app.request(
			"http://mail.example.com/api/v1/mailboxes/team@example.com/bulk",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					operationId: "9a5e7bd2-52df-4f4d-b8a9-27a42c7e3147",
					subject: "Must never enter logs",
					text: "Private body",
					recipients: [{ email: "private@example.com" }],
				}),
			},
			{
				BUCKET: {
					async get() {
						return null;
					},
				},
			} as never,
		);
		assert.equal(response.status, 202);
	} finally {
		console.info = prior;
	}

	const serialized = JSON.stringify(events);
	assert.match(serialized, /bulk_admission/);
	assert.match(serialized, /completed/);
	assert.match(serialized, /job_stable/);
	assert.doesNotMatch(serialized, /Must never enter logs|Private body|private@example\.com/);
});
