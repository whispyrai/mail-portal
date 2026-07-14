import assert from "node:assert/strict";
import test from "node:test";
import {
	draftCreateFingerprint,
	draftToolCreateKey,
	type DraftToolInvocation,
} from "./draft-create-idempotency.ts";

test("browser Draft creation fingerprints remain byte-compatible", async () => {
	assert.equal(
		await draftCreateFingerprint({
			to: "person@example.com",
			cc: "copy@example.com",
			bcc: "audit@example.com",
			subject: "Quarterly plan",
			body: "<p>Hello</p>",
			in_reply_to: "message-1",
			thread_id: "thread-1",
			attachments: [{ kind: "upload", uploadId: "upload-1" }],
		}),
		"6cc5b77e5397d03a9cf4edf58c05baa13f1e2e3dfc06a62e816fc78965239d57",
	);
});

test("tool Draft keys isolate every exact invocation namespace", async () => {
	const mcp: DraftToolInvocation = {
		surface: "mcp",
		toolName: "create_draft",
		sessionId: "session-1",
		requestId: 1,
	};
	const agent: DraftToolInvocation = {
		surface: "agent",
		toolName: "draft_email",
		requestId: "request-1",
		toolCallId: "call-1",
	};
	const key = (invocation: DraftToolInvocation, mailboxId = "Team@Example.com", actorId = "user-1") =>
		draftToolCreateKey({
			mailboxId,
			actor: { kind: invocation.surface, id: actorId },
			invocation,
		});
	const baseline = await key(mcp);
	assert.match(baseline, /^[0-9a-f]{64}$/);
	assert.equal(await key(mcp, "team@example.com"), baseline);

	const variants: DraftToolInvocation[] = [
		{ ...mcp, toolName: "draft_reply" },
		{ ...mcp, sessionId: "session-2" },
		{ ...mcp, requestId: "1" },
		agent,
		{ ...agent, toolName: "draft_reply" },
		{ ...agent, requestId: "request-2" },
		{ ...agent, toolCallId: "call-2" },
	];
	const isolated = await Promise.all([
		...variants.map((invocation) => key(invocation)),
		key(mcp, "other@example.com"),
		key(mcp, "team@example.com", "user-2"),
	]);
	assert.equal(new Set([baseline, ...isolated]).size, isolated.length + 1);
});
