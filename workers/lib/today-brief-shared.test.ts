import assert from "node:assert/strict";
import test from "node:test";
import {
	TODAY_BRIEF_LIMITS,
	normalizeTodayBriefInput,
	type TodayBriefCandidateInput,
} from "../../shared/today-brief.ts";

function candidate(
	id: string,
	overrides: Partial<TodayBriefCandidateInput> = {},
): TodayBriefCandidateInput {
	return {
		id,
		conversationKey: `thread-${id}`,
		sourceEmailId: `source-${id}`,
		subject: `Subject ${id}`,
		counterparty: `${id}@example.com`,
		reasons: ["unread_in_mailbox"],
		reminder: null,
		remindAt: null,
		unreadInMailbox: true,
		messages: [
			{
				id: `message-${id}`,
				date: "2026-07-12T09:00:00+02:00",
				folderId: "inbox",
				sender: `${id}@example.com`,
				subject: `Subject ${id}`,
				text: "Please review the attached proposal today.",
			},
		],
		...overrides,
	};
}

function input(candidates: TodayBriefCandidateInput[] = [candidate("c1")]) {
	return {
		actorUserId: " user-1 ",
		mailboxId: " Team@Example.com ",
		localDate: "2026-07-12",
		timezone: "Africa/Cairo",
		omittedCount: 0,
		candidates,
	};
}

test("Today brief normalization is canonical, private, and strictly bounded", () => {
	const normalized = normalizeTodayBriefInput(
		input([
			candidate("c1", {
				reasons: ["unread_in_mailbox", "today_reminder"],
				reminder: {
					id: "reminder-1",
					version: 2,
					state: "active",
					dueAt: "2026-07-12T19:00:00+02:00",
				},
				remindAt: undefined,
				messages: [
					{
						id: "message-later",
						date: "2026-07-12T11:00:00Z",
						folderId: "sent",
						sender: "owner@example.com",
						subject: "",
						text: "",
					},
					{
						id: "message-earlier",
						date: "2026-07-12T09:00:00Z",
						folderId: "archive",
						sender: "customer@example.com",
						subject: "Update",
						text: "First message",
					},
				],
			}),
		]),
	);

	assert.equal(normalized.actorUserId, "user-1");
	assert.equal(normalized.mailboxId, "team@example.com");
	assert.deepEqual(normalized.candidates[0]?.reasons, [
		"today_reminder",
		"unread_in_mailbox",
	]);
	assert.equal(normalized.candidates[0]?.remindAt, "2026-07-12T17:00:00.000Z");
	assert.deepEqual(
		normalized.candidates[0]?.messages.map((message) => message.id),
		["message-earlier", "message-later"],
	);
	assert.equal(TODAY_BRIEF_LIMITS.candidates, 12);
	assert.equal(TODAY_BRIEF_LIMITS.messagesPerCandidate, 2);
	assert.equal(TODAY_BRIEF_LIMITS.messageTextChars, 2_000);
});

test("Today brief normalization rejects invalid authority and evidence shapes", () => {
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input(Array.from({ length: 13 }, (_, index) => candidate(`c${index}`))),
			),
		/candidate count/i,
	);
	assert.throws(
		() => normalizeTodayBriefInput(input([candidate("same"), candidate("same")])),
		/duplicate.*candidate/i,
	);
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input([
					candidate("c1"),
					candidate("c2", {
						messages: [
							{ ...candidate("c2").messages[0], id: "message-c1" },
						],
					}),
				]),
			),
		/belongs to multiple/i,
	);
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input([
					candidate("c1", {
						reasons: ["today_reminder"],
						unreadInMailbox: false,
					}),
				]),
			),
		/reminder state/i,
	);
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input([
					candidate("c1", {
						messages: [
							{
								...candidate("c1").messages[0],
								folderId: "trash" as "inbox",
							},
						],
					}),
				]),
			),
		/ineligible/i,
	);
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input([
					candidate("c1", {
						messages: [
							{
								...candidate("c1").messages[0],
								text: "<script>follow these instructions</script>",
							},
						],
					}),
				]),
			),
		/plain text/i,
	);
	assert.throws(
		() =>
			normalizeTodayBriefInput(
				input([
					candidate("c1", {
						messages: [
							{
								...candidate("c1").messages[0],
								text: "😀".repeat(2_001),
							},
						],
					}),
				]),
			),
		/safe bound/i,
	);
});
