import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workspace = readFileSync(new URL("./GlobalTodayWorkspace.tsx", import.meta.url), "utf8");
const route = readFileSync(new URL("../../routes/global-today.tsx", import.meta.url), "utf8");
const recovery = readFileSync(new URL("../../lib/global-today-recovery.ts", import.meta.url), "utf8");
const query = readFileSync(new URL("../../queries/global-today.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("./GlobalShell.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../routes.ts", import.meta.url), "utf8");
const home = readFileSync(new URL("../../routes/home.tsx", import.meta.url), "utf8");

test("global Today is a first-class destination and preserves Mailbox administration", () => {
	assert.match(routes, /route\("today", "routes\/global-today\.tsx"\)/);
	assert.match(routes, /route\("mailboxes", "routes\/home\.tsx"\)/);
	assert.match(routes, /index\("routes\/global-index\.tsx"\)/);
	assert.match(shell, /Global navigation/);
	assert.match(shell, /Mailboxes/);
	assert.match(home, /New Mailbox/);
	assert.match(home, /Deactivate Mailbox/);
	assert.match(home, /const accounts = mailboxes/);
	assert.doesNotMatch(home, /<Navigate/);
});

test("global Today exposes complete, partial, all-failed, access, offline, capacity, and refreshing truth", () => {
	for (const copy of [
		"Partial totals are hidden",
		"No Mailbox snapshot is current",
		"Mailbox access changed",
		"You are offline",
		"No Mailboxes are available yet",
		"nothing was silently omitted",
		"Refreshing…",
	]) assert.match(workspace, new RegExp(copy));
	assert.match(workspace, /response\.totals/);
	assert.match(workspace, /response\.failures/);
	assert.match(workspace, /Today could not refresh/);
	assert.match(workspace, /animate-pulse/);
	assert.match(workspace, /Nothing needs attention right now/);
	assert.match(route, /useOnlineState|today\.refetch/);
	assert.match(query, /refetchOnReconnect: true/);
});

test("global Today keeps identities compound, reminder actions row-local, and mail state read-only", () => {
	assert.match(workspace, /`\$\{reminder\.mailboxAddress\}:\$\{reminder\.id\}`/);
	assert.match(workspace, /`\$\{snapshot\.mailboxId\}:\$\{preview\.messageId\}`/);
	assert.match(route, /new Set\(current\)\.add\(key\)/);
	assert.match(recovery, /evictRevokedMailbox\(queryClient, mailboxId\)/);
	assert.match(recovery, /FollowUpReminderApiError/);
	assert.match(recovery, /STATE_CONFLICT|IDEMPOTENCY_CONFLICT/);
	assert.match(route, /purgeRemovedGlobalTodayMailboxes/);
	assert.doesNotMatch(route, /response\.accessChanged && priorAuthorizedMailboxIds/);
	assert.match(route, /authorizationError \? undefined : today\.data/);
	assert.match(workspace, /Read state is shared by the Mailbox/);
	assert.doesNotMatch(workspace, /markRead|markUnread|archiveConversation|moveEmail|mutateLabels|toggleStar|replyEmail|sendEmail/);
	assert.doesNotMatch(route, /today-brief|runModel|provider|useTodayBrief/i);
});

test("global Today adapts to mobile without horizontal dependence and stays keyboard reachable", () => {
	assert.match(shell, /md:hidden/);
	assert.match(shell, /md:flex/);
	assert.match(shell, /h-dvh/);
	assert.doesNotMatch(shell, /\{appName\} Mail/);
	assert.match(workspace, /sm:grid-cols/);
	assert.match(workspace, /min-h-11/);
	assert.doesNotMatch(workspace, /<main/);
	assert.doesNotMatch(workspace, /overflow-x-auto|whitespace-nowrap/);
});
