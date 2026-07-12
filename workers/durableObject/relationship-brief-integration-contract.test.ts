import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";
import { createMailPeopleProjector } from "../lib/people/index.ts";
import { readRelationshipBriefEvidence } from "../lib/relationship-brief-evidence.ts";

const durableObject = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("Durable Object evidence drives People replay/building before exposing AI evidence", () => {
	assert.match(
		durableObject,
		/async getRelationshipBriefEvidence[\s\S]*?createMailPeopleProjector[\s\S]*?projector\.getPerson\(id\)[\s\S]*?prepared\.status === "building"[\s\S]*?return readRelationshipBriefEvidence/,
	);
	assert.match(
		durableObject,
		/claimRelationshipBriefGeneration[\s\S]*?claimTodayBriefGeneration\([\s\S]*?ownerUserId/,
	);
	assert.match(worker, /requireMailbox[\s\S]*?app\.route\("\/", relationshipBriefRoutes\)/);
});

test("People replay removes Trash evidence before the relationship brief projection can read it", () => {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, subject TEXT, sender TEXT,
			recipient TEXT, cc TEXT, bcc TEXT, date TEXT, read INTEGER, body TEXT,
			thread_id TEXT, recipient_memory_origin TEXT
		);
		CREATE TABLE attachments (
			id TEXT PRIMARY KEY, email_id TEXT, filename TEXT, mimetype TEXT,
			size INTEGER, disposition TEXT
		);
		CREATE TABLE mailbox_changes (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT, entity_id TEXT
		);
		INSERT INTO folders VALUES
			('inbox','Inbox'),('sent','Sent'),('archive','Archive'),('snoozed','Snoozed'),
			('draft','Drafts'),('outbox','Outbox'),('spam','Spam'),('trash','Trash'),
			('_cancelled_outbound','Retired');
	`);
	const migration = mailboxMigrations.find((item) => item.name === "24_add_mail_people_projection");
	assert.ok(migration);
	database.exec(migration.sql);
	const store = {
		sql: { exec: (query: string, ...bindings: Array<string | number | null>) => database.prepare(query).all(...bindings) },
		transactionSync<T>(operation: () => T): T {
			database.exec("BEGIN");
			try { const result = operation(); database.exec("COMMIT"); return result; }
			catch (error) { database.exec("ROLLBACK"); throw error; }
		},
	};
	database.prepare(`
		INSERT INTO emails (
			id, folder_id, subject, sender, recipient, date, read, body, thread_id,
			recipient_memory_origin, sender_name
		) VALUES (?, ?, ?, ?, 'team@example.com', ?, 0, ?, ?, ?, ?)
	`).run(
		"message-1", "inbox", "Hello", "client@example.com",
		"2026-07-12T10:00:00.000Z", "Body", "conversation-1", "live_inbound", "Client",
	);
	for (const [id, folder, origin] of [
		["draft-message", "draft", "live_inbound"],
		["outbox-message", "outbox", "accepted_outbound"],
		["spam-message", "spam", "live_inbound"],
		["trash-message", "trash", "live_inbound"],
		["legacy-message", "inbox", null],
	] as const) {
		database.prepare(`
			INSERT INTO emails (
				id, folder_id, subject, sender, recipient, date, read, body, thread_id,
				recipient_memory_origin, sender_name
			) VALUES (?, ?, 'Excluded', ?, 'team@example.com', '2026-07-12T09:00:00.000Z', 0, 'Private', ?, ?, NULL)
		`).run(id, folder, `${id}@example.com`, `conversation-${id}`, origin);
	}
	const projector = createMailPeopleProjector({
		store,
		mailboxAddress: "team@example.com",
		personId: () => "person-1",
		now: () => "2026-07-12T12:00:00.000Z",
	});
	assert.equal(projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null }).status, "ready");
	assert.equal(readRelationshipBriefEvidence(store.sql, "person-1").state, "ready");
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total, 1);

	database.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = 'message-1'").run();
	database.prepare("INSERT INTO mailbox_changes (resource, entity_id) VALUES ('message', 'message-1')").run();
	assert.equal(projector.getPerson("person-1").status, "ready");
	assert.deepEqual(readRelationshipBriefEvidence(store.sql, "person-1"), { state: "not_found" });
	database.close();
});
