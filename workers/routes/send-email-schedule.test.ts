import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { handleSendEmail } from "./send-email.ts";

const mailboxId = "team@wiserchat.ai";

function fixture() {
	const enqueued: unknown[] = [];
	const app = new Hono<MailboxContext>();
	app.use("*", async (c, next) => {
		c.set("mailboxStub", {
			async getOutboundDeliveryByIdempotencyKey() { return null; },
			async enqueueOutbound(command: unknown) { enqueued.push(command); },
		} as never);
		c.set("session", {
			sub: "user-1",
			email: "person@wiserchat.ai",
			role: "AGENT",
			mailbox: mailboxId,
		});
		await next();
	});
	app.post("/api/v1/mailboxes/:mailboxId/emails", handleSendEmail as never);
	return { app, enqueued };
}

test("compose rejects delayed and far-future schedules before enqueue", async () => {
	for (const scheduledFor of [
		new Date(Date.now() + 30_000).toISOString(),
		new Date(Date.now() + 367 * 24 * 60 * 60_000).toISOString(),
	]) {
		const { app, enqueued } = fixture();
		const response = await app.request(
			`http://mail.wiserchat.ai/api/v1/mailboxes/${mailboxId}/emails`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: "customer@example.com",
					from: mailboxId,
					subject: "Scheduled",
					text: "Body",
					idempotency_key: "compose-invalid-schedule",
					scheduled_for: scheduledFor,
				}),
			},
		);

		assert.equal(response.status, 400);
		assert.equal(enqueued.length, 0);
	}
});
