import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { buildMailSearchPlan } from "./mail-search.ts";
import { SearchQueryError } from "../../shared/mail-search.ts";

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, subject TEXT, sender TEXT,
			recipient TEXT, cc TEXT, bcc TEXT, date TEXT, read INTEGER, starred INTEGER,
			body TEXT, in_reply_to TEXT, email_references TEXT, thread_id TEXT,
			snooze_source_folder_id TEXT, snoozed_until TEXT
		);
		CREATE TABLE attachments (
			id TEXT PRIMARY KEY, email_id TEXT NOT NULL, filename TEXT NOT NULL
		);
		CREATE TABLE email_body_objects (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
			part_index INTEGER NOT NULL CHECK(part_index >= 0),
			content_type TEXT NOT NULL CHECK(content_type IN ('text/html', 'text/plain')),
			charset TEXT NOT NULL,
			r2_key TEXT NOT NULL UNIQUE,
			byte_length INTEGER NOT NULL CHECK(byte_length >= 0)
		);
		CREATE INDEX idx_email_body_objects_email_id
			ON email_body_objects(email_id, part_index);
		CREATE TABLE email_labels (email_id TEXT NOT NULL, label_id TEXT NOT NULL);
		INSERT INTO folders VALUES ('inbox', 'Inbox'), ('archive', 'Archive'),
			('_cancelled_outbound', 'Retired');
	`);
	return db;
}

function run(db: DatabaseSync, input: Parameters<typeof buildMailSearchPlan>[0]) {
	const plan = buildMailSearchPlan(input);
	return {
		rows: db.prepare(plan.dataSql).all(...plan.dataParams) as Array<Record<string, unknown>>,
		count: db.prepare(plan.countSql).get(...plan.countParams) as { total: number },
	};
}

test("mail search ANDs free-text terms across mail fields and attachment filenames", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails VALUES
			('both', 'inbox', 'Renewal ready', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'Please review the final package', NULL, NULL, 't1', NULL, NULL),
			('one', 'inbox', 'Renewal only', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'No file here', NULL, NULL, 't2', NULL, NULL);
		INSERT INTO attachments VALUES ('a1', 'both', 'signed-proposal.pdf');
		INSERT INTO email_body_objects VALUES
			('body-both', 'both', 0, 'text/html', 'utf-8', 'email-bodies/both/0.body', 31);
	`);

	const result = run(db, { terms: ["renewal", "proposal"], page: 1, limit: 25 });
	assert.deepEqual(result.rows.map((row) => row.id), ["both"]);
	assert.equal(result.count.total, 1);
	assert.equal(result.rows[0]?.matched_attachment_filename, "signed-proposal.pdf");
	assert.equal(Number(result.rows[0]?.body_external), 1);
	assert.ok(Number(result.rows[0]?.relevance) > 0);
	assert.match(String(result.rows[0]?.snippet), /final package/);
	db.close();
});

test("filename filters return matching mail and an executable total count", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails VALUES
			('matching', 'inbox', 'Terms', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'Please review', NULL, NULL, 't1', NULL, NULL),
			('other', 'inbox', 'Notes', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'Unrelated', NULL, NULL, 't2', NULL, NULL);
		INSERT INTO attachments VALUES
			('a1', 'matching', 'signed-terms.pdf'),
			('a2', 'other', 'meeting-notes.txt');
	`);

	const result = run(db, { filename: ["terms.pdf"] });
	assert.deepEqual(result.rows.map((row) => row.id), ["matching"]);
	assert.equal(result.count.total, 1);
	db.close();
});

test("ordinary search executes the complete public 32-token query limit", () => {
	const db = database();
	const terms = Array.from({ length: 32 }, (_, index) => `term${index + 1}`);
	const insert = db.prepare(`INSERT INTO emails VALUES
		('all-terms', 'inbox', 'Complete query', 'alice@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run(terms.join(" "));

	const result = run(db, { terms });
	assert.deepEqual(result.rows.map((row) => row.id), ["all-terms"]);
	assert.equal(result.count.total, 1);
	db.close();
});

test("mail search accepts exactly 100 binds and rejects the next combined filter", () => {
	const terms = Array.from({ length: 32 }, (_, index) => `term${index + 1}`);
	assert.doesNotThrow(() => buildMailSearchPlan({
		terms,
		from: "alice@example.com",
		to: "team@example.com",
	}));
	assert.throws(
		() => buildMailSearchPlan({
			terms,
			from: "alice@example.com",
			to: "team@example.com",
			subject: "renewal",
		}),
		(error) =>
			error instanceof SearchQueryError &&
			error.code === "QUERY_TOO_LARGE" &&
			error.message === "Search uses too many combined filters",
	);
});

test("mail search treats repeated structured values as OR and different filters as AND", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails VALUES
			('alice', 'inbox', 'Renewal', 'alice@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'A', NULL, NULL, 't1', NULL, NULL),
			('bob', 'archive', 'Renewal', 'bob@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-09T10:00:00.000Z', 0, 0, 'B', NULL, NULL, 't2', NULL, NULL),
			('carol', 'inbox', 'Renewal', 'carol@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-11T10:00:00.000Z', 0, 0, 'C', NULL, NULL, 't3', NULL, NULL);
	`);
	const result = run(db, {
		from: ["alice", "bob"],
		folder: ["inbox", "archive"],
		subject: ["renewal"],
	});
	assert.deepEqual(result.rows.map((row) => row.id), ["alice", "bob"]);
	db.close();
});

test("mail search defaults to relevance then recency and has stable id pagination", () => {
	const db = database();
	db.exec(`
		INSERT INTO emails VALUES
			('a', 'inbox', 'Status', 'one@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'apollo', NULL, NULL, 't1', NULL, NULL),
			('b', 'inbox', 'Status', 'two@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-10T10:00:00.000Z', 0, 0, 'apollo', NULL, NULL, 't2', NULL, NULL),
			('older-subject', 'inbox', 'Apollo launch', 'three@example.com', 'team@example.com', NULL, NULL,
			 '2026-07-01T10:00:00.000Z', 0, 0, 'details', NULL, NULL, 't3', NULL, NULL);
	`);
	assert.deepEqual(
		run(db, { terms: ["apollo"] }).rows.map((row) => row.id),
		["older-subject", "a", "b"],
	);
	assert.deepEqual(run(db, { terms: ["apollo"], page: 1, limit: 1 }).rows.map((row) => row.id), ["older-subject"]);
	assert.deepEqual(run(db, { terms: ["apollo"], page: 2, limit: 1 }).rows.map((row) => row.id), ["a"]);
	db.close();
});

test("mail search centers snippets on the first body match and escapes LIKE wildcards", () => {
	const db = database();
	const body = `${"preface ".repeat(30)}100% complete with signed terms${" suffix".repeat(20)}`;
	const insert = db.prepare(`INSERT INTO emails VALUES
		(?, 'inbox', ?, 'one@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run("literal", "Progress", body);
	insert.run("wildcard-trap", "Anything", "This should not match");

	const result = run(db, { terms: ["100%"] });
	assert.deepEqual(result.rows.map((row) => row.id), ["literal"]);
	assert.match(String(result.rows[0]?.snippet), /100% complete/);
	assert.ok(!String(result.rows[0]?.snippet).startsWith("preface preface"));
	db.close();
});

test("mail search centers on a later term when the first term matches only the subject", () => {
	const db = database();
	const body = `${"opening ".repeat(35)}signed agreement${" closing".repeat(20)}`;
	const insert = db.prepare(`INSERT INTO emails VALUES
		('message', 'inbox', 'Renewal', 'one@example.com', 'team@example.com', NULL, NULL,
		 '2026-07-10T10:00:00.000Z', 0, 0, ?, NULL, NULL, 't1', NULL, NULL)`);
	insert.run(body);
	const result = run(db, { terms: ["renewal", "signed agreement"] });
	assert.match(String(result.rows[0]?.snippet), /signed agreement/);
	assert.ok(!String(result.rows[0]?.snippet).startsWith("opening opening"));
	db.close();
});

test("explicit sort keeps the selected column and deterministic id tie-break", () => {
	const plan = buildMailSearchPlan({
		terms: ["renewal"],
		sortColumn: "sender",
		sortDirection: "ASC",
	});
	assert.match(plan.dataSql, /ORDER BY e\.sender ASC, e\.id ASC/);
	assert.doesNotMatch(plan.dataSql, /relevance DESC/);
});

test("authoritative planning rejects oversized structured input instead of truncating it", () => {
	assert.throws(
		() => buildMailSearchPlan({ from: Array.from({ length: 9 }, (_, index) => `user-${index}`) }),
		SearchQueryError,
	);
	assert.throws(
		() => buildMailSearchPlan({ filename: "x".repeat(201) }),
		SearchQueryError,
	);
});

test("mail search enforces the Durable Object 50-byte LIKE pattern boundary", () => {
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["a".repeat(48)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["a".repeat(49)] }),
		(error) =>
			error instanceof SearchQueryError &&
			error.code === "QUERY_TOO_LARGE" &&
			error.message === "Search value exceeds the mailbox pattern limit",
	);
});

test("mail search counts LIKE escape expansion and UTF-8 bytes", () => {
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["%".repeat(24)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["%".repeat(25)] }),
		SearchQueryError,
	);
	assert.doesNotThrow(() => buildMailSearchPlan({ terms: ["€".repeat(16)] }));
	assert.throws(
		() => buildMailSearchPlan({ terms: ["€".repeat(17)] }),
		SearchQueryError,
	);
});

test("mail search applies the LIKE byte limit to every structured LIKE filter", () => {
	for (const options of [
		{ from: "a".repeat(49) },
		{ to: "a".repeat(49) },
		{ subject: "a".repeat(49) },
		{ filename: "a".repeat(49) },
	]) {
		assert.throws(() => buildMailSearchPlan(options), SearchQueryError);
	}
});
