import assert from "node:assert/strict";
import test from "node:test";
import { toolDeleteEmail, toolMoveEmail, toolUpdateDraft } from "./tools.ts";

function environment(result: {
	status: "outbound_delivery_active";
	deliveryId: string;
}) {
	const stub = {
		async moveEmail() {
			return result;
		},
		async trashEmail() {
			return result;
		},
	};
	return {
		MAILBOX: {
			idFromName: () => "mailbox-id",
			get: () => stub,
		},
	} as never;
}

test("automation tools cannot treat an active Outbox lifecycle rejection as a successful move", async () => {
	const env = environment({
		status: "outbound_delivery_active",
		deliveryId: "delivery-1",
	});

	assert.deepEqual(
		await toolMoveEmail(
			env,
			"team@example.com",
			"email-1",
			"trash",
			{ kind: "agent", id: "user-1" },
		),
		{
			error: "Cancel the queued send before moving its Outbox message.",
			code: "active_outbound_delivery_requires_cancel",
			deliveryId: "delivery-1",
		},
	);

	assert.deepEqual(
		await toolDeleteEmail(
			env,
			"team@example.com",
			"email-1",
			{ kind: "mcp", id: "user-1" },
		),
		{
			error: "Cancel the queued send before moving its Outbox message.",
			code: "active_outbound_delivery_requires_cancel",
			deliveryId: "delivery-1",
			emailId: "email-1",
		},
	);
});

test("automation draft updates use the caller's exact draft revision", async () => {
	let receivedVersion: number | undefined;
	const stub = {
		async getEmail() {
			return {
				id: "draft-1",
				folder_id: "draft",
				draft_version: 7,
				subject: "Original",
				recipient: "person@example.com",
				body: "short",
			};
		},
		async updateDraft(_id: string, expectedVersion: number) {
			receivedVersion = expectedVersion;
			return { status: "version_conflict", currentVersion: 8 };
		},
	};
	const env = {
		MAILBOX: { idFromName: () => "mailbox-id", get: () => stub },
		AI: {},
	} as never;

	assert.deepEqual(
		await toolUpdateDraft(
			env,
			"team@example.com",
			{ draftId: "draft-1", draftVersion: 7, subject: "Revised" },
			{ kind: "mcp", id: "user-1" },
		),
		{
			error: "Draft changed in another session. Reload it before updating.",
			currentVersion: 8,
		},
	);
	assert.equal(receivedVersion, 7);
});

test("automation draft updates cannot break authoritative inline mappings", async () => {
	let updates = 0;
	const stub = {
		async getEmail() {
			return {
				id: "draft-1",
				folder_id: "draft",
				draft_version: 7,
				subject: "Original",
				recipient: "person@example.com",
				body: '<img src="cid:chart@mail-portal.local">',
				attachments: [{
					id: "inline-1",
					filename: "chart.png",
					mimetype: "image/png",
					size: 3,
					content_id: "chart@mail-portal.local",
					disposition: "inline",
				}],
			};
		},
		async updateDraft() {
			updates++;
			return { status: "updated" };
		},
	};
	const env = {
		MAILBOX: { idFromName: () => "mailbox-id", get: () => stub },
		AI: {},
	} as never;

	assert.deepEqual(
		await toolUpdateDraft(
			env,
			"team@example.com",
			{
				draftId: "draft-1",
				draftVersion: 7,
				bodyHtml: '<img src="cid:missing@mail-portal.local" data-mail-inline-image="v1">',
			},
			{ kind: "mcp", id: "user-1" },
		),
		{
			error: "An inline image in the message is missing its attachment (missing@mail-portal.local).",
		},
	);
	assert.equal(updates, 0);
});

test("exact MCP Draft update replay skips Draft reads and verification", async () => {
	let draftReads = 0;
	let updates = 0;
	const stub = {
		async getDraftUpdateOutcome() {
			return {
				status: "replay",
				draftId: "draft-1",
				resultVersion: 8,
			};
		},
		async getEmail() {
			draftReads++;
			return null;
		},
		async updateDraftIdempotently() {
			updates++;
			return { status: "updated", draftId: "draft-1", draftVersion: 8 };
		},
	};
	const env = {
		MAILBOX: { idFromName: () => "mailbox-id", get: () => stub },
		AI: {
			run() {
				throw new Error("Verification must not run for replay");
			},
		},
	} as never;

	assert.deepEqual(
		await toolUpdateDraft(
			env,
			"team@example.com",
			{ draftId: "draft-1", draftVersion: 7, subject: "Revised" },
			{ kind: "mcp", id: "user-1" },
			{
				surface: "mcp",
				toolName: "update_draft",
				sessionId: "session-1",
				requestId: 1,
			},
		),
		{
			status: "draft_updated",
			newDraftId: "draft-1",
			oldDraftId: "draft-1",
			draftVersion: 8,
			replayed: true,
			message: "This exact Draft update already committed. Read the Draft before making another update.",
		},
	);
	assert.equal(draftReads, 0);
	assert.equal(updates, 0);
});

test("changed intent under one MCP Draft update identity conflicts before reads", async () => {
	let draftReads = 0;
	const stub = {
		async getDraftUpdateOutcome() {
			return { status: "conflict" };
		},
		async getEmail() {
			draftReads++;
			return null;
		},
	};
	const env = {
		MAILBOX: { idFromName: () => "mailbox-id", get: () => stub },
	} as never;

	assert.deepEqual(
		await toolUpdateDraft(
			env,
			"team@example.com",
			{ draftId: "draft-1", draftVersion: 7, subject: "Changed" },
			{ kind: "mcp", id: "user-1" },
			{
				surface: "mcp",
				toolName: "update_draft",
				sessionId: "session-1",
				requestId: 1,
			},
		),
		{
			error: "This MCP request ID was already used for different Draft update data.",
			code: "draft_update_idempotency_conflict",
		},
	);
	assert.equal(draftReads, 0);
});
