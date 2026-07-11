import assert from "node:assert/strict";
import test from "node:test";
import { resolveUnambiguousThreadReference } from "./thread-reference.ts";

test("thread reference resolution follows candidate order and rejects duplicates", () => {
	const rows = [
		{ id: "root", messageId: "raw-root", threadId: "root-thread" },
		{ id: "direct", messageId: "raw-direct", threadId: "direct-thread" },
	];
	assert.equal(
		resolveUnambiguousThreadReference(["raw-root", "raw-direct"], rows),
		null,
	);
	assert.equal(
		resolveUnambiguousThreadReference(["raw-root"], rows),
		"root-thread",
	);
	assert.equal(
		resolveUnambiguousThreadReference(["duplicate"], [
			{ id: "a", messageId: "duplicate", threadId: "thread-a" },
			{ id: "b", messageId: "duplicate", threadId: "thread-b" },
		]),
		null,
	);
});
