import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseInboxTriageSuggestionRequest } from "../../shared/inbox-triage-suggestions.ts";
import {
	projectInboxTriageCandidates,
	type InboxTriageSqlReader,
} from "./inbox-triage-candidates.ts";

const request = parseInboxTriageSuggestionRequest({
	page: 1,
	visibleEmailIds: ["email-1", "email-2"],
});

function sqlReader() {
	const calls: Array<{ query: string; bindings: unknown[] }> = [];
	const sql: InboxTriageSqlReader = {
		exec: ((query: string, ...bindings: unknown[]) => {
			calls.push({ query, bindings });
			return [
				{
					candidateId: "email-1",
					id: "message-older",
					date: "2026-07-10T08:00:00Z",
					sender: "customer@example.com",
					subject: "Question",
					body: "<p>Earlier detail</p>",
				},
				{
					candidateId: "email-1",
					id: "email-1",
					date: "2026-07-12T08:00:00Z",
					sender: "team@example.com",
					subject: "Re: Question",
					body: `<script>bad()</script><p>${"x".repeat(900)}</p>`,
				},
				{
					candidateId: "email-2",
					id: "email-2",
					date: "2026-07-11T08:00:00Z",
					sender: "other@example.com",
					subject: "Done",
					body: "Resolved",
				},
			];
		}) as InboxTriageSqlReader["exec"],
	};
	return { sql, calls };
}

const rows = [
	{
		id: "email-1",
		conversation_id: "thread-1",
		subject: "Question",
		sender: "team@example.com",
		recipient: "customer@example.com",
		date: "2026-07-12T08:00:00Z",
		read: 0,
		thread_unread_count: 1,
		starred: 0,
		has_draft: 0,
		folder_id: "inbox",
	},
	{
		id: "email-2",
		conversation_id: "thread-2",
		subject: "Done",
		sender: "other@example.com",
		recipient: "team@example.com",
		date: "2026-07-11T08:00:00Z",
		read: 1,
		thread_unread_count: 0,
		starred: 1,
		has_draft: 1,
		folder_id: "inbox",
	},
];

test("projects all visible candidates with one set-bounded mail-only SQL read", () => {
	const { sql, calls } = sqlReader();
	const result = projectInboxTriageCandidates(
		sql,
		rows,
		request,
		"team@example.com",
	);
	assert.equal(result.state, "ready");
	assert.equal(calls.length, 1);
	assert.match(calls[0]!.query, /ROW_NUMBER\(\) OVER/i);
	assert.match(calls[0]!.query, /ORDER BY e\.date DESC, e\.id DESC/i);
	assert.match(calls[0]!.query, /evidence_rank <= 2/i);
	assert.match(
		calls[0]!.query,
		/ORDER BY candidateId ASC, date ASC, id ASC/i,
	);
	assert.doesNotMatch(calls[0]!.query, /attachment/i);
	assert.deepEqual(calls[0]!.bindings, [
		"email-1",
		"thread-1",
		"email-2",
		"thread-2",
	]);
	if (result.state !== "ready") return;
	assert.equal(result.snapshot.candidates.length, 2);
	assert.equal(
		result.snapshot.candidates[0]!.counterparty,
		"customer@example.com",
	);
	assert.equal(result.snapshot.candidates[0]!.messages.length, 2);
	assert.equal(result.snapshot.candidates[0]!.messages[1]!.text.length, 800);
	assert.doesNotMatch(result.snapshot.candidates[0]!.messages[1]!.text, /bad/);
	assert.equal(
		result.snapshot.candidates[1]!.counterparty,
		"other@example.com",
	);
});

test("ordered visible ID mismatch returns stale before any evidence query", () => {
	const { sql, calls } = sqlReader();
	assert.deepEqual(
		projectInboxTriageCandidates(
			sql,
			[rows[1]!, rows[0]!],
			request,
			"team@example.com",
		),
		{ state: "stale" },
	);
	assert.equal(calls.length, 0);
});

test("empty authoritative page returns stale before constructing an evidence VALUES clause", () => {
	const { sql, calls } = sqlReader();
	assert.deepEqual(
		projectInboxTriageCandidates(sql, [], request, "team@example.com"),
		{ state: "stale" },
	);
	assert.equal(calls.length, 0);
});

test("non-Inbox representative or missing bounded evidence fails closed", () => {
	const { sql } = sqlReader();
	assert.deepEqual(
		projectInboxTriageCandidates(
			sql,
			[{ ...rows[0]!, folder_id: "trash" }, rows[1]!],
			request,
			"team@example.com",
		),
		{ state: "stale" },
	);
	const emptySql: InboxTriageSqlReader = {
		exec: (() => []) as InboxTriageSqlReader["exec"],
	};
	assert.deepEqual(
		projectInboxTriageCandidates(
			emptySql,
			rows,
			request,
			"team@example.com",
		),
		{ state: "stale" },
	);
});

test("authoritative Inbox pagination has stable same-date representative ordering", () => {
	const durableObjectSource = readFileSync(
		new URL("../durableObject/index.ts", import.meta.url),
		"utf8",
	);
	assert.match(
		durableObjectSource,
		/ROW_NUMBER\(\) OVER \(PARTITION BY conversation_id ORDER BY date DESC, id DESC\)/,
	);
	assert.match(
		durableObjectSource,
		/ORDER BY lif\.date DESC, lif\.conversation_id ASC, lif\.id ASC/,
	);
	assert.match(
		durableObjectSource,
		/validateNormalizedInboxTriageSuggestionRequest\(request\)/,
	);
});
