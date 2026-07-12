import assert from "node:assert/strict";
import test from "node:test";
import type { GlobalTodayBriefMailboxEvidence, GlobalTodayBriefMailboxMetadata } from "./today-brief-candidates.ts";
import {
	prepareGlobalTodayBriefCandidates,
	selectGlobalTodayBriefCandidates,
	type GlobalTodayBriefMailboxCandidateSource,
} from "./global-today-brief-candidates.ts";
import { buildTodayBriefModelMessages } from "./today-brief.ts";

function candidate(conversationKey: string, latestMessageAt: string, options: { reminder?: "overdue" | "today"; unread?: boolean } = {}) {
	const reminder = options.reminder ? {
		id: `reminder-${conversationKey}`,
		version: 1,
		dueAt: options.reminder === "overdue" ? "2026-07-12T07:00:00.000Z" : "2026-07-12T15:00:00.000Z",
	} : null;
	return {
		conversationKey,
		sourceEmailId: "same-local-message",
		latestMessageAt,
		subject: "Ordinary subject",
		counterparty: "client@example.com",
		reasons: [
			...(options.reminder ? [options.reminder === "overdue" ? "overdue_reminder" as const : "today_reminder" as const] : []),
			...(options.unread ? ["unread_in_mailbox" as const] : []),
		],
		reminder,
		unreadInMailbox: Boolean(options.unread),
	};
}

function mailbox(address: string, candidates: ReturnType<typeof candidate>[], totalCandidateCount = candidates.length): GlobalTodayBriefMailboxCandidateSource {
	const metadata: GlobalTodayBriefMailboxMetadata = {
		sequence: 4,
		totalCandidateCount,
		counts: {
			privateRemindersDue: candidates.filter((item) => item.reminder).length,
			unreadConversations: candidates.filter((item) => item.unreadInMailbox).length,
		},
		candidates,
	};
	return { mailboxId: address, address, type: address.startsWith("me@") ? "PERSONAL" : "SHARED", metadata };
}

function evidence(conversationKeys: string[]): GlobalTodayBriefMailboxEvidence {
	return {
		sequence: 4,
		evidence: conversationKeys.map((conversationKey) => ({
			conversationKey,
			messages: [{
				id: "same-local-message",
				date: "2026-07-12T12:00:00.000Z",
				folderId: "inbox",
				sender: "client@example.com",
				subject: "Ordinary subject",
				text: "Ordinary evidence",
			}],
		})),
	};
}

test("aggregate selection puts reminders first and fills unread work in Mailbox fairness rounds", () => {
	const sources = [
		mailbox("a@example.com", [
			candidate("a-reminder", "2026-07-12T09:00:00.000Z", { reminder: "overdue", unread: true }),
			candidate("a-newest", "2026-07-12T12:00:00.000Z", { unread: true }),
			candidate("a-second", "2026-07-12T08:00:00.000Z", { unread: true }),
		]),
		mailbox("b@example.com", [
			candidate("b-newest", "2026-07-12T11:00:00.000Z", { unread: true }),
			candidate("b-second", "2026-07-12T10:00:00.000Z", { unread: true }),
		]),
	];
	assert.deepEqual(
		selectGlobalTodayBriefCandidates(sources).map((item) => item.candidate.conversationKey),
		["a-reminder", "a-newest", "b-newest", "b-second", "a-second"],
	);
});

test("aggregate preparation replaces colliding real identities with opaque model IDs", () => {
	const sources = [
		mailbox("me@example.com", [candidate("same-conversation", "2026-07-12T12:00:00.000Z", { unread: true })], 2),
		mailbox("team@example.com", [candidate("same-conversation", "2026-07-12T11:00:00.000Z", { reminder: "today", unread: true })], 3),
	];
	const prepared = prepareGlobalTodayBriefCandidates({
		localDate: "2026-07-12",
		timezone: "Africa/Cairo",
		mailboxes: sources,
		evidenceByMailbox: new Map([
			["me@example.com", evidence(["same-conversation"])],
			["team@example.com", evidence(["same-conversation"])],
		]),
	});
	assert.deepEqual(prepared.input.candidates.map((item) => item.id), ["candidate-01", "candidate-02"]);
	assert.deepEqual(prepared.input.candidates.map((item) => item.messages[0]?.id), ["evidence-01-01", "evidence-02-01"]);
	const modelInput = JSON.stringify(prepared.input);
	for (const secret of ["me@example.com", "team@example.com", "same-conversation", "same-local-message", "reminder-same-conversation"]) {
		assert.equal(modelInput.includes(secret), false);
	}
	assert.equal(prepared.authority.get("candidate-01")?.publicCandidate.mailboxId, "team@example.com");
	assert.equal(prepared.authority.get("candidate-02")?.publicCandidate.mailboxId, "me@example.com");
	assert.deepEqual(prepared.counts, { privateRemindersDue: 1, unreadConversations: 2 });
	assert.equal(prepared.omittedCount, 3);
});

test("maximum aggregate evidence is reduced below the complete model envelope bound", () => {
	const sources = Array.from({ length: 12 }, (_, index) => {
		const item = candidate(`conversation-${index}`, "2026-07-12T12:00:00.000Z", { unread: true });
		item.sourceEmailId = `message-${index}`;
		item.subject = "😀".repeat(500);
		item.counterparty = "é".repeat(320);
		return mailbox(`team-${index}@example.com`, [item]);
	});
	const evidenceByMailbox = new Map(sources.map((source, index) => [source.mailboxId, {
		sequence: 4,
		evidence: [{
			conversationKey: `conversation-${index}`,
			messages: [0, 1].map((messageIndex) => ({
				id: messageIndex === 0 ? `message-${index}` : `context-${index}`,
				date: `2026-07-12T${String(12 - messageIndex).padStart(2, "0")}:00:00.000Z`,
				folderId: "inbox" as const,
				sender: "é".repeat(320),
				subject: "😀".repeat(500),
				text: "😀".repeat(2_000),
			})),
		}],
	}]));
	const prepared = prepareGlobalTodayBriefCandidates({
		localDate: "2026-07-12",
		timezone: "Africa/Cairo",
		mailboxes: sources,
		evidenceByMailbox,
	});
	const serialized = JSON.stringify(buildTodayBriefModelMessages(prepared.input));
	assert.ok(new TextEncoder().encode(serialized).byteLength < 64 * 1_024);
});
