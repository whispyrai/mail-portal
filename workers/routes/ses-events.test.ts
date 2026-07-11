import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { handleSesEvent } from "./ses-events.ts";

function mailboxKey(value: string) {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function testApp(resultStatus = "recorded") {
	const recorded: unknown[] = [];
	const app = new Hono();
	app.post("/webhooks/ses", handleSesEvent as never);
	const env = {
		SES_EVENT_WEBHOOK_SECRET: "event-secret",
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get(value: string) {
				assert.equal(value, "team@wiserchat.ai");
				return {
					async recordSesBounce(input: unknown) {
						recorded.push(input);
						return { status: resultStatus };
					},
				};
			},
		},
	};
	return { app, env, recorded };
}

test("SES event callback requires its dedicated bearer secret", async () => {
	const { app, env } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{ method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
		env as never,
	);
	assert.equal(response.status, 401);
});

test("authenticated bounce is correlated to the tagged mailbox and delivery", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				detail: {
					eventType: "Bounce",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
						},
					},
					bounce: { bounceType: "Permanent" },
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.equal(recorded.length, 1);
	assert.deepEqual(recorded[0], {
		deliveryId: "delivery-1",
		sesMessageId: "ses-message-1",
		eventType: "bounce",
		message: JSON.stringify({ bounceType: "Permanent" }),
		at: (recorded[0] as { at: string }).at,
	});
});

test("non-failure SES events are ignored without touching mailbox state", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({ detail: { eventType: "Delivery" } }),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(recorded, []);
});

test("raced SES events return a retryable response", async () => {
	const { app, env } = testApp("invalid_state");
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				detail: {
					eventType: "Complaint",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
						},
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 503);
});
