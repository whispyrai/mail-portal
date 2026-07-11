// Inbound email handler contract tests. These exercise the same exported
// handler Cloudflare calls, with only R2 and Durable Objects replaced at the
// platform boundary.

import assert from "node:assert/strict";
import test from "node:test";
import { receiveEmail } from "./inbound-email.ts";

function rawEmail(headers: string, body = "Hello from the Internet.") {
	const bytes = new TextEncoder().encode(`${headers}\r\n\r\n${body}`);
	return {
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		rawSize: bytes.byteLength,
	};
}

test("inbound delivery uses the SMTP envelope recipient when the visible To header differs", async () => {
	const mailboxAddress = "hesham@wiserchat.ai";
	const stored: Array<{ folder: string; email: Record<string, unknown> }> = [];
	const background: Promise<unknown>[] = [];
	const mailbox = {
		async findThreadBySubject() {
			return null;
		},
		async createEmail(folder: string, email: Record<string, unknown>) {
			stored.push({ folder, email });
		},
		async getEmail() {
			return null;
		},
		async firePush() {},
	};
	const env = {
		BRAND: "wiser",
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		EMAIL_ADDRESSES: [],
		BUCKET: {
			async head(key: string) {
				return key === `mailboxes/${mailboxAddress}.json` ? {} : null;
			},
			async put() {},
			async delete() {},
		},
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get(value: string) {
				assert.equal(value, mailboxAddress);
				return mailbox;
			},
		},
	};
	const message = {
		from: "sender@example.com",
		to: mailboxAddress,
		...rawEmail(
			[
				"From: Sender <sender@example.com>",
				"To: Visible recipient <someone-else@example.com>",
				"Subject: Envelope recipient proof",
				"Date: Fri, 10 Jul 2026 12:00:00 +0000",
				"Message-ID: <envelope-proof@example.com>",
			].join("\r\n"),
		),
		setReject(reason: string) {
			assert.fail(`known mailbox was rejected: ${reason}`);
		},
	};
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			background.push(promise);
		},
	};

	await receiveEmail(message, env as never, ctx as never);
	await Promise.all(background);

	assert.equal(stored.length, 1);
	assert.equal(stored[0].folder, "inbox");
});

test("inbound delivery permanently rejects an unprovisioned envelope recipient without reading the message", async () => {
	let rawWasRead = false;
	let rejection: string | undefined;
	const message = {
		from: "sender@example.com",
		to: "typo@wiserchat.ai",
		get raw() {
			rawWasRead = true;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			});
		},
		rawSize: 100,
		setReject(reason: string) {
			rejection = reason;
		},
	};
	const env = {
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		EMAIL_ADDRESSES: [],
		BUCKET: {
			async head() {
				return null;
			},
		},
		MAILBOX: {
			idFromName() {
				assert.fail("unprovisioned recipient must not resolve a Durable Object");
			},
		},
	};

	await receiveEmail(message, env as never, { waitUntil() {} } as never);

	assert.match(rejection ?? "", /mailbox unavailable/i);
	assert.equal(rawWasRead, false);
});

test("inbound delivery rejects an envelope recipient outside EMAIL_ADDRESSES", async () => {
	let rejection: string | undefined;
	let mailboxWasChecked = false;
	const message = {
		from: "sender@example.com",
		to: "contact@wiserchat.ai",
		...rawEmail("From: sender@example.com\r\nTo: contact@wiserchat.ai"),
		setReject(reason: string) {
			rejection = reason;
		},
	};
	const env = {
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		EMAIL_ADDRESSES: ["hello@wiserchat.ai"],
		BUCKET: {
			async head() {
				mailboxWasChecked = true;
				return {};
			},
		},
	};

	await receiveEmail(message, env as never, { waitUntil() {} } as never);

	assert.match(rejection ?? "", /mailbox unavailable/i);
	assert.equal(mailboxWasChecked, false);
});

test("inbound delivery rejects recipients outside the configured mail domains before R2 lookup", async () => {
	let mailboxWasChecked = false;
	let rejection: string | undefined;
	const message = {
		from: "sender@example.com",
		to: "hesham@wiserchat.ai.attacker.example",
		...rawEmail("From: sender@example.com\r\nTo: hesham@wiserchat.ai.attacker.example"),
		setReject(reason: string) {
			rejection = reason;
		},
	};
	const env = {
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		EMAIL_ADDRESSES: [],
		BUCKET: {
			async head() {
				mailboxWasChecked = true;
				return null;
			},
		},
	};

	await receiveEmail(message, env as never, { waitUntil() {} } as never);

	assert.match(rejection ?? "", /mailbox unavailable/i);
	assert.equal(mailboxWasChecked, false);
});

test("inbound push payload uses the active brand's notification assets", async () => {
	const mailboxAddress = "hesham@wiserchat.ai";
	let pushPayload: Record<string, unknown> | undefined;
	const background: Promise<unknown>[] = [];
	const mailbox = {
		async findThreadBySubject() {
			return null;
		},
		async createEmail() {},
		async getEmail() {
			return null;
		},
		async firePush(payload: Record<string, unknown>) {
			pushPayload = payload;
		},
	};
	const env = {
		BRAND: "wiser",
		DOMAINS: "wiserchat.ai",
		EMAIL_ADDRESSES: [],
		BUCKET: {
			async head() {
				return {};
			},
			async put() {},
			async delete() {},
		},
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get() {
				return mailbox;
			},
		},
	};
	const message = {
		from: "sender@example.com",
		to: mailboxAddress,
		...rawEmail(
			"From: sender@example.com\r\nTo: hesham@wiserchat.ai\r\nSubject: Branded push",
		),
		setReject(reason: string) {
			assert.fail(`known mailbox was rejected: ${reason}`);
		},
	};

	await receiveEmail(message, env as never, {
		waitUntil(promise: Promise<unknown>) {
			background.push(promise);
		},
	} as never);
	await Promise.all(background);

	assert.equal(pushPayload?.icon, "/wiser-icon-192.png");
	assert.equal(pushPayload?.badge, "/wiser-badge-96.png");
});
