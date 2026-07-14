import assert from "node:assert/strict";
import test from "node:test";
import { toolDraftEmail, toolDraftReply } from "./tools.ts";

test("MCP draft creation cannot persist CID HTML without attachment support", async () => {
	let creates = 0;
	const stub = {
		async getDraftCreateReplay() { return { status: "missing" }; },
		async upsertDraft() { creates++; return { status: "saved", draftId: "draft-1" }; },
		async getEmail() { return null; },
	};
	const env = {
		MAILBOX: {
			idFromName: () => "mailbox-id",
			get: () => stub,
		},
	} as never;
	const body = '<img src="cid:missing@mail-portal.local" data-mail-inline-image="v1">';

	const compose = await toolDraftEmail(
		env,
		"team@example.com",
		{ to: "person@example.com", subject: "CID", body },
		{ kind: "mcp", id: "user-1" },
		{
			surface: "mcp",
			toolName: "create_draft",
			sessionId: "session-1",
			requestId: 1,
		},
	);
	const reply = await toolDraftReply(
		env,
		"team@example.com",
		{
			originalEmailId: "original-1",
			to: "person@example.com",
			subject: "Re: CID",
			body,
		},
		{ kind: "agent", id: "user-2" },
		{
			surface: "agent",
			toolName: "draft_reply",
			requestId: "request-1",
			toolCallId: "call-1",
		},
	);

	assert.deepEqual(compose, {
		error: "An inline image in the message is missing its attachment (missing@mail-portal.local).",
	});
	assert.deepEqual(reply, {
		error: "An inline image in the message is missing its attachment (missing@mail-portal.local).",
	});
	assert.equal(creates, 0);
});
