import assert from "node:assert/strict";
import test from "node:test";
import {
	appendConversationActivityItems,
	conversationActivityContextKey,
	flattenConversationActivityPages,
} from "./conversation-activity-controller.ts";
import type { ConversationActivityItem } from "../services/conversation-activity.ts";

function item(id: string): ConversationActivityItem {
	return {
		id,
		code: "archived",
		label: "Archived",
		actor: { kind: "person", label: "person@example.com" },
		occurredAt: `2026-07-12T08:30:0${id.at(-1) ?? "0"}.000Z`,
	};
}

test("activity context identity changes for mailbox or selected message", () => {
	assert.equal(
		conversationActivityContextKey("team@example.com", "message-1"),
		"team%40example.com:message-1",
	);
	assert.notEqual(
		conversationActivityContextKey("team@example.com", "message-1"),
		conversationActivityContextKey("team@example.com", "message-2"),
	);
	assert.notEqual(
		conversationActivityContextKey("team@example.com", "message-1"),
		conversationActivityContextKey("other@example.com", "message-1"),
	);
});

test("older pages append in server order and discard duplicate event IDs", () => {
	const first = [item("event-3"), item("event-2")];
	const appended = appendConversationActivityItems(first, [
		item("event-2"),
		item("event-1"),
		item("event-1"),
	]);
	assert.deepEqual(appended.map(({ id }) => id), [
		"event-3",
		"event-2",
		"event-1",
	]);
	assert.deepEqual(first.map(({ id }) => id), ["event-3", "event-2"]);
});

test("page flattening keeps the first authoritative event projection", () => {
	const original = item("event-2");
	const conflicting = {
		...original,
		label: "Conflicting replay",
	};
	const result = flattenConversationActivityPages([
		{ items: [item("event-3"), original], nextCursor: "older_1" },
		{ items: [conflicting, item("event-1")], nextCursor: null },
	]);
	assert.deepEqual(result.map(({ id }) => id), [
		"event-3",
		"event-2",
		"event-1",
	]);
	assert.equal(result[1]?.label, "Archived");
});
