import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	handleCancelOutboundDelivery,
	handleGetOutboundDelivery,
	handleListOutboundDeliveries,
	handleRetryOutboundDelivery,
} from "./outbound-deliveries.ts";

const base = "/api/v1/mailboxes/team@example.com/outbound-deliveries";

function appWithStub(stub: Record<string, unknown>) {
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", stub as never);
		c.set("session", {
			sub: "user-1",
			email: "user@example.com",
			role: "MEMBER",
			mailbox: "user@example.com",
		});
		await next();
	});
	app.get(`${base}`, handleListOutboundDeliveries);
	app.get(`${base}/:deliveryId`, handleGetOutboundDelivery);
	app.post(`${base}/:deliveryId/cancel`, handleCancelOutboundDelivery);
	app.post(`${base}/:deliveryId/retry`, handleRetryOutboundDelivery);
	return app;
}

test("lists and fetches truthful delivery state", async () => {
	const delivery = { id: "delivery-1", status: "unknown" };
	const app = appWithStub({
		async listOutboundDeliveries() {
			return [delivery];
		},
		async getOutboundDelivery(id: string) {
			assert.equal(id, "delivery-1");
			return delivery;
		},
	});

	const list = await app.request(`http://local${base}`);
	assert.equal(list.status, 200);
	assert.deepEqual(await list.json(), { deliveries: [delivery] });
	const get = await app.request(`http://local${base}/delivery-1`);
	assert.equal(get.status, 200);
	assert.deepEqual(await get.json(), { delivery });
});

test("lists delivery state for the visible email page without relying on a global history cap", async () => {
	const app = appWithStub({
		async listOutboundDeliveriesForEmailIds(emailIds: string[]) {
			assert.deepEqual(emailIds, ["sent-1", "sent-2"]);
			return [{ id: "delivery-2", emailId: "sent-2", status: "bounced" }];
		},
	});
	const response = await app.request(
		`http://local${base}?emailIds=sent-1%2Csent-2`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		deliveries: [{ id: "delivery-2", emailId: "sent-2", status: "bounced" }],
	});
});

test("lists one delivery highlight for every represented thread so older bounces remain visible", async () => {
	const app = appWithStub({
		async listOutboundDeliveryHighlights(
			emailIds: string[],
			threadIds: string[],
		) {
			assert.deepEqual(emailIds, ["latest-sent"]);
			assert.deepEqual(threadIds, ["thread-1"]);
			return [
				{
					id: "delivery-old",
					emailId: "older-sent",
					threadId: "thread-1",
					status: "bounced",
				},
			];
		},
	});
	const response = await app.request(
		`http://local${base}?emailIds=latest-sent&threadIds=thread-1`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		deliveries: [
			{
				id: "delivery-old",
				emailId: "older-sent",
				threadId: "thread-1",
				status: "bounced",
			},
		],
	});
});

test("cancel attributes the user and returns the resulting state", async () => {
	const app = appWithStub({
		async cancelOutboundDelivery(id: string, actor: unknown) {
			assert.equal(id, "delivery-1");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			return {
				delivery: { id, status: "cancelled" },
				recoveredDraftId: "draft_recovered_snapshot-1",
			};
		},
	});
	const response = await app.request(`http://local${base}/delivery-1/cancel`, {
		method: "POST",
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		delivery: { id: "delivery-1", status: "cancelled" },
		recoveredDraftId: "draft_recovered_snapshot-1",
	});
});

test("unknown retry requires an explicit duplicate-risk acknowledgement", async () => {
	const app = appWithStub({
		async retryOutboundDelivery() {
			const error = new Error(
				"Retrying unknown delivery delivery-1 requires duplicate-risk acknowledgement",
			);
			error.name = "DuplicateRiskAcknowledgementRequiredError";
			throw error;
		},
	});
	const response = await app.request(`http://local${base}/delivery-1/retry`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ acknowledgeDuplicateRisk: false }),
	});
	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error:
			"This delivery may already have been accepted. Confirm the duplicate-send risk before retrying.",
		code: "duplicate_risk_acknowledgement_required",
	});
});

test("bulk retry capacity is a truthful retryable response", async () => {
	const app = appWithStub({
		async retryOutboundDelivery() {
			const error = new Error(
				"This Mailbox has the maximum safe bulk backlog.",
			);
			error.name = "OutboundRetryCapacityError";
			throw error;
		},
	});
	const response = await app.request(`http://local${base}/delivery-1/retry`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ acknowledgeDuplicateRisk: false }),
	});
	assert.equal(response.status, 429);
	assert.equal(response.headers.get("retry-after"), "60");
	assert.deepEqual(await response.json(), {
		error:
			"This Mailbox has the maximum safe bulk backlog. Wait for current jobs to progress.",
		code: "bulk_capacity_reached",
	});
});

test("acknowledged unknown retry is attributed and queued", async () => {
	const app = appWithStub({
		async retryOutboundDelivery(
			id: string,
			actor: unknown,
			acknowledged: boolean,
		) {
			assert.equal(id, "delivery-1");
			assert.deepEqual(actor, { kind: "user", id: "user-1" });
			assert.equal(acknowledged, true);
			return { delivery: { id, status: "queued" } };
		},
	});
	const response = await app.request(`http://local${base}/delivery-1/retry`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		delivery: { id: "delivery-1", status: "queued" },
	});
});
