import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { handleSesEvent } from "./ses-events.ts";

function mailboxKey(value: string) {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function recipientHash(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value.toLowerCase()),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
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
					async recordSesProviderEvent(input: unknown) {
						recorded.push(input);
						return resultStatus === "recovery_pending"
							? { status: "recorded", recoveryPending: true }
							: { status: resultStatus };
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
				id: "event-1",
				time: "2026-07-16T10:00:00.000Z",
				detail: {
					eventType: "Bounce",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
					bounce: {
						bounceType: "Permanent",
						bouncedRecipients: [{ emailAddress: "Customer@Example.com" }],
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.equal(recorded.length, 1);
	assert.deepEqual(recorded[0], {
		eventId: "event-1",
		deliveryId: "delivery-1",
		attemptId: "attempt-1",
		sesMessageId: "ses-message-1",
		eventType: "bounce",
		recipientHashes: [await recipientHash("customer@example.com")],
		occurredAt: "2026-07-16T10:00:00.000Z",
		receivedAt: (recorded[0] as { receivedAt: string }).receivedAt,
	});
});

test("a bounce without parseable recipient scope is preserved for unknown-outcome handling", async () => {
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
				id: "event-unscoped-bounce",
				detail: {
					eventType: "Bounce",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
					bounce: { bouncedRecipients: [{ diagnosticCode: "scope omitted" }] },
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(
		(recorded[0] as { recipientHashes: string[] }).recipientHashes,
		[],
	);
});

test("unsupported SES events are ignored without touching mailbox state", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({ detail: { eventType: "Open" } }),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(recorded, []);
});

test("raced SES events return a retryable response", async () => {
	const { app, env } = testApp("not_found");
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-2",
				detail: {
					eventType: "Complaint",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 503);
});

test("a committed event with pending projection asks the provider to retry", async () => {
	const { app, env } = testApp("recovery_pending");
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-recovery",
				detail: {
					eventType: "Delivery",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 503);
});
