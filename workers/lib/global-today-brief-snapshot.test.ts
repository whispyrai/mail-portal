import assert from "node:assert/strict";
import test from "node:test";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
	globalTodayBriefFreshnessMatches,
	readGlobalTodayBriefSnapshot,
	type GlobalTodayBriefRosterMailbox,
	type GlobalTodayBriefSnapshotDependencies,
} from "./global-today-brief-snapshot.ts";

const day = {
	timeZone: "Africa/Cairo",
	localDate: "2026-07-12",
	startAt: "2026-07-11T21:00:00.000Z",
	endAt: "2026-07-12T21:00:00.000Z",
};

function mailbox(address: string, type: "PERSONAL" | "SHARED" = "SHARED"): GlobalTodayBriefRosterMailbox {
	return { mailboxId: address, address, type };
}

function reminder(mailboxAddress: string, id = `reminder-${mailboxAddress}`): FollowUpReminder {
	return {
		id,
		ownerUserId: "actor-a",
		mailboxAddress,
		conversationKey: `conversation-${id}`,
		baselineMessageId: `message-${id}`,
		baselineMessageDate: "2026-07-11T08:00:00.000Z",
		remindAt: "2026-07-12T10:00:00.000Z",
		state: "active",
		resolutionReason: null,
		version: 1,
		createdAt: 1,
		updatedAt: 1,
		resolvedAt: null,
	};
}

function dependencies(input: {
	rosters?: GlobalTodayBriefRosterMailbox[][];
	reminders?: FollowUpReminder[];
	metadataFailure?: string;
	evidenceFailure?: string;
	revoked?: string;
	sequenceOverrides?: Map<string, number>;
} = {}): GlobalTodayBriefSnapshotDependencies {
	let rosterRead = 0;
	const rosters = input.rosters ?? [[mailbox("me@example.com", "PERSONAL"), mailbox("team@example.com")]];
	const sequence = (address: string) => input.sequenceOverrides?.get(address) ?? (address.startsWith("me") ? 3 : 7);
	return {
		model: "cheap-model",
		listRoster: async () => rosters[Math.min(rosterRead++, rosters.length - 1)]!,
		listReminders: async () => ({ reminders: input.reminders ?? [], overflow: false }),
		canAccessMailbox: async (_actor, mailboxId) => mailboxId !== input.revoked,
		readMetadata: async ({ mailbox: row, reminders, boundaries }) => {
			if (row.address === input.metadataFailure) throw new Error("metadata failed");
			assert.equal(boundaries.now, "2026-07-12T12:00:00.000Z");
			const due = reminders[0];
			const conversationKey = due?.conversationKey ?? "same-conversation";
			return {
				sequence: sequence(row.address),
				totalCandidateCount: 1,
				counts: { privateRemindersDue: due ? 1 : 0, unreadConversations: 1 },
				candidates: [{
					conversationKey,
					sourceEmailId: "same-message",
					latestMessageAt: "2026-07-12T11:00:00.000Z",
					subject: "Ordinary subject",
					counterparty: "customer@example.com",
					reasons: due ? ["today_reminder", "unread_in_mailbox"] : ["unread_in_mailbox"],
					reminder: due ? { id: due.id, version: due.version, dueAt: due.remindAt } : null,
					unreadInMailbox: true,
				}],
			};
		},
		readEvidence: async ({ mailbox: row, requests }) => {
			if (row.address === input.evidenceFailure) throw new Error("evidence failed");
			return {
				sequence: sequence(row.address),
				evidence: requests.map(({ conversationKey }) => ({
					conversationKey,
					messages: [{
						id: "same-message",
						date: "2026-07-12T11:00:00.000Z",
						folderId: "inbox",
						sender: "customer@example.com",
						subject: "Ordinary subject",
						text: "Safe bounded evidence",
					}],
				})),
			};
		},
		readSequence: async (row) => sequence(row.address),
		now: () => Date.parse("2026-07-12T12:00:00.000Z"),
	};
}

test("snapshot combines Personal and Shared Mailboxes while preserving compound source authority", async () => {
	const rows = [reminder("team@example.com")];
	const result = await readGlobalTodayBriefSnapshot(dependencies({ reminders: rows }), { actorUserId: "actor-a", day });
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(result.snapshot.counts, { privateRemindersDue: 1, unreadConversations: 2 });
	assert.deepEqual(result.snapshot.freshness.sequences, [
		{ mailboxId: "me@example.com", sequence: 3 },
		{ mailboxId: "team@example.com", sequence: 7 },
	]);
	assert.equal(result.snapshot.prepared.authority.get("candidate-01")?.publicCandidate.mailboxId, "team@example.com");
	assert.equal(result.snapshot.prepared.authority.get("candidate-02")?.publicCandidate.mailboxId, "me@example.com");
	assert.equal(JSON.stringify(result.snapshot.prepared.input).includes("team@example.com"), false);
	assert.match(result.snapshot.fingerprint, /^gtbf:v1:[a-f0-9]{64}$/);
	assert.equal(await globalTodayBriefFreshnessMatches(dependencies({ reminders: rows }), {
		actorUserId: "actor-a",
		day,
		expected: result.snapshot.freshness,
	}), true);
});

test("snapshot fails closed on projection errors, revocation, roster changes, and reminder changes", async () => {
	for (const deps of [
		dependencies({ metadataFailure: "team@example.com" }),
		dependencies({ evidenceFailure: "team@example.com" }),
	]) {
		assert.deepEqual(await readGlobalTodayBriefSnapshot(deps, { actorUserId: "actor-a", day }), { state: "overview_incomplete" });
	}
	for (const deps of [
		dependencies({ revoked: "team@example.com" }),
		dependencies({ rosters: [
			[mailbox("me@example.com", "PERSONAL"), mailbox("team@example.com")],
			[mailbox("me@example.com", "PERSONAL")],
		] }),
	]) {
		assert.deepEqual(await readGlobalTodayBriefSnapshot(deps, { actorUserId: "actor-a", day }), { state: "access_changed" });
	}

	let reminderRead = 0;
	const changed = dependencies({ reminders: [reminder("team@example.com")] });
	changed.listReminders = async () => ({
		reminders: [reminder("team@example.com", reminderRead++ < 1 ? "original" : "changed")],
		overflow: false,
	});
	assert.deepEqual(await readGlobalTodayBriefSnapshot(changed, { actorUserId: "actor-a", day }), { state: "overview_incomplete" });

	const rosterUnavailable = dependencies();
	rosterUnavailable.listRoster = async () => { throw new Error("D1 unavailable"); };
	assert.deepEqual(await readGlobalTodayBriefSnapshot(rosterUnavailable, { actorUserId: "actor-a", day }), { state: "overview_incomplete" });
});

test("snapshot timeout budget never starts more than four unsettled Mailbox reads", async () => {
	const roster = Array.from({ length: 8 }, (_, index) => mailbox(`team-${index}@example.com`));
	const deps = dependencies({ rosters: [roster] });
	let active = 0;
	let maximum = 0;
	deps.timeoutMs = 5;
	deps.readMetadata = async () => {
		active += 1;
		maximum = Math.max(maximum, active);
		return new Promise(() => {});
	};
	assert.deepEqual(await readGlobalTodayBriefSnapshot(deps, { actorUserId: "actor-a", day }), { state: "overview_incomplete" });
	assert.equal(maximum, 4);
});

test("freshness rejects changed Mailbox sequences and access", async () => {
	const first = await readGlobalTodayBriefSnapshot(dependencies(), { actorUserId: "actor-a", day });
	assert.equal(first.state, "ready");
	if (first.state !== "ready") return;
	assert.equal(await globalTodayBriefFreshnessMatches(dependencies({
		sequenceOverrides: new Map([["team@example.com", 8]]),
	}), { actorUserId: "actor-a", day, expected: first.snapshot.freshness }), false);
	assert.equal(await globalTodayBriefFreshnessMatches(dependencies({ revoked: "team@example.com" }), {
		actorUserId: "actor-a",
		day,
		expected: first.snapshot.freshness,
	}), false);
});
