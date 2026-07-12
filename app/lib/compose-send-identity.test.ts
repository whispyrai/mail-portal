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

test("an exact source-draft retry reuses its key after the composer reloads", () => {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	};
	const payload = { source_draft_id: "draft-1", source_draft_version: 4 };
	const first = new LogicalSendIdentity(() => "stable-send-key", storage);
	const reloaded = new LogicalSendIdentity(() => "must-not-be-used", storage);

	assert.equal(first.keyFor(payload, "send:draft-1:4:now"), "stable-send-key");
	assert.equal(
		reloaded.keyFor(payload, "send:draft-1:4:now"),
		"stable-send-key",
	);
});
