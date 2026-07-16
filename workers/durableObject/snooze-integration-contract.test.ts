import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	classMethodText,
	parseTypescriptSource,
} from "../testing/typescript-source.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("Snooze reply wake is authoritative, bounded, durable, and alarm-safe", () => {
	assert.match(source, /email\.snooze_wake_thread_id/);
	assert.match(source, /resolveCanonicalThreadId/);
	assert.doesNotMatch(source, /findThreadBySubject/);
	assert.match(source, /INSERT INTO snooze_reply_wake_queue/);
	assert.match(source, /LIMIT 100/);
	assert.match(source, /#processReplyWakeBatch\(\)/);
	assert.match(source, /#processDueSnoozeBatch\(alarmNow\)/);
	assert.match(source, /failed to schedule Snooze reply wake alarm/);
	assert.match(source, /failed to re-arm Snooze during read self-heal/);
	assert.match(source, /finalizeCommittedSnooze/);
});

test("generic lifecycle resolves aliases before enforcing Snooze protection", () => {
	assert.match(source, /folder\.id === Folders\.SNOOZED/);
	assert.match(source, /scope\.folderId === Folders\.SNOOZED/);
	assert.match(source, /isNotNull\(schema\.emails\.snoozed_until\)/);
	assert.match(source, /isNotNull\(schema\.emails\.snooze_source_folder_id\)/);

	const readStart = source.indexOf("async setConversationRead(");
	const readEnd = source.indexOf("async archiveConversation(", readStart);
	const readBody = source.slice(readStart, readEnd);
	const moveBody = classMethodText(
		parseTypescriptSource(source, "index.ts"),
		"moveConversationInFolder",
	);

	assert.doesNotMatch(readBody, /snoozed_state_requires_unsnooze/);
	assert.match(moveBody, /scope\.folderId === Folders\.SNOOZED/);
	assert.match(moveBody, /isNotNull\(schema\.emails\.snoozed_until\)/);
	assert.match(moveBody, /isNotNull\(schema\.emails\.snooze_source_folder_id\)/);
	assert.ok(
		moveBody.indexOf("snoozedMember") < moveBody.indexOf("outboundDeliveries"),
		"Snooze protection must run before archive/trash lifecycle checks",
	);
});

test("oversized conversation scope is rejected before constructing a SQL IN list", () => {
	const guard = source.indexOf("conversation.emailIds.length > 100");
	const query = source.indexOf(".where(inArray(schema.emails.id, emailIds))", guard);
	assert.notEqual(guard, -1);
	assert.ok(query > guard);
});
