import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync(new URL("./EmailPanel.tsx", import.meta.url), "utf8");

test("message detail mounts private reminders only for eligible stored mail", () => {
	assert.match(panel, /useFollowUpReminders\(mailboxId\)/);
	assert.match(panel, /email\.thread_id\?\.trim\(\) \|\| email\.id/);
	assert.match(panel, /reminder\.conversationKey === reminderConversationKey/);
	for (const folder of ["INBOX", "SENT", "ARCHIVE", "SNOOZED"]) {
		assert.match(panel, new RegExp(`Folders\\.${folder}`));
	}
	assert.match(panel, /<FollowUpReminderControl/);
	assert.match(panel, /reminder=\{activeFollowUpReminder\}/);
});
