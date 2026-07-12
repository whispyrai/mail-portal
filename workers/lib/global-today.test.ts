import assert from "node:assert/strict";
import test from "node:test";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import { GLOBAL_TODAY_LIMITS } from "../../shared/global-today.ts";
import type { MailboxRow } from "../db/users-schema.ts";
import { buildGlobalToday, type GlobalTodayDependencies } from "./global-today.ts";

const day = {
	timeZone: "Africa/Cairo",
	localDate: "2026-07-12",
	startAt: "2026-07-11T21:00:00.000Z",
	endAt: "2026-07-12T21:00:00.000Z",
};

function mailbox(address: string, type: "PERSONAL" | "SHARED" = "SHARED"): MailboxRow {
	return { id: address, address, type, owner_user_id: type === "PERSONAL" ? "user-a" : null, is_active: 1, created_at: 1, updated_at: 1 };
}

function reminder(mailboxAddress: string, id: string, remindAt = "2026-07-12T10:00:00.000Z"): FollowUpReminder {
	return {
		id,
		ownerUserId: "user-a",
		mailboxAddress,
		conversationKey: `conversation-${id}`,
		baselineMessageId: `message-${id}`,
		baselineMessageDate: "2026-07-11T10:00:00.000Z",
		remindAt,
		state: "active",
		resolutionReason: null,
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		resolvedAt: null,
	};
}

function dependencies(input: {
	rosters?: MailboxRow[][];
	reminders?: FollowUpReminder[];
	fail?: Set<string>;
	revoked?: Set<string>;
} = {}): GlobalTodayDependencies {
	let rosterRead = 0;
	const rosters = input.rosters ?? [[mailbox("me@example.com", "PERSONAL"), mailbox("team@example.com")]];
	return {
		listAccessibleMailboxes: async () => rosters[Math.min(rosterRead++, rosters.length - 1)]!,
		canAccessMailbox: async (_actor, mailboxId) => !input.revoked?.has(mailboxId),
		listReminderPage: async ({ mailboxId, cursor }) => ({
			reminders: cursor ? [] : (input.reminders ?? []).filter((row) => row.mailboxAddress === mailboxId),
			nextCursor: null,
		}),
		readMailbox: async ({ mailboxId, baselineMessageIds }) => {
			if (input.fail?.has(mailboxId)) throw new Error("private infrastructure detail");
			return {
				unreadConversationCount: mailboxId.startsWith("team") ? 2 : 1,
				unreadPreviews: [{ messageId: "same-local-id", conversationKey: "same-local-conversation", sender: "sender@example.com", subject: mailboxId, date: "2026-07-12T12:00:00.000Z" }],
				reminderPreviews: baselineMessageIds.map((id) => ({ baselineMessageId: id, subject: id, counterparty: "person@example.com" })),
			};
		},
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
	};
}

test("global Today orders Personal first, preserves compound collisions, and computes complete totals", async () => {
	const rows = [
		reminder("team@example.com", "later", "2026-07-12T11:00:00.000Z"),
		reminder("me@example.com", "first", "2026-07-12T09:00:00.000Z"),
	];
	const result = await buildGlobalToday(dependencies({
		rosters: [[mailbox("team@example.com"), mailbox("me@example.com", "PERSONAL")]],
		reminders: rows,
	}), { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(result.mailboxes.map((row) => row.mailboxId), ["me@example.com", "team@example.com"]);
	assert.equal(result.mailboxes[0]?.unreadPreviews[0]?.messageId, "same-local-id");
	assert.equal(result.mailboxes[1]?.unreadPreviews[0]?.messageId, "same-local-id");
	assert.deepEqual(result.totals, { privateRemindersDue: 2, unreadConversations: 3 });
});

test("global Today keeps authorized successes, suppresses partial totals, and redacts failures", async () => {
	const result = await buildGlobalToday(dependencies({ fail: new Set(["team@example.com"]) }), { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.equal(result.complete, false);
	assert.equal(result.totals, null);
	assert.deepEqual(result.failures, [{ mailboxId: "team@example.com", address: "team@example.com", type: "SHARED", reason: "unavailable" }]);
	assert.equal(JSON.stringify(result).includes("private infrastructure detail"), false);
});

test("global Today classifies timed-out Mailboxes and ignores their late content", async () => {
	const deps = dependencies({ rosters: [[mailbox("slow@example.com")]] });
	deps.mailboxTimeoutMs = 5;
	let finished = false;
	deps.readMailbox = async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
		finished = true;
		return {
			unreadConversationCount: 99,
			unreadPreviews: [],
			reminderPreviews: [],
		};
	};
	const result = await buildGlobalToday(deps, { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(result.mailboxes, []);
	assert.deepEqual(result.failures, [{
		mailboxId: "slow@example.com",
		address: "slow@example.com",
		type: "SHARED",
		reason: "timeout",
	}]);
	assert.equal(result.totals, null);
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(finished, true);
	assert.deepEqual(result.mailboxes, []);
});

test("timed-out Mailbox reads never replenish beyond the live connection budget", async () => {
	const roster = Array.from({ length: 8 }, (_, index) => mailbox(`${index}@example.com`));
	const deps = dependencies({ rosters: [roster] });
	deps.mailboxTimeoutMs = 5;
	let active = 0;
	let maximum = 0;
	deps.readMailbox = async () => {
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 25));
		active -= 1;
		return { unreadConversationCount: 0, unreadPreviews: [], reminderPreviews: [] };
	};
	const result = await buildGlobalToday(deps, { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	assert.ok(maximum <= GLOBAL_TODAY_LIMITS.concurrency);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(active, 0);
});

test("roster retries share the same live connection budget as timed-out reads", async () => {
	const firstRoster = Array.from({ length: 4 }, (_, index) => mailbox(`old-${index}@example.com`));
	const secondRoster = Array.from({ length: 4 }, (_, index) => mailbox(`new-${index}@example.com`));
	const deps = dependencies({ rosters: [firstRoster, secondRoster, secondRoster, secondRoster] });
	deps.mailboxTimeoutMs = 5;
	let active = 0;
	let maximum = 0;
	deps.readMailbox = async () => {
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 25));
		active -= 1;
		return { unreadConversationCount: 0, unreadPreviews: [], reminderPreviews: [] };
	};
	const result = await buildGlobalToday(deps, { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state === "ready") assert.equal(result.accessChanged, true);
	assert.ok(maximum <= GLOBAL_TODAY_LIMITS.concurrency);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(active, 0);
});

test("global Today discards in-flight revoked content and failures before response", async () => {
	const result = await buildGlobalToday(dependencies({ revoked: new Set(["team@example.com"]) }), { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.equal(result.accessChanged, true);
	assert.deepEqual(result.mailboxes.map((row) => row.mailboxId), ["me@example.com"]);
	assert.deepEqual(result.failures, []);
	assert.equal(result.totals, null);
});

test("global Today reports explicit Mailbox and reminder capacity instead of truncating", async () => {
	const tooManyMailboxes = Array.from({ length: GLOBAL_TODAY_LIMITS.mailboxes + 1 }, (_, index) => mailbox(`team-${index}@example.com`));
	assert.deepEqual(
		await buildGlobalToday(dependencies({ rosters: [tooManyMailboxes] }), { actorUserId: "user-a", day }),
		{ state: "capacity_exceeded", resource: "mailboxes", limit: GLOBAL_TODAY_LIMITS.mailboxes, actual: GLOBAL_TODAY_LIMITS.mailboxes + 1 },
	);
	const tooManyReminders = Array.from({ length: GLOBAL_TODAY_LIMITS.reminders + 1 }, (_, index) => reminder("me@example.com", `r-${index}`));
	const reminderResult = await buildGlobalToday(dependencies({ rosters: [[mailbox("me@example.com", "PERSONAL")]], reminders: tooManyReminders }), { actorUserId: "user-a", day });
	assert.deepEqual(reminderResult, { state: "capacity_exceeded", resource: "reminders", limit: GLOBAL_TODAY_LIMITS.reminders, actual: GLOBAL_TODAY_LIMITS.reminders + 1 });
});

test("capacity responses retry a changed roster before disclosing counts", async () => {
	const tooMany = Array.from({ length: GLOBAL_TODAY_LIMITS.mailboxes + 1 }, (_, index) => mailbox(`old-${index}@example.com`));
	const stable = [mailbox("current@example.com", "PERSONAL")];
	const result = await buildGlobalToday(dependencies({ rosters: [tooMany, stable, stable, stable] }), { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(result.mailboxes.map((row) => row.mailboxId), ["current@example.com"]);
	assert.equal(result.currentMailboxCount, 1);
});

test("global Today retries one roster change and never exceeds four concurrent Mailbox reads", async () => {
	const first = [mailbox("a@example.com", "PERSONAL")];
	const stable = Array.from({ length: 8 }, (_, index) => mailbox(`${index}@example.com`));
	let rosterRead = 0;
	let active = 0;
	let maximum = 0;
	const deps = dependencies({ rosters: [first] });
	deps.listAccessibleMailboxes = async () => rosterRead++ === 0 ? first : stable;
	deps.readMailbox = async () => {
		active += 1;
		maximum = Math.max(maximum, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active -= 1;
		return { unreadConversationCount: 0, unreadPreviews: [], reminderPreviews: [] };
	};
	const result = await buildGlobalToday(deps, { actorUserId: "user-a", day });
	assert.equal(result.state, "ready");
	assert.ok(maximum <= GLOBAL_TODAY_LIMITS.concurrency);
});
