import assert from "node:assert/strict";
import test from "node:test";
import {
	sendEmailWithOutcome,
	type SesRequestTransport,
} from "./email-sender.ts";
import type { Env } from "./types.ts";

const env = {
	AWS_ACCESS_KEY_ID: "test-access-key",
	AWS_SECRET_ACCESS_KEY: "test-secret-key",
	AWS_REGION: "eu-west-2",
	SES_CONFIGURATION_SET: "mail-portal-events",
} as Env;

const params = {
	to: "recipient@example.com",
	from: { email: "sender@example.com", name: "Sender" },
	subject: "A truthful send",
	text: "Hello",
};

function transport(
	fetch: SesRequestTransport["fetch"],
): SesRequestTransport {
	return { fetch };
}

test("SES acceptance requires a non-empty provider MessageId", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () =>
				Response.json({ MessageId: "ses-message-1" }, { status: 200 }),
			),
	});

	assert.deepEqual(outcome, {
		kind: "accepted",
		messageId: "ses-message-1",
	});
});

test("SES request carries mailbox and delivery correlation tags", async () => {
	let payload: Record<string, unknown> | undefined;
	const outcome = await sendEmailWithOutcome(
		env,
		{
			...params,
			tracking: {
				mailboxId: "team@example.com",
				deliveryId: "delivery_123",
			},
		},
		{
			createTransport: () =>
				transport(async (_url, request) => {
					payload = JSON.parse(String(request.body));
					return Response.json({ MessageId: "ses-message-1" });
				}),
		},
	);

	assert.equal(outcome.kind, "accepted");
	assert.deepEqual(payload?.EmailTags, [
		{ Name: "MailboxKey", Value: "dGVhbUBleGFtcGxlLmNvbQ" },
		{ Name: "DeliveryId", Value: "delivery_123" },
	]);
	assert.equal(payload?.ConfigurationSetName, "mail-portal-events");
});

test("an explicit SES HTTP rejection preserves its status and response detail", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () => new Response("Message rejected", { status: 400 })),
	});

	assert.deepEqual(outcome, {
		kind: "http_error",
		status: 400,
		detail: "Message rejected",
	});
});

test("a failure before the transport exists is proven not dispatched", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () => {
			throw new Error("credentials are unavailable");
		},
	});

	assert.deepEqual(outcome, {
		kind: "not_dispatched",
		detail: "credentials are unavailable",
	});
});

test("a thrown transport fetch is ambiguous and never reported as not dispatched", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () => {
				throw new Error("connection closed after upload");
			}),
	});

	assert.deepEqual(outcome, {
		kind: "transport_ambiguous",
		detail: "connection closed after upload",
	});
});

test("a successful response without a MessageId is ambiguous", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () => Response.json({}, { status: 200 })),
	});

	assert.deepEqual(outcome, {
		kind: "invalid_success_response",
		detail: "SES SendEmail returned no MessageId",
	});
});

test("an unreadable successful response is ambiguous", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () =>
				new Response("not-json", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
				),
	});

	assert.equal(outcome.kind, "invalid_success_response");
	assert.match(outcome.detail ?? "", /JSON|Unexpected/i);
});
