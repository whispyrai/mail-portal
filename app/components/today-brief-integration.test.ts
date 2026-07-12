import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) =>
	readFileSync(new URL(path, import.meta.url), "utf8");

const card = read("./TodayBriefCard.tsx");
const workspace = read("./TodayWorkspace.tsx");
const route = read("../routes/today.tsx");
const query = read("../queries/today-brief.ts");

test("Today brief is a calm, cited, read-only AI guidance surface", () => {
	assert.match(card, /AI focus brief/);
	assert.match(card, /Human review required/);
	assert.match(card, /Why now/);
	assert.match(card, /Suggested next step/);
	assert.match(card, /Source \{index \+ 1\}/);
	assert.match(card, /onOpenSource\(messageId\)/);
	assert.match(card, /unread.*in this mailbox/i);
	assert.match(read("../services/today-brief.ts"), /"unread_in_mailbox"/);
	assert.doesNotMatch(card, /dangerouslySetInnerHTML/);
	assert.doesNotMatch(card, /useMutation|onSend|onArchive|onAssign|onSchedule/);
});

test("Today brief exposes loading, generated, cached, no-attention, stale, budget, and error states", () => {
	assert.match(card, /role="status"/);
	assert.match(card, /role="alert"/);
	assert.match(card, /state === "generated"/);
	assert.match(card, /state === "cached"/);
	assert.match(card, /state === "no_attention"/);
	assert.match(card, /state === "stale"/);
	assert.match(card, /state === "budget_paused"/);
	assert.match(card, /state === "preparing"/);
	assert.match(card, /Try again/);
	assert.match(card, /Reminders below remain fully available/);
});

test("Today loads the mailbox brief only after reminders and keeps deterministic work authoritative", () => {
	assert.match(route, /useTodayBrief\(mailboxId, timeZone, reminders\.isSuccess\)/);
	assert.match(query, /\["today-brief", mailboxId, timeZone\]/);
	assert.match(query, /fetchTodayBrief\(mailboxId!, \{ timeZone \}, fetch, signal\)/);
	assert.match(route, /invalidateTodayBrief\(queryClient, mailboxId\)/);
	assert.match(route, /briefIsRefreshing = todayBrief\.isFetching && todayBrief\.isStale/);
	assert.match(route, /brief=\{briefIsRefreshing \? undefined : todayBrief\.data\}/);
	assert.match(workspace, /<TodayBriefCard/);
	assert.match(workspace, /<ReminderSection/);
	assert.match(workspace, /No personal follow-ups are due right now/);
});
