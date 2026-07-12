import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	MailboxChangeQueryError,
	encodeMailboxChangeCursor,
	type MailboxChangePage,
} from "../../shared/mailbox-change-feed.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	createMailboxChangeFeedRoutes,
	type MailboxChangeFeedOperations,
} from "./mailbox-change-feed.ts";

const page: MailboxChangePage = {
	changes: [{
		sequence: 3,
		schemaVersion: 1,
		committedAt: "2026-07-12T12:30:00.123Z",
		resource: "message",
		entityId: "message-1",
		parentId: null,
		operation: "updated",
	}],
	nextCursor: encodeMailboxChangeCursor(3),
};

function app(
	operations: MailboxChangeFeedOperations,
	revalidateAccess: () => Promise<boolean> = async () => true,
) {
	const root = new Hono<MailboxContext>();
	root.route("/", createMailboxChangeFeedRoutes({
		operations: () => operations,
		revalidateAccess,
	}));
	return root;
}

test("mailbox change route validates the exact query before storage and returns a strict page", async () => {
	let received: unknown;
	const operations: MailboxChangeFeedOperations = {
		async list(options) {
			received = options;
			return page;
		},
	};
	const response = await app(operations).request(
		`/api/v1/mailboxes/team%40example.com/changes?after=${encodeMailboxChangeCursor(2)}&limit=25`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(received, { after: 2, limit: 25 });
	assert.deepEqual(await response.json(), page);

	for (const query of ["?unexpected=1", "?limit=101", "?after=a&after=b"]) {
		received = undefined;
		const invalid = await app(operations).request(
			`/api/v1/mailboxes/team%40example.com/changes${query}`,
		);
		assert.equal(invalid.status, 400);
		assert.equal(received, undefined);
	}
});

test("mailbox change route exposes nothing when access is revoked after the Durable Object read", async () => {
	const calls: string[] = [];
	const response = await app({
		async list() {
			calls.push("read");
			return page;
		},
	}, async () => {
		calls.push("access");
		return false;
	}).request("/api/v1/mailboxes/team%40example.com/changes");
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.deepEqual(calls, ["read", "access"]);
});

test("mailbox change route converts future cursor failures into stable 400 responses", async () => {
	const response = await app({
		async list() {
			throw new MailboxChangeQueryError("Future mailbox change cursor is invalid");
		},
	}).request(
		`/api/v1/mailboxes/team%40example.com/changes?after=${encodeMailboxChangeCursor(99)}`,
	);
	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "Future mailbox change cursor is invalid",
		code: "INVALID_QUERY",
	});
});

test("post-read revocation wins over a future-cursor storage failure", async () => {
	const calls: string[] = [];
	const response = await app({
		async list() {
			calls.push("read");
			throw new MailboxChangeQueryError("Future mailbox change cursor is invalid");
		},
	}, async () => {
		calls.push("access");
		return false;
	}).request(
		`/api/v1/mailboxes/team%40example.com/changes?after=${encodeMailboxChangeCursor(99)}`,
	);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.deepEqual(calls, ["read", "access"]);
});
