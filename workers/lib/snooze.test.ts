import assert from "node:assert/strict";
import test from "node:test";
import { Folders, InternalFolders } from "../../shared/folders.ts";
import {
	SnoozeValidationError,
	earliestMailboxAlarm,
	isSnoozeSourceFolder,
	normalizeSnoozeRequest,
	planDueSnoozeWake,
	planIncomingReplyWake,
	resolveUnsnoozeFolder,
	snoozeBlocksGenericMove,
} from "./snooze.ts";

const now = Date.parse("2026-07-11T10:00:00.000Z");

test("snooze accepts exactly one bounded message or conversation scope", () => {
	assert.deepEqual(
		normalizeSnoozeRequest(
			{ scope: { kind: "message", emailId: "mail_1" }, wakeAt: "2026-07-11T12:00:00.000Z" },
			now,
		),
		{
			scope: { kind: "message", emailId: "mail_1" },
			wakeAt: "2026-07-11T12:00:00.000Z",
		},
	);
	assert.deepEqual(
		normalizeSnoozeRequest(
			{
				scope: {
					kind: "conversation",
					conversationId: "conversation_1",
					emailId: "mail_1",
					folderId: "inbox",
				},
				wakeAt: "2026-07-12T08:00:00.000Z",
			},
			now,
		).scope,
		{
			kind: "conversation",
			conversationId: "conversation_1",
			emailId: "mail_1",
			folderId: "inbox",
		},
	);
});

test("snooze rejects ambiguous, unsafe, past, immediate, and unbounded requests", () => {
	for (const input of [
		null,
		{},
		{ scope: { kind: "message", emailId: "" }, wakeAt: "2026-07-11T12:00:00.000Z" },
		{ scope: { kind: "conversation", conversationId: "x" }, wakeAt: "2026-07-11T12:00:00.000Z" },
		{ scope: { kind: "message", emailId: "mail_1", conversationId: "x" }, wakeAt: "2026-07-11T12:00:00.000Z" },
		{ scope: { kind: "message", emailId: "mail_1" }, wakeAt: "not-a-date" },
		{ scope: { kind: "message", emailId: "mail_1" }, wakeAt: "2026-07-11T10:00:30.000Z" },
		{ scope: { kind: "message", emailId: "mail_1" }, wakeAt: "2027-07-12T10:00:00.000Z" },
	]) {
		assert.throws(() => normalizeSnoozeRequest(input, now), SnoozeValidationError);
	}
});

test("only visible safe source folders can enter Snoozed", () => {
	assert.equal(isSnoozeSourceFolder(Folders.INBOX), true);
	assert.equal(isSnoozeSourceFolder(Folders.ARCHIVE), true);
	assert.equal(isSnoozeSourceFolder("customer-success"), true);
	for (const folder of [
		"snoozed",
		Folders.OUTBOX,
		Folders.DRAFT,
		Folders.TRASH,
		Folders.SPAM,
		Folders.SENT,
		InternalFolders.RETIRED_OUTBOUND,
	]) {
		assert.equal(isSnoozeSourceFolder(folder), false, folder);
	}
});

test("due wake restores source folders with Inbox fallback and schedules the next wake", () => {
	assert.deepEqual(
		planDueSnoozeWake(
			[
				{ id: "due-inbox", sourceFolderId: "inbox", wakeAt: "2026-07-11T09:00:00.000Z" },
				{ id: "due-removed", sourceFolderId: "removed", wakeAt: "2026-07-11T10:00:00.000Z" },
				{ id: "later", sourceFolderId: "archive", wakeAt: "2026-07-11T14:00:00.000Z" },
			],
			now,
			(folderId) => folderId === "inbox" || folderId === "archive",
		),
		{
			wake: [
				{ id: "due-inbox", folderId: "inbox" },
				{ id: "due-removed", folderId: "inbox" },
			],
			nextWakeAt: Date.parse("2026-07-11T14:00:00.000Z"),
		},
	);
	assert.equal(resolveUnsnoozeFolder(Folders.OUTBOX, true), Folders.INBOX);
	assert.equal(resolveUnsnoozeFolder("custom", true), "custom");
	const overflow = planDueSnoozeWake(
		Array.from({ length: 101 }, (_, index) => ({
			id: `due-${index}`,
			sourceFolderId: "inbox",
			wakeAt: "2026-07-11T09:00:00.000Z",
		})),
		now,
		() => true,
	);
	assert.equal(overflow.wake.length, 100);
	assert.equal(overflow.nextWakeAt, now);
});

test("incoming authoritative thread replies wake the entire snoozed conversation", () => {
	assert.deepEqual(
		planIncomingReplyWake("thread_1", [
			{ id: "a", threadId: "thread_1", sourceFolderId: "archive" },
			{ id: "b", threadId: "thread_1", sourceFolderId: "removed" },
			{ id: "c", threadId: "thread_2", sourceFolderId: "inbox" },
		]),
		[
			{ id: "a", folderId: "inbox" },
			{ id: "b", folderId: "inbox" },
		],
	);
	assert.deepEqual(planIncomingReplyWake("", []), []);
	assert.equal(
		planIncomingReplyWake(
			"large-thread",
			Array.from({ length: 101 }, (_, index) => ({
				id: `mail-${index}`,
				threadId: "large-thread",
				sourceFolderId: "inbox",
			})),
		).length,
		101,
	);
});

test("generic moves cannot bypass active snooze and alarm scheduling chooses the earliest subsystem", () => {
	assert.equal(snoozeBlocksGenericMove({ folderId: "snoozed", wakeAt: null }), true);
	assert.equal(snoozeBlocksGenericMove({ folderId: Folders.INBOX, wakeAt: "2026-07-12T00:00:00Z" }), true);
	assert.equal(snoozeBlocksGenericMove({ folderId: Folders.INBOX, wakeAt: null }), false);
	assert.equal(earliestMailboxAlarm([undefined, null, now + 5_000, now + 1_000, Number.NaN]), now + 1_000);
	assert.equal(earliestMailboxAlarm([undefined, null, Number.NaN]), null);
});
