import assert from "node:assert/strict";
import test from "node:test";
import { encodeMailboxChangeCursor } from "../../shared/mailbox-change-feed.ts";
import api from "./api.ts";

test("mailbox change feed forwards only the encoded mailbox cursor and validates the response", async () => {
	const requested: string[] = [];
	const cursor = encodeMailboxChangeCursor(7);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (input) => {
		requested.push(String(input));
		return Promise.resolve(new Response(JSON.stringify({
			changes: [{
				sequence: 8,
				schemaVersion: 1,
				committedAt: "2026-07-12T12:30:00.000Z",
				resource: "message",
				entityId: "message-1",
				parentId: null,
				operation: "updated",
			}],
			nextCursor: encodeMailboxChangeCursor(8),
		}), {
			status: 200,
			headers: { "content-type": "application/json" },
		}));
	};
	try {
		const page = await api.listMailboxChanges("team/mail@example.com", cursor);
		assert.equal(page.changes[0]?.entityId, "message-1");
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(
		requested[0],
		`/api/v1/mailboxes/team%2Fmail%40example.com/changes?after=${cursor}`,
	);
});

test("mailbox change feed rejects content-bearing or cursor-inconsistent responses", async () => {
	const cursor = encodeMailboxChangeCursor(7);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({
		changes: [{
			sequence: 8,
			schemaVersion: 1,
			committedAt: "2026-07-12T12:30:00.000Z",
			resource: "message",
			entityId: "message-1",
			parentId: null,
			operation: "updated",
			subject: "must never enter the client feed",
		}],
		nextCursor: encodeMailboxChangeCursor(8),
	}), {
		status: 200,
		headers: { "content-type": "application/json" },
	}));
	try {
		await assert.rejects(
			api.listMailboxChanges("team@example.com", cursor),
			/invalid/i,
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
