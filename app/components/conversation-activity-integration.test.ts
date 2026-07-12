import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const activity = read("./ConversationActivity.tsx");
const panel = read("./EmailPanel.tsx");
const query = read("../queries/conversation-activity.ts");
const service = read("../services/conversation-activity.ts");
const controller = read("../lib/conversation-activity-controller.ts");

test("Conversation Activity is collapsed by default and fetches only after expand", () => {
	assert.match(activity, /useState\(false\)/);
	assert.match(activity, /useConversationActivity\(mailboxId, emailId, expanded\)/);
	assert.match(activity, /aria-expanded=\{expanded\}/);
	assert.match(query, /enabled: enabled && Boolean\(mailboxId && emailId\)/);
});

test("EmailPanel gates Activity on authoritative accessible-mailbox type", () => {
	assert.match(
		panel,
		/<ConversationIntelligenceCard[\s\S]*?<ConversationActivity[\s\S]*?key=\{`\$\{mailboxId\}:\$\{email\.id\}`\}/,
	);
	assert.match(panel, /useMailboxes\(\)/);
	assert.match(panel, /activityMailboxType === "PERSONAL" \|\| activityMailboxType === "SHARED"/);
	assert.match(panel, /isSharedMailbox=\{activityMailboxType === "SHARED"\}/);
	assert.doesNotMatch(panel, /isSharedMailbox=\{currentMailbox\?\.type === "SHARED"\}/);
});

test("Activity exposes compact accessible shared, loading, empty, recovery, and pagination states", () => {
	assert.match(activity, /Actions here affect this mailbox and identify who performed them\./);
	assert.match(activity, /Loading activity…/);
	assert.match(activity, /No activity has been recorded for this conversation\./);
	assert.match(activity, /Activity could not be loaded\./);
	assert.match(activity, /Mailbox access changed\./);
	assert.match(activity, /Conversation is no longer available\./);
	assert.match(activity, /Load earlier/);
	assert.match(activity, /Retry earlier activity/);
	assert.match(activity, /paginationError = activity\.isFetchNextPageError/);
	assert.match(activity, /min-h-11/);
	assert.match(activity, /break-words/);
	assert.match(activity, /aria-live="polite"/);
	assert.match(activity, /role="alert"/);
});

test("Activity remains read-only and renders only the shared fixed labels", () => {
	assert.match(activity, /CONVERSATION_ACTIVITY_LABELS\[item\.code\]/);
	for (const source of [activity, query, service, controller]) {
		assert.doesNotMatch(
			source,
			/useMutation|\.mutate|batchTriage|updateEmail|moveEmail|deleteEmail|recordActivity/,
		);
	}
});
