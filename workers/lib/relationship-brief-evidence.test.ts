import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { RELATIONSHIP_BRIEF_LIMITS } from "../../shared/relationship-brief.ts";
import {
	authoredRelationshipBriefText,
	readRelationshipBriefEvidence,
} from "./relationship-brief-evidence.ts";

test("evidence selects the newest 12 Conversations and 30 exact-Person Messages in canonical ascending order", () => {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE mail_people (id TEXT PRIMARY KEY, address TEXT, domain TEXT, created_at TEXT);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT, subject TEXT, body TEXT
		);
		CREATE TABLE mail_message_participants (
			source_email_id TEXT, person_id TEXT, role TEXT, direction TEXT,
			occurred_at TEXT, conversation_id TEXT, origin TEXT, observed_name TEXT
		);
		INSERT INTO mail_people VALUES
			('person-1', 'client@example.com', 'example.com', '2026-07-01T00:00:00.000Z'),
			('person-2', 'other@example.com', 'example.com', '2026-07-01T00:00:00.000Z');
	`);
	const insertEmail = database.prepare("INSERT INTO emails VALUES (?, 'inbox', ?, ?)");
	const insertEvidence = database.prepare(`
		INSERT INTO mail_message_participants
		VALUES (?, ?, 'from', 'received', ?, ?, 'live_inbound', ?)
	`);
	for (let conversation = 0; conversation < 14; conversation += 1) {
		const id = `base-${String(conversation).padStart(2, "0")}`;
		const date = new Date(Date.UTC(2026, 6, 1, 0, conversation)).toISOString();
		insertEmail.run(id, `Subject ${conversation}`, `Body ${conversation}`);
		insertEvidence.run(id, "person-1", date, `conversation-${String(conversation).padStart(2, "0")}`, conversation === 13 ? "Newest Name" : null);
	}
	for (let index = 0; index < 18; index += 1) {
		const id = `extra-${String(index).padStart(2, "0")}`;
		const date = new Date(Date.UTC(2026, 6, 2, 0, index)).toISOString();
		insertEmail.run(id, `${"S".repeat(1_100)}\u202E`, `<p>${"😀".repeat(3_100)}\u200B</p>`);
		insertEvidence.run(id, "person-1", date, "conversation-13", null);
	}
	insertEmail.run("other-message", "Private other Person", "Must not cross");
	insertEvidence.run(
		"other-message",
		"person-2",
		"2026-07-20T00:00:00.000Z",
		"other-conversation",
		"Other Person",
	);

	const projection = readRelationshipBriefEvidence({
		exec(query, ...bindings) {
			return database.prepare(query).all(...bindings);
		},
	}, "person-1");
	assert.equal(projection.state, "ready");
	if (projection.state !== "ready") return;
	assert.equal(projection.person.displayName, "Newest Name");
	assert.equal(projection.messages.length, RELATIONSHIP_BRIEF_LIMITS.messages);
	assert.equal(new Set(projection.messages.map((message) => message.conversationId)).size, 12);
	assert.equal(projection.messages.some((message) => message.id === "base-00" || message.id === "base-01"), false);
	assert.equal(projection.messages.some((message) => message.id === "other-message"), false);
	assert.deepEqual(
		projection.messages.map((message) => message.sentAt),
		[...projection.messages.map((message) => message.sentAt)].sort(),
	);
	const bounded = projection.messages.find((message) => message.id === "extra-17")!;
	assert.equal(Array.from(bounded.subject).length, 1_000);
	assert.equal(Array.from(bounded.text).length, RELATIONSHIP_BRIEF_LIMITS.messageTextChars);
	assert.doesNotMatch(bounded.subject + bounded.text, /[\u202E\u200B]/u);
	database.close();
});

test("known HTML and plain reply/forward tails are excluded from authored evidence", () => {
	const cases = [
		"Authored answer.<blockquote>Quoted promise.</blockquote>",
		"<p>Authored answer.</p><div class=\"gmail_quote\">Quoted promise.</div>",
		"<p>Authored answer.</p><div id=\"divRplyFwdMsg\">Quoted promise.</div>",
		"Authored answer.\n-----Original Message-----\nQuoted promise.",
		"Authored answer.\n---------- Forwarded message ---------\nQuoted promise.",
		"Authored answer.\nOn Fri, Client wrote:\nQuoted promise.",
		"Authored answer.\nOn Fri, Client\n<client@example.com> wrote:\nQuoted promise.",
		"Authored answer.\n> Quoted promise.",
		"<p>Authored answer.</p><br>-----Original Message-----<br>Quoted promise.",
		"<p>Authored answer.</p><br>&gt; Quoted promise.",
		"<p>Authored answer.</p><div>-----Original Message-----</div><div>Quoted promise.</div>",
		"<p>Authored answer.</p><div>&gt; Quoted promise.</div>",
	];
	for (const body of cases) {
		assert.equal(authoredRelationshipBriefText(body), "Authored answer.");
	}
});

test("inbound and outbound projections never attribute the opposite side's quoted claims", () => {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE mail_people (id TEXT PRIMARY KEY, address TEXT, domain TEXT, created_at TEXT);
		CREATE TABLE emails (id TEXT PRIMARY KEY, folder_id TEXT, subject TEXT, body TEXT);
		CREATE TABLE mail_message_participants (
			source_email_id TEXT, person_id TEXT, role TEXT, direction TEXT,
			occurred_at TEXT, conversation_id TEXT, origin TEXT, observed_name TEXT
		);
		INSERT INTO mail_people VALUES
			('person-1', 'client@example.com', 'example.com', '2026-07-01T00:00:00.000Z');
		INSERT INTO emails VALUES
			('inbound', 'inbox', 'Re: Delivery', 'Could you confirm the date?\nOn Thu, Us\n<team@example.com> wrote:\nWe will deliver Friday.'),
			('outbound', 'sent', 'Re: Delivery', 'We will confirm tomorrow.\nOn Fri, Client\n<client@example.com> wrote:\nCould you confirm the date?');
		INSERT INTO mail_message_participants VALUES
			('inbound', 'person-1', 'from', 'received', '2026-07-11T10:00:00.000Z', 'conversation-1', 'live_inbound', 'Client'),
			('outbound', 'person-1', 'to', 'sent', '2026-07-12T10:00:00.000Z', 'conversation-1', 'accepted_outbound', 'Client');
	`);
	const result = readRelationshipBriefEvidence({
		exec(query, ...bindings) {
			return database.prepare(query).all(...bindings);
		},
	}, "person-1");
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	const inbound = result.messages.find((message) => message.id === "inbound")!;
	const outbound = result.messages.find((message) => message.id === "outbound")!;
	assert.equal(inbound.direction, "received");
	assert.equal(inbound.text, "Could you confirm the date?");
	assert.doesNotMatch(inbound.text, /deliver Friday/i);
	assert.equal(outbound.direction, "sent");
	assert.equal(outbound.text, "We will confirm tomorrow.");
	assert.doesNotMatch(outbound.text, /Could you confirm/i);
	database.close();
});
