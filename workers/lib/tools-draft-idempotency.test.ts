import assert from "node:assert/strict";
import test from "node:test";
import { classifyDraftCreateReplay } from "./draft-create-replay.ts";
import { toolDraftEmail, toolDraftReply } from "./tools.ts";

type StoredDraft = {
	id: string;
	folder_id: "draft";
	draft_version: number;
	draft_create_key: string;
	draft_create_fingerprint: string;
	subject: string;
	recipient: string;
	body: string;
	in_reply_to: string | null;
	thread_id: string;
};

function fixture() {
	let stored: StoredDraft | null = null;
	let writes = 0;
	let activities = 0;
	let sourceReads = 0;
	let draftReads = 0;
	let terminalState: "discarded" | "consumed" | null = null;
	const original = {
		id: "message-1",
		folder_id: "inbox",
		date: "2026-07-14T08:00:00.000Z",
		sender: "customer@example.com",
		body: "<p>Original question</p>",
		thread_id: "thread-1",
	};
	const stub = {
		async getDraftCreateReplay(createKey: string, fingerprint: string) {
			const replay = classifyDraftCreateReplay(
				stored && stored.draft_create_key === createKey
					? {
							id: stored.id,
							fingerprint: stored.draft_create_fingerprint,
							draftVersion: stored.draft_version,
						}
					: null,
				fingerprint,
			);
			if (replay.status === "replay" && terminalState) {
				return {
					status: "unavailable",
					draftId: replay.draftId,
					currentVersion: stored!.draft_version,
					reason: terminalState,
				};
			}
			return replay.status === "replay"
				? { ...replay, draft: stored }
				: replay;
		},
		async getEmail(id: string) {
			if (id === original.id) {
				sourceReads++;
				return original;
			}
			if (stored?.id === id) {
				draftReads++;
				return stored;
			}
			return null;
		},
		async upsertDraft(input: Record<string, unknown>) {
			const replay = await this.getDraftCreateReplay(
				input.createKey as string,
				input.createFingerprint as string,
			);
			if (replay.status === "replay") {
				return {
					status: "creation_replay",
					draftId: replay.draftId,
					draft: stored,
				};
			}
			if (replay.status === "conflict") {
				return { ...replay, status: "creation_conflict" };
			}
			if (replay.status === "superseded") {
				return { ...replay, status: "creation_superseded" };
			}
			stored = {
				id: input.id as string,
				folder_id: "draft",
				draft_version: 1,
				draft_create_key: input.createKey as string,
				draft_create_fingerprint: input.createFingerprint as string,
				subject: input.subject as string,
				recipient: input.recipient as string,
				body: input.body as string,
				in_reply_to: input.in_reply_to as string | null,
				thread_id: input.thread_id as string,
			};
			writes++;
			activities++;
			return { status: "saved", draftId: stored.id, draftVersion: 1 };
		},
	};
	const env = {
		MAILBOX: {
			idFromName: () => "mailbox-id",
			get: () => stub,
		},
	} as never;
	return {
		env,
		get stored() { return stored; },
		get writes() { return writes; },
		get activities() { return activities; },
		get sourceReads() { return sourceReads; },
		get draftReads() { return draftReads; },
		advance() {
			if (!stored) throw new Error("Draft has not been created");
			stored.draft_version = 2;
		},
		terminate(state: "discarded" | "consumed") {
			if (!stored) throw new Error("Draft has not been created");
			terminalState = state;
		},
	};
}

test("concurrent Agent compose retries create one authoritative Draft", async () => {
	const current = fixture();
	const invoke = () => toolDraftEmail(
		current.env,
		"Team@Example.com",
		{ to: "person@example.com", subject: "Hello", body: "Plain body", isPlainText: true },
		{ kind: "agent", id: "user-1" },
		{
			surface: "agent",
			toolName: "draft_email",
			requestId: "request-1",
			toolCallId: "call-1",
		},
	);
	const results = await Promise.all([invoke(), invoke()]);
	assert.ok(results.every((result) => !("error" in result)));
	const successes = results.filter((result) => !("error" in result));
	assert.equal(new Set(successes.map((result) => result.draftId)).size, 1);
	assert.deepEqual(successes.map((result) => result.replayed).sort(), [false, true]);
	assert.equal(successes[0]!.threadId, current.stored!.thread_id);
	assert.equal(successes[1]!.threadId, current.stored!.thread_id);
	assert.equal(current.writes, 1);
	assert.equal(current.activities, 1);
	assert.equal(current.draftReads, 0);
});

test("exact MCP reply replay preserves thread, quote, and skips source reread", async () => {
	const current = fixture();
	const invoke = () => toolDraftReply(
		current.env,
		"team@example.com",
		{
			originalEmailId: "message-1",
			to: "customer@example.com",
			subject: "Re: Question",
			body: "<p>Answer</p>",
			runVerifyDraft: true,
		},
		{ kind: "mcp", id: "user-1" },
		{
			surface: "mcp",
			toolName: "draft_reply",
			sessionId: "session-1",
			requestId: 7,
		},
	);
	const first = await invoke();
	const second = await invoke();
	assert.ok(!("error" in first));
	assert.ok(!("error" in second));
	assert.equal(second.draftId, first.draftId);
	assert.equal(second.replayed, true);
	assert.equal(current.sourceReads, 1);
	assert.equal(current.stored!.in_reply_to, "message-1");
	assert.equal(current.stored!.thread_id, "thread-1");
	assert.match(current.stored!.body, /<p>Answer<\/p>/);
	assert.match(current.stored!.body, /Original question/);
	assert.equal(current.writes, 1);
	assert.equal(current.activities, 1);
});

test("a terminal Draft operation closes retry instead of recreating it", async () => {
	const current = fixture();
	const invocation = {
		surface: "agent" as const,
		toolName: "draft_email" as const,
		requestId: "request-terminal",
		toolCallId: "call-terminal",
	};
	const first = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Original", body: "Body" },
		{ kind: "agent", id: "user-1" },
		invocation,
	);
	assert.ok(!("error" in first));
	current.terminate("discarded");
	const delayed = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Original", body: "Body" },
		{ kind: "agent", id: "user-1" },
		invocation,
	);
	assert.deepEqual(delayed, {
		error: "The original Draft is no longer available for replay.",
		code: "draft_create_replay_unavailable",
		draftId: first.draftId,
		currentVersion: 1,
	});
	assert.equal(current.writes, 1);
	assert.equal(current.activities, 1);
});

test("one invocation reused for changed content conflicts without another write", async () => {
	const current = fixture();
	const invocation = {
		surface: "mcp" as const,
		toolName: "create_draft" as const,
		sessionId: "session-1",
		requestId: "request-1",
	};
	const first = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Original", body: "Body" },
		{ kind: "mcp", id: "user-1" },
		invocation,
	);
	assert.ok(!("error" in first));
	const conflict = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Changed", body: "Body" },
		{ kind: "mcp", id: "user-1" },
		invocation,
	);
	assert.deepEqual(conflict, {
		error: "This Draft invocation was already used for different content.",
		code: "draft_create_conflict",
		draftId: first.draftId,
		currentVersion: 1,
	});
	assert.equal(current.writes, 1);
	assert.equal(current.activities, 1);
});

test("a delayed create retry cannot claim a later Draft revision", async () => {
	const current = fixture();
	const invocation = {
		surface: "agent" as const,
		toolName: "draft_email" as const,
		requestId: "request-1",
		toolCallId: "call-1",
	};
	const first = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Original", body: "Body" },
		{ kind: "agent", id: "user-1" },
		invocation,
	);
	assert.ok(!("error" in first));
	current.advance();
	const superseded = await toolDraftEmail(
		current.env,
		"team@example.com",
		{ to: "person@example.com", subject: "Original", body: "Body" },
		{ kind: "agent", id: "user-1" },
		invocation,
	);
	assert.deepEqual(superseded, {
		error: "The original Draft was changed after this invocation created it.",
		code: "draft_create_superseded",
		draftId: first.draftId,
		currentVersion: 2,
	});
	assert.equal(current.writes, 1);
	assert.equal(current.activities, 1);
});
