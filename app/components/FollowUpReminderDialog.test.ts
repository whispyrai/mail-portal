import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
	new URL("./FollowUpReminderDialog.tsx", import.meta.url),
	"utf8",
);

test("follow-up dialog makes privacy, local time, recovery, and exact actions clear", () => {
	assert.match(source, /Only you can see this reminder, including in a shared mailbox/);
	assert.match(source, /A new reply completes it automatically/);
	assert.match(source, /type="datetime-local"/);
	assert.match(source, /Later today/);
	assert.match(source, /Tomorrow morning/);
	assert.match(source, /Next Monday/);
	assert.match(source, /Set reminder/);
	assert.match(source, /Reschedule reminder/);
	assert.match(source, /Mark complete/);
	assert.match(source, /Remove reminder/);
	assert.match(source, /When should this follow-up appear\?/);
	assert.match(source, /Keep current reminder/);
	assert.match(source, /initializedContext\.current === context/);
	assert.doesNotMatch(source, /follow-up will return/);
	assert.match(source, /role="alert"/);
	assert.match(source, /role="status"/);
	assert.match(source, /if \(!pending\) onOpenChange\(next\)/);
	assert.match(source, /min-h-11/);
	assert.match(source, /max-h-\[calc\(100dvh-1rem\)\]/);
});

test("follow-up retries reuse operation identity for the same payload", () => {
	assert.match(source, /requestIds\.current\.get\(identity\)/);
	assert.match(source, /create:\$\{emailId\}:\$\{remindAt\}/);
	assert.match(source, /snooze:\$\{reminder\.version\}:\$\{remindAt\}/);
	assert.match(source, /\$\{action\}:\$\{reminder\.version\}/);
});
