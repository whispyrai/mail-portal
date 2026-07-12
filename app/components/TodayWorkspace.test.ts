import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const workspace = read("./TodayWorkspace.tsx");
const route = read("../routes/today.tsx");
const routes = read("../routes.ts");
const sidebar = read("./Sidebar.tsx");

test("Today is a private daily workspace with complete reminder controls", () => {
	assert.match(workspace, /Private to you/);
	assert.match(workspace, /never assign work to teammates/);
	assert.match(workspace, /reminder\.preview\?\.subject/);
	assert.match(workspace, /reminder\.preview\?\.counterparty/);
	assert.match(workspace, /Conversation unavailable/);
	assert.match(workspace, /reminderAccessibleContext/);
	assert.match(workspace, /aria-label=\{`Open \$\{actionContext\}`\}/);
	assert.match(workspace, /title="Overdue"/);
	assert.match(workspace, /title="Today"/);
	assert.match(workspace, /title="Upcoming"/);
	assert.match(workspace, /"Updating…" : "Complete"/);
	assert.match(workspace, />\s*Remind later\s*</);
	assert.match(workspace, /Reschedule reminder/);
	assert.doesNotMatch(workspace, />\s*Snooze\s*</);
	assert.match(workspace, />\s*Dismiss\s*</);
	assert.match(workspace, /onOpenConversation/);
});

test("Today has accessible loading, failure, empty, and responsive states", () => {
	assert.match(workspace, /role="status"/);
	assert.match(workspace, /role="alert"/);
	assert.match(workspace, /Your desk is clear/);
	assert.match(workspace, /aria-live="polite"/);
	assert.match(workspace, /mutationFeedback\.kind === "error" \? "alert" : "status"/);
	assert.match(workspace, /mutationsDisabled=\{isMutating\}/);
	assert.match(workspace, /sm:grid-cols/);
	assert.match(workspace, /min-h-11/);
});

test("Today is routed inside a mailbox and linked from the primary sidebar", () => {
	assert.match(routes, /route\("today", "routes\/today\.tsx"\)/);
	assert.match(sidebar, /CalendarCheckIcon/);
	assert.match(sidebar, /label="Today"/);
	assert.match(route, /useFollowUpReminders\(mailboxId\)/);
	assert.match(route, /useFollowUpReminderOperation/);
	assert.match(route, /operationIds = useRef\(new Map<string, string>\(\)\)/);
	assert.match(route, /stableReminderOperationId/);
	assert.match(route, /pendingByMailbox\.current\.has\(mailboxId\)/);
	assert.match(route, /operation\.mutateAsync\(variables\)/);
	assert.match(route, /feedbackByMailbox\.current\.set/);
	assert.match(route, /operationIds\.current\.delete\(identity\)/);
	assert.match(route, /kind: "pending"/);
	assert.match(route, /kind: "error"/);
	assert.match(route, /kind: "success"/);
	assert.match(route, /Retry the same action to continue safely/);
	assert.match(route, /selectEmail\(reminder\.baselineMessageId\)/);
	assert.match(route, /<MailboxSplitView/);
});
