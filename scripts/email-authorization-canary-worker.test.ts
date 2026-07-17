import assert from "node:assert/strict";
import test from "node:test";
import { createCanaryWorker } from "./email-authorization-canary-worker.ts";

const RUN_ID = "canary-wiser-0123456789abcdef";
const AUTH_TOKEN = "authorization-token-with-enough-entropy";
const FORWARD_PROBE = `${RUN_ID}-forward-above-general-limit`;
const SEND_PROBE = `${RUN_ID}-send-near-inbound-limit`;
const ABOVE_GENERAL_LIMIT = Math.ceil(5.1 * 1024 * 1024);
const NEAR_INBOUND_LIMIT = 24_960_359;

function createEnvironment() {
	const values = new Map<string, string>();
	return {
		CANARY_AUTH_TOKEN: AUTH_TOKEN,
		CANARY_DESTINATION: "verified-destination@example.com",
		CANARY_RECIPIENT: "mail-auth-canary@wiserchat.ai",
		CANARY_RUN_ID: RUN_ID,
		CANARY_SENDER: "emergency-forward@wiserchat.ai",
		CANARY_STATE: {
			async get(key: string) {
				return values.get(key) ?? null;
			},
			async put(key: string, value: string) {
				values.set(key, value);
			},
		},
		EMAIL: {
			async send() {
				return { messageId: "send-binding-message-id" };
			},
		},
		values,
	};
}

function createExecutionContext() {
	const promises: Promise<unknown>[] = [];
	return {
		promises,
		waitUntil(promise: Promise<unknown>) {
			promises.push(promise);
		},
	};
}

function createIncomingMessage(
	overrides: Partial<{
		from: string;
		to: string;
		rawSize: number;
		probeId: string;
		expectedBytes: number;
		forward: () => Promise<{ messageId: string }>;
	}> = {},
) {
	const probeId = overrides.probeId ?? FORWARD_PROBE;
	const expectedBytes = overrides.expectedBytes ?? ABOVE_GENERAL_LIMIT;
	let rejection: string | null = null;
	return {
		from: overrides.from ?? "emergency-forward@wiserchat.ai",
		to: overrides.to ?? "mail-auth-canary@wiserchat.ai",
		raw: new ReadableStream<Uint8Array>(),
		rawSize: overrides.rawSize ?? expectedBytes,
		headers: new Headers({
			"X-Canary-Probe-ID": probeId,
			"X-Canary-Raw-Bytes": String(expectedBytes),
		}),
		setReject(reason: string) {
			rejection = reason;
		},
		async forward() {
			return overrides.forward
				? overrides.forward()
				: { messageId: "forward-message-id" };
		},
		get rejection() {
			return rejection;
		},
	};
}

test("the email handler forwards only the exact run probe and stores bounded proof", async () => {
	const env = createEnvironment();
	const context = createExecutionContext();
	const worker = createCanaryWorker({
		createEmailMessage: async () => {
			throw new Error("send path is not in scope");
		},
	});
	const message = createIncomingMessage();
	await worker.email(message, env, context);
	await Promise.all(context.promises);
	assert.equal(message.rejection, null);
	assert.deepEqual(
		JSON.parse(env.values.get(`result:${FORWARD_PROBE}`) ?? ""),
		{
			messageId: "forward-message-id",
			probeId: FORWARD_PROBE,
			rawBytes: ABOVE_GENERAL_LIMIT,
			status: "accepted",
			observedRawBytes: ABOVE_GENERAL_LIMIT,
		},
	);
});

test("the email handler rejects unexpected envelope, probe, or wire size", async () => {
	const worker = createCanaryWorker({
		createEmailMessage: async () => {
			throw new Error("send path is not in scope");
		},
	});
	for (const message of [
		createIncomingMessage({ from: "other@wiserchat.ai" }),
		createIncomingMessage({ to: "other@wiserchat.ai" }),
		createIncomingMessage({ probeId: `${RUN_ID}-unknown` }),
		createIncomingMessage({ rawSize: 5 * 1024 * 1024 }),
		createIncomingMessage({ rawSize: ABOVE_GENERAL_LIMIT + 1024 * 1024 + 1 }),
		createIncomingMessage({ rawSize: ABOVE_GENERAL_LIMIT + 8_192 }),
		createIncomingMessage({
			rawSize: NEAR_INBOUND_LIMIT + 16_384,
			expectedBytes: NEAR_INBOUND_LIMIT,
			probeId: `${RUN_ID}-forward-near-inbound-limit`,
		}),
	]) {
		const env = createEnvironment();
		const context = createExecutionContext();
		await worker.email(message, env, context);
		await Promise.all(context.promises);
		if (
			message.rawSize === ABOVE_GENERAL_LIMIT + 8_192 ||
			message.rawSize === NEAR_INBOUND_LIMIT + 16_384
		) {
			assert.equal(message.rejection, null);
		} else {
			assert.equal(message.rejection, "Canary envelope did not match");
		}
	}
});

test("a forward failure is recorded without asking Email Routing to retry", async () => {
	const env = createEnvironment();
	const context = createExecutionContext();
	const worker = createCanaryWorker({
		createEmailMessage: async () => {
			throw new Error("send path is not in scope");
		},
	});
	const message = createIncomingMessage({
		forward: async () => {
			throw new Error("provider detail must not be persisted");
		},
	});
	await worker.email(message, env, context);
	await Promise.all(context.promises);
	assert.deepEqual(
		JSON.parse(env.values.get(`result:${FORWARD_PROBE}`) ?? ""),
		{
			probeId: FORWARD_PROBE,
			rawBytes: ABOVE_GENERAL_LIMIT,
			status: "failed",
			observedRawBytes: ABOVE_GENERAL_LIMIT,
		},
	);
});

test("the fetch lane requires bearer auth and sends only an exact allowed fixture", async () => {
	const env = createEnvironment();
	const created: unknown[][] = [];
	const worker = createCanaryWorker({
		async createEmailMessage(...arguments_) {
			created.push(arguments_);
			return { arguments_ };
		},
	});
	const unauthorized = await worker.fetch(
		new Request("https://canary.example/send", {
			method: "POST",
			body: "no",
			headers: {
				"Content-Length": "2",
				"Content-Type": "message/rfc822",
			},
		}),
		env,
	);
	assert.equal(unauthorized.status, 401);

	const request = new Request("https://canary.example/send", {
		method: "POST",
		body: "fixture",
		headers: {
			Authorization: `Bearer ${AUTH_TOKEN}`,
			"Content-Length": String(NEAR_INBOUND_LIMIT),
			"Content-Type": "message/rfc822",
			"X-Canary-Probe-ID": SEND_PROBE,
			"X-Canary-Raw-Bytes": String(NEAR_INBOUND_LIMIT),
		},
	});
	const response = await worker.fetch(request, env);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		messageId: "send-binding-message-id",
		probeId: SEND_PROBE,
		rawBytes: NEAR_INBOUND_LIMIT,
		status: "accepted",
	});
	assert.equal(created.length, 1);
	assert.equal(created[0]?.[0], env.CANARY_SENDER);
	assert.equal(created[0]?.[1], env.CANARY_DESTINATION);
	assert.ok(created[0]?.[2] instanceof ReadableStream);
});

test("status returns only a result owned by the exact run", async () => {
	const env = createEnvironment();
	env.values.set(
		`result:${FORWARD_PROBE}`,
		JSON.stringify({ status: "accepted", probeId: FORWARD_PROBE }),
	);
	const worker = createCanaryWorker({
		createEmailMessage: async () => {
			throw new Error("send path is not in scope");
		},
	});
	const response = await worker.fetch(
		new Request(
			`https://canary.example/status?probe=${encodeURIComponent(FORWARD_PROBE)}`,
			{ headers: { Authorization: `Bearer ${AUTH_TOKEN}` } },
		),
		env,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "accepted",
		probeId: FORWARD_PROBE,
	});
	const other = await worker.fetch(
		new Request("https://canary.example/status?probe=another-run-forward-near-inbound-limit", {
			headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
		}),
		env,
	);
	assert.equal(other.status, 400);
});
