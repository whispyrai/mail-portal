import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";
import {
	readGlobalTodayBriefEvidence,
	readGlobalTodayBriefMetadata,
	readTodayBriefCandidates,
	TODAY_BRIEF_CANDIDATE_LIMITS,
} from "./today-brief-candidates.ts";

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			subject TEXT,
			sender TEXT,
			recipient TEXT,
			date TEXT,
			read INTEGER,
			body TEXT,
			thread_id TEXT
		);
		CREATE TABLE attachments (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL,
			filename TEXT NOT NULL
		);
		CREATE TABLE mailbox_changes (
			sequence INTEGER PRIMARY KEY,
			schema_version INTEGER NOT NULL,
			committed_at TEXT NOT NULL,
			resource TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			parent_id TEXT,
			operation TEXT NOT NULL
		);
	`);
	const insert = database.prepare(
		`INSERT INTO emails
		 (id, folder_id, subject, sender, recipient, date, read, body, thread_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	return {
		database,
		insert(input: {
			id: string;
			folder?: string;
			subject?: string;
			sender?: string;
			recipient?: string;
			date: string;
			read?: number;
			body?: string;
			threadId?: string | null;
		}) {
			insert.run(
				input.id,
				input.folder ?? "inbox",
				input.subject ?? "Subject",
				input.sender ?? "sender@example.com",
				input.recipient ?? "team@example.com",
				input.date,
				input.read ?? 0,
				input.body ?? "Body",
				input.threadId ?? input.id,
			);
		},
		sql: {
			exec<T extends Record<string, ArrayBuffer | string | number | null>>(
				query: string,
				...bindings: ArrayBuffer[] | Array<string | number | null>
			) {
				return database.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

function reminder(
	id: string,
	conversationKey: string,
	remindAt: string,
	overrides: Partial<FollowUpReminder> = {},
): FollowUpReminder {
	return {
		id,
		ownerUserId: "actor-1",
		mailboxAddress: "team@example.com",
		conversationKey,
		baselineMessageId: `${conversationKey}-baseline`,
		baselineMessageDate: "2026-07-11T08:00:00.000Z",
		remindAt,
		state: "active",
		resolutionReason: null,
		version: 3,
		createdAt: Date.parse("2026-07-11T08:00:00.000Z"),
		updatedAt: Date.parse("2026-07-11T09:00:00.000Z"),
		resolvedAt: null,
		...overrides,
	};
}

const boundaries = {
	now: "2026-07-12T10:00:00.000Z",
	tomorrowStart: "2026-07-13T00:00:00.000Z",
};

test("aggregate metadata is body-free and selected evidence is sequence-bound", () => {
	const { database, insert, sql } = fixture();
	insert({
		id: "latest",
		threadId: "thread-a",
		date: "2026-07-12T09:00:00.000Z",
		body: "private latest body",
	});
	insert({
		id: "older",
		threadId: "thread-a",
		folder: "sent",
		date: "2026-07-12T08:00:00.000Z",
		read: 1,
		body: "private older body",
	});
	database.prepare(
		"INSERT INTO mailbox_changes VALUES (7, 1, '2026-07-12T09:00:00.000Z', 'message', 'latest', NULL, 'created')",
	).run();
	const metadata = readGlobalTodayBriefMetadata(
		sql,
		"team@example.com",
		[reminder("reminder-a", "thread-a", "2026-07-12T08:30:00.000Z")],
		boundaries,
	);
	assert.equal(metadata.sequence, 7);
	assert.equal(metadata.totalCandidateCount, 1);
	assert.equal(metadata.candidates[0]?.conversationKey, "thread-a");
	assert.equal(JSON.stringify(metadata).includes("private latest body"), false);

	const evidence = readGlobalTodayBriefEvidence(sql, [{ conversationKey: "thread-a", sourceEmailId: "latest" }]);
	assert.equal(evidence.sequence, 7);
	assert.deepEqual(evidence.evidence[0]?.messages.map((message) => message.id), ["older", "latest"]);
	assert.deepEqual(evidence.evidence[0]?.messages.map((message) => message.text), ["private older body", "private latest body"]);
	database.close();
});

test("aggregate unread candidates anchor citations to an actually unread Inbox message", () => {
	const { database, insert, sql } = fixture();
	insert({ id: "unread-source", threadId: "thread-a", date: "2026-07-12T08:00:00.000Z", read: 0 });
	insert({ id: "read-inbox", threadId: "thread-a", date: "2026-07-12T10:00:00.000Z", read: 1 });
	insert({ id: "sent-latest", threadId: "thread-a", folder: "sent", date: "2026-07-12T11:00:00.000Z", read: 1 });
	const metadata = readGlobalTodayBriefMetadata(sql, "team@example.com", [], boundaries);
	assert.equal(metadata.candidates[0]?.sourceEmailId, "unread-source");
	const evidence = readGlobalTodayBriefEvidence(sql, [{ conversationKey: "thread-a", sourceEmailId: "unread-source" }]);
	assert.deepEqual(evidence.evidence[0]?.messages.map((message) => message.id), ["sent-latest", "unread-source"]);
	database.close();
});

test("aggregate metadata accepts the globally supported per-Mailbox reminder capacity", () => {
	const { database, sql } = fixture();
	const reminders = Array.from({ length: 101 }, (_, index) => reminder(`reminder-${index}`, `missing-${index}`, "2026-07-12T09:00:00.000Z"));
	assert.doesNotThrow(() => readGlobalTodayBriefMetadata(sql, "team@example.com", reminders, boundaries));
	database.close();
});

test("deduplicates reminder and mailbox-wide unread reasons by canonical thread", () => {
	const { database, insert, sql } = fixture();
	insert({
		id: "combined-inbound",
		threadId: "combined-thread",
		date: "2026-07-12T09:00:00.000Z",
		body: "<p>Please review</p>",
	});
	insert({
		id: "combined-sent",
		folder: "sent",
		threadId: "combined-thread",
		sender: "team@example.com",
		recipient: "customer@example.com",
		date: "2026-07-12T09:30:00.000Z",
		read: 1,
		body: "<p>Earlier response</p>",
	});
	insert({
		id: "combined-draft",
		folder: "draft",
		threadId: "combined-thread",
		date: "2026-07-12T09:45:00.000Z",
		body: "must not leave storage",
	});
	database.prepare(
		"INSERT INTO attachments VALUES ('secret', 'combined-inbound', 'secret.pdf')",
	).run();

	const projection = readTodayBriefCandidates(
		sql,
		"team@example.com",
		[reminder("reminder-1", "combined-thread", "2026-07-12T08:00:00.000Z")],
		boundaries,
	);

	assert.equal(projection.omittedCount, 0);
	assert.deepEqual(projection.counts, {
		privateRemindersDue: 1,
		unreadConversations: 1,
	});
	assert.equal(projection.candidates.length, 1);
	const candidate = projection.candidates[0]!;
	assert.equal(candidate.id, "focus-01");
	assert.deepEqual(candidate.reasons, ["overdue_reminder", "unread_in_mailbox"]);
	assert.equal(candidate.reminder?.dueAt, "2026-07-12T08:00:00.000Z");
	assert.equal(candidate.unreadInMailbox, true);
	assert.equal(candidate.sourceEmailId, "combined-sent");
	assert.equal(candidate.counterparty, "customer@example.com");
	assert.deepEqual(
		candidate.messages.map((message) => message.id),
		["combined-inbound", "combined-sent"],
	);
	assert.equal(candidate.messages[0]?.text, "Please review");
	assert.equal(JSON.stringify(candidate).includes("combined-draft"), false);
	assert.equal(JSON.stringify(candidate).includes("secret.pdf"), false);
	database.close();
});

test("orders overdue, today, and unread work deterministically before applying the cap", () => {
	const { database, insert, sql } = fixture();
	for (const [id, date] of [
		["overdue-later", "2026-07-12T07:00:00.000Z"],
		["overdue-earlier", "2026-07-12T06:00:00.000Z"],
		["today", "2026-07-12T09:00:00.000Z"],
	] as const) {
		insert({ id: `${id}-message`, threadId: id, date, read: 1 });
	}
	for (let index = 0; index < 15; index++) {
		const padded = String(index).padStart(2, "0");
		insert({
			id: `unread-${padded}-message`,
			threadId: `unread-${padded}`,
			date: `2026-07-11T${padded}:00:00.000Z`,
		});
	}

	const projection = readTodayBriefCandidates(
		sql,
		"team@example.com",
		[
			reminder("later", "overdue-later", "2026-07-12T09:00:00.000Z"),
			reminder("earlier", "overdue-earlier", "2026-07-12T08:00:00.000Z"),
			reminder("today", "today", "2026-07-12T12:00:00.000Z"),
		],
		boundaries,
	);

	assert.equal(projection.candidates.length, TODAY_BRIEF_CANDIDATE_LIMITS.candidates);
	assert.equal(projection.omittedCount, 6);
	assert.deepEqual(projection.counts, {
		privateRemindersDue: 3,
		unreadConversations: 15,
	});
	assert.deepEqual(
		projection.candidates.slice(0, 3).map((candidate) => candidate.conversationKey),
		["overdue-earlier", "overdue-later", "today"],
	);
	assert.deepEqual(
		projection.candidates.slice(3, 6).map((candidate) => candidate.conversationKey),
		["unread-14", "unread-13", "unread-12"],
	);
	database.close();
});

test("returns only the two latest eligible messages as bounded plain text", () => {
	const { database, insert, sql } = fixture();
	for (const [index, folder] of [
		[0, "inbox"],
		[1, "archive"],
		[2, "snoozed"],
		[3, "sent"],
		[4, "trash"],
		[5, "spam"],
		[6, "outbox"],
		[7, "_cancelled_outbound"],
	] as const) {
		insert({
			id: `message-${index}`,
			threadId: "bounded-thread",
			folder,
			date: `2026-07-12T0${index}:00:00.000Z`,
			read: 1,
			body: index === 3
				? `<style>secret</style><script>also secret</script><p>${"x".repeat(3_000)}</p>`
				: index === 2
					? ""
					: `<p>message ${index}</p>`,
		});
	}

	const projection = readTodayBriefCandidates(
		sql,
		"team@example.com",
		[reminder("bounded", "bounded-thread", "2026-07-12T11:00:00.000Z")],
		boundaries,
	);
	const messages = projection.candidates[0]?.messages ?? [];
	assert.deepEqual(messages.map((message) => message.id), ["message-2", "message-3"]);
	assert.equal(messages[0]?.text, "");
	assert.equal(messages[1]?.text.length, TODAY_BRIEF_CANDIDATE_LIMITS.bodyChars);
	assert.doesNotMatch(messages[1]?.text ?? "", /secret|script|style|<|>/i);
	database.close();
});

test("excludes future, inactive, invalid, and stale reminders without eligible evidence", () => {
	const { database, insert, sql } = fixture();
	for (const folder of [
		"draft",
		"outbox",
		"trash",
		"spam",
		"_cancelled_outbound",
	] as const) {
		insert({
			id: `${folder}-message`,
			threadId: `${folder}-thread`,
			folder,
			date: "2026-07-12T09:00:00.000Z",
			read: 1,
		});
	}
	insert({
		id: "valid-message",
		threadId: null,
		folder: "archive",
		date: "2026-07-12T09:00:00.000Z",
		read: 1,
	});

	const projection = readTodayBriefCandidates(
		sql,
		"team@example.com",
		[
			...[
				"draft",
				"outbox",
				"trash",
				"spam",
				"_cancelled_outbound",
			].map((folder) =>
				reminder(folder, `${folder}-thread`, "2026-07-12T11:00:00.000Z")
			),
			reminder("future", "valid-message", "2026-07-13T00:00:00.000Z"),
			reminder("inactive", "valid-message", "2026-07-12T11:00:00.000Z", {
				state: "dismissed",
				resolutionReason: "dismissed",
			}),
			reminder("invalid", "valid-message", "not-a-date"),
			reminder("valid", "valid-message", "2026-07-12T11:00:00.000Z"),
		],
		boundaries,
	);

	assert.deepEqual(
		projection.candidates.map((candidate) => candidate.conversationKey),
		["valid-message"],
	);
	assert.equal(projection.omittedCount, 0);
	assert.deepEqual(projection.counts, {
		privateRemindersDue: 1,
		unreadConversations: 0,
	});
	database.close();
});

test("rejects invalid temporal and reminder input bounds", () => {
	const { database, sql } = fixture();
	assert.throws(
		() => readTodayBriefCandidates(sql, "team@example.com", [], {
			now: boundaries.now,
			tomorrowStart: boundaries.now,
		}),
		/valid Today brief boundaries/i,
	);
	assert.throws(
		() => readTodayBriefCandidates(
			sql,
			"team@example.com",
			Array.from(
				{ length: TODAY_BRIEF_CANDIDATE_LIMITS.reminderInputs + 1 },
				(_, index) => reminder(
					`reminder-${index}`,
					`thread-${index}`,
					"2026-07-12T11:00:00.000Z",
				),
			),
			boundaries,
		),
		/reminder input exceeds/i,
	);
	database.close();
});
