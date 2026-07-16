import assert from "node:assert/strict";
import test from "node:test";
import {
	dispatchPreparedSesSend,
	prepareSesSend,
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

function transport(fetch: SesRequestTransport["fetch"]): SesRequestTransport {
	return { fetch };
}

test("SES preparation performs no provider I/O before explicit dispatch", async () => {
	let fetches = 0;
	const preparation = await prepareSesSend(env, params, {
		createTransport: () =>
			transport(async () => {
				fetches += 1;
				return Response.json({ MessageId: "ses-message-1" });
			}),
	});

	assert.equal(preparation.ok, true);
	assert.equal(fetches, 0);
	assert.equal(
		preparation.ok
			? (await dispatchPreparedSesSend(preparation.prepared)).kind
			: "not_prepared",
		"accepted",
	);
	assert.equal(fetches, 1);
});

test("a prepared SES request is single-use even when dispatch is repeated", async () => {
	let fetches = 0;
	const preparation = await prepareSesSend(env, params, {
		createTransport: () =>
			transport(async () => {
				fetches += 1;
				return Response.json({ MessageId: "ses-message-1" });
			}),
	});
	assert.equal(preparation.ok, true);
	if (!preparation.ok) return;

	assert.equal(
		(await dispatchPreparedSesSend(preparation.prepared)).kind,
		"accepted",
	);
	assert.equal(
		(await dispatchPreparedSesSend(preparation.prepared)).kind,
		"transport_ambiguous",
	);
	assert.equal(fetches, 1);
});

test("SES signing failure proves no provider request was dispatched", async () => {
	let fetches = 0;
	const preparation = await prepareSesSend(env, params, {
		signRequest: async () => {
			throw new Error("signing unavailable");
		},
		fetchRequest: async () => {
			fetches += 1;
			return new Response(null, { status: 503 });
		},
	});

	assert.equal(preparation.ok, false);
	assert.equal(preparation.ok ? null : preparation.stage, "transport");
	assert.equal(fetches, 0);
});

for (const status of [429, 503]) {
	test(`SES signed dispatch performs exactly one fetch on HTTP ${status}`, async () => {
		let fetches = 0;
		const preparation = await prepareSesSend(env, params, {
			signRequest: async (_env, url, request) => new Request(url, request),
			fetchRequest: async () => {
				fetches += 1;
				return new Response("provider unavailable", { status });
			},
		});
		assert.equal(preparation.ok, true);

		const outcome = preparation.ok
			? await dispatchPreparedSesSend(preparation.prepared)
			: preparation.outcome;
		assert.equal(outcome.kind, "http_error");
		assert.equal(outcome.kind === "http_error" ? outcome.status : null, status);
		assert.equal(fetches, 1);
	});
}

test("the production SES path signs then performs one global fetch", async () => {
	const originalFetch = globalThis.fetch;
	let fetches = 0;
	let authorization = "";
	let redirect: RequestRedirect | undefined;
	globalThis.fetch = async (input) => {
		fetches += 1;
		const request = input instanceof Request ? input : new Request(input);
		authorization = request.headers.get("authorization") ?? "";
		redirect = request.redirect;
		return new Response("provider unavailable", { status: 503 });
	};
	try {
		const preparation = await prepareSesSend(env, params);
		assert.equal(preparation.ok, true);
		assert.equal(fetches, 0);
		const outcome = preparation.ok
			? await dispatchPreparedSesSend(preparation.prepared)
			: preparation.outcome;
		assert.equal(outcome.kind, "http_error");
		assert.equal(fetches, 1);
		assert.match(authorization, /^AWS4-HMAC-SHA256 /);
		assert.equal(redirect, "manual");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

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
				attemptId: "attempt_456",
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
		{ Name: "AttemptId", Value: "attempt_456" },
	]);
	assert.equal(payload?.ConfigurationSetName, "mail-portal-events");
});

test("SES serializes inline Content-ID without adding one to ordinary attachments", async () => {
	let payload:
		| {
		Content?: { Simple?: { Attachments?: unknown } };
		  }
		| undefined;
	const outcome = await sendEmailWithOutcome(
		env,
		{
			...params,
			attachments: [
				{
					content: "AQID",
					filename: "diagram.png",
					type: "image/png",
					disposition: "inline",
					contentId: "diagram-1@mail-portal.local",
				},
				{
					content: "BAUG",
					filename: "proposal.pdf",
					type: "application/pdf",
					disposition: "attachment",
					contentId: "legacy-ordinary@example.com",
				},
			],
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
	assert.deepEqual(payload?.Content?.Simple?.Attachments, [
		{
			RawContent: "AQID",
			FileName: "diagram.png",
			ContentType: "image/png",
			ContentDisposition: "INLINE",
			ContentTransferEncoding: "BASE64",
			ContentId: "diagram-1@mail-portal.local",
		},
		{
			RawContent: "BAUG",
			FileName: "proposal.pdf",
			ContentType: "application/pdf",
			ContentDisposition: "ATTACHMENT",
			ContentTransferEncoding: "BASE64",
		},
	]);
});

test("SES sink bounds legacy attachment filename and MIME without changing the extension", async () => {
	let payload:
		| {
		Content?: { Simple?: { Attachments?: Array<Record<string, unknown>> } };
		  }
		| undefined;
	const boundaryFilename = `${"a".repeat(251)}.pdf`;
	const longFilename = `${"a".repeat(252)}.pdf`;
	const longMime = `image/vnd.${"a".repeat(72)}`;
	const outcome = await sendEmailWithOutcome(
		env,
		{
			...params,
			attachments: [
				{
					content: "AQID",
					filename: boundaryFilename,
					type: "application/pdf",
					disposition: "attachment",
				},
				{
					content: "BAUG",
					filename: longFilename,
					type: longMime,
					disposition: "attachment",
				},
			],
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
	const attachments = payload?.Content?.Simple?.Attachments;
	assert.equal(attachments?.[0]?.FileName, boundaryFilename);
	assert.equal(String(attachments?.[1]?.FileName).length, 255);
	assert.match(String(attachments?.[1]?.FileName), /\.pdf$/);
	assert.equal(attachments?.[1]?.ContentType, "application/octet-stream");
});

test("SES sink rejects an overlong inline Content-ID before dispatch", async () => {
	let transportCreated = false;
	const outcome = await sendEmailWithOutcome(
		env,
		{
			...params,
			attachments: [
				{
				content: "AQID",
				filename: "diagram.png",
				type: "image/png",
				disposition: "inline",
				contentId: `${"a".repeat(67)}@example.com`,
				},
			],
		},
		{
			createTransport: () => {
				transportCreated = true;
				return transport(async () =>
					Response.json({ MessageId: "unexpected" }),
				);
			},
		},
	);
	assert.equal(outcome.kind, "not_dispatched");
	assert.equal(transportCreated, false);
	assert.match(outcome.detail ?? "", /Content-ID.*SES/i);
});

test("an explicit SES HTTP rejection preserves its status without retaining provider text", async () => {
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () =>
			transport(async () => new Response("Message rejected", { status: 400 })),
	});

	assert.deepEqual(outcome, {
		kind: "http_error",
		status: 400,
	});
});

test("SES rejection classification never waits for or reads the response body", async () => {
	let bodyRead = false;
	const response = {
		ok: false,
		status: 503,
		text: async () => {
			bodyRead = true;
			throw new Error("body must not be consumed");
		},
	} as Response;
	const outcome = await sendEmailWithOutcome(env, params, {
		createTransport: () => transport(async () => response),
	});

	assert.deepEqual(outcome, { kind: "http_error", status: 503 });
	assert.equal(bodyRead, false);
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
			transport(
				async () =>
				new Response("not-json", {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
				),
	});

	assert.equal(outcome.kind, "invalid_success_response");
	assert.match(outcome.detail ?? "", /JSON|Unexpected/i);
});
