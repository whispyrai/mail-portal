import assert from "node:assert/strict";
import test from "node:test";
import { LogicalSendIdentity } from "./compose-send-identity.ts";

test("a logical send keeps one idempotency key across transport retries", () => {
	let sequence = 0;
	const identity = new LogicalSendIdentity(() => `send-key-${++sequence}`);
	const payload = { to: ["person@example.com"], subject: "Hello", body: "Hi" };

	assert.equal(identity.keyFor(payload), "send-key-1");
	assert.equal(identity.keyFor({ ...payload }), "send-key-1");
});

test("editing a failed send creates a new logical action", () => {
	let sequence = 0;
	const identity = new LogicalSendIdentity(() => `send-key-${++sequence}`);

	assert.equal(
		identity.keyFor({ subject: "First", attachments: ["upload-1"] }),
		"send-key-1",
	);
	assert.equal(
		identity.keyFor({ subject: "Revised", attachments: ["upload-1"] }),
		"send-key-2",
	);
	assert.equal(
		identity.keyFor({ subject: "Revised", attachments: ["upload-2"] }),
		"send-key-3",
	);
});

test("reset starts a new compose action even when the content is identical", () => {
	let sequence = 0;
	const identity = new LogicalSendIdentity(() => `send-key-${++sequence}`);
	const payload = { subject: "Same" };

	assert.equal(identity.keyFor(payload), "send-key-1");
	identity.reset();
	assert.equal(identity.keyFor(payload), "send-key-2");
});
