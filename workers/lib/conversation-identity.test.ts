import assert from "node:assert/strict";
import test from "node:test";
import {
	CONVERSATION_ID_SQL,
	resolveConversationIdentity,
} from "./conversation-identity.ts";

test("blank legacy subjects remain separate without an RFC thread identity", () => {
	assert.equal(
		resolveConversationIdentity({
			rawThreadId: "blank-1",
			threadId: null,
			normalizedSubject: "",
			minimumRawThreadIdForSubject: "blank-1",
		}),
		"blank-1",
	);
	assert.equal(
		resolveConversationIdentity({
			rawThreadId: "blank-2",
			threadId: null,
			normalizedSubject: "",
			minimumRawThreadIdForSubject: "blank-1",
		}),
		"blank-2",
	);
});

test("legacy messages remain separate even when normalized subjects match", () => {
	assert.equal(
		resolveConversationIdentity({
			rawThreadId: "legacy-2",
			threadId: null,
			normalizedSubject: "quarterly update",
			minimumRawThreadIdForSubject: "legacy-1",
		}),
		"legacy-2",
	);

	// An authoritative thread ID still groups messages that explicitly carry it.
	assert.equal(
		resolveConversationIdentity({
			rawThreadId: "rfc-thread",
			threadId: "rfc-thread",
			normalizedSubject: "",
			minimumRawThreadIdForSubject: "other",
		}),
		"rfc-thread",
	);
});

test("the shared SQL policy never groups legacy messages by subject", () => {
	assert.doesNotMatch(CONVERSATION_ID_SQL, /normalized_subject/);
	assert.doesNotMatch(CONVERSATION_ID_SQL, /MIN\(raw_thread_id\)/);
	assert.match(CONVERSATION_ID_SQL, /ELSE raw_thread_id/);
});
