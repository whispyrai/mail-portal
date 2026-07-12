import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../../durableObject/migrations.ts";
import { createMailPeopleProjector } from "./index.ts";

function database() {
	const value = new DatabaseSync(":memory:");
	value.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL);
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			subject TEXT,
			sender TEXT,
			recipient TEXT,
			cc TEXT,
			bcc TEXT,
			date TEXT,
			read INTEGER,
			thread_id TEXT,
			recipient_memory_origin TEXT
		);
		CREATE TABLE attachments (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
			filename TEXT NOT NULL,
			mimetype TEXT NOT NULL,
			size INTEGER NOT NULL,
			disposition TEXT
		);
		CREATE TABLE mailbox_changes (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			resource TEXT NOT NULL,
			entity_id TEXT NOT NULL
		);
		CREATE TABLE recipient_interactions (
			mailbox_address TEXT NOT NULL,
			address TEXT NOT NULL,
			PRIMARY KEY (mailbox_address, address)
		);
		INSERT INTO folders VALUES
			('inbox', 'Inbox'), ('sent', 'Sent'), ('archive', 'Archive'),
			('draft', 'Drafts'), ('outbox', 'Outbox'), ('spam', 'Spam'),
			('trash', 'Trash'), ('snoozed', 'Snoozed'),
			('_cancelled_outbound', 'Retired'), ('custom', 'Customers');
	`);
	const migration = mailboxMigrations.find(
		(candidate) => candidate.name === "24_add_mail_people_projection",
	);
	assert.ok(migration);
	value.exec(migration.sql);
	let nextId = 0;
	const store = {
		sql: {
			exec(query: string, ...bindings: Array<string | number | null>) {
				return value.prepare(query).all(...bindings);
			},
		},
		transactionSync<T>(operation: () => T): T {
			value.exec("BEGIN");
			try {
				const result = operation();
				value.exec("COMMIT");
				return result;
			} catch (error) {
				value.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return {
		value,
		projector: createMailPeopleProjector({
			store,
			mailboxAddress: "team@example.com",
			now: () => "2026-07-12T12:00:00.000Z",
			personId: () => `person-${++nextId}`,
		}),
	};
}

function insertEmail(
	database: DatabaseSync,
	input: {
		id: string;
		folder: string;
		sender: string;
		recipient: string;
		cc?: string | null;
		bcc?: string | null;
		date: string;
		thread: string;
		origin: string | null;
		senderName?: string | null;
	},
) {
	database.prepare(`
		INSERT INTO emails (
			id, folder_id, subject, sender, recipient, cc, bcc, date, read,
			thread_id, recipient_memory_origin, sender_name
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
	`).run(
		input.id,
		input.folder,
		`Subject ${input.id}`,
		input.sender,
		input.recipient,
		input.cc ?? null,
		input.bcc ?? null,
		input.date,
		input.thread,
		input.origin,
		input.senderName ?? null,
	);
}

test("direct projection exposes exact mailbox-local inbound, outbound, imported, and role evidence", () => {
	const state = database();
	insertEmail(state.value, {
		id: "inbound-1",
		folder: "inbox",
		sender: "CLIENT@Example.com",
		recipient: "team@example.com",
		date: "2026-07-12T10:00:00.000Z",
		thread: "conversation-inbound",
		origin: "live_inbound",
		senderName: "  Client   Name  ",
	});
	insertEmail(state.value, {
		id: "outbound-1",
		folder: "sent",
		sender: "team@example.com",
		recipient: "client@example.com, other@example.net",
		cc: "client@example.com",
		bcc: "hidden@example.org",
		date: "2026-07-12T11:00:00.000Z",
		thread: "conversation-outbound",
		origin: "accepted_outbound",
	});
	insertEmail(state.value, {
		id: "imported-1",
		folder: "archive",
		sender: "archive@example.net",
		recipient: "team@example.com",
		date: "2025-01-01T08:00:00.000Z",
		thread: "conversation-imported",
		origin: "admin_import",
		senderName: "Archive Person",
	});
	for (const id of ["inbound-1", "outbound-1", "imported-1"]) {
		state.projector.projectMessage(id);
	}
	state.value.exec(`
		INSERT INTO people_projection_state VALUES (
			1, 1, 'ready', 0, 0, NULL, NULL, 3,
			'2026-07-12T12:00:00.000Z', '2026-07-12T12:00:00.000Z', NULL
		)
	`);

	const result = state.projector.listPeople({
		q: "",
		sort: "recent",
		limit: 50,
		cursor: null,
	});
	assert.equal(result.status, "ready");
	if (result.status !== "ready") return;
	assert.deepEqual(result.people.map((person) => ({
		address: person.address,
		displayName: person.displayName,
		nameProvenance: person.nameProvenance,
		receivedCount: person.receivedCount,
		sentCount: person.sentCount,
		importedMessageCount: person.importedMessageCount,
	})), [
		{
			address: "client@example.com",
			displayName: "Client Name",
			nameProvenance: "live",
			receivedCount: 1,
			sentCount: 1,
			importedMessageCount: 0,
		},
		{
			address: "hidden@example.org",
			displayName: null,
			nameProvenance: "none",
			receivedCount: 0,
			sentCount: 1,
			importedMessageCount: 0,
		},
		{
			address: "other@example.net",
			displayName: null,
			nameProvenance: "none",
			receivedCount: 0,
			sentCount: 1,
			importedMessageCount: 0,
		},
		{
			address: "archive@example.net",
			displayName: "Archive Person",
			nameProvenance: "imported",
			receivedCount: 1,
			sentCount: 0,
			importedMessageCount: 1,
		},
	]);
	assert.equal(result.people[0]?.conversationCount, 2);
	assert.equal(result.nextCursor, null);
	const clientId = result.people[0]!.id;
	const clientTimeline = state.projector.listPersonTimeline(clientId, { limit: 25, cursor: null });
	assert.equal(clientTimeline.status, "ready");
	if (clientTimeline.status === "ready") {
		assert.deepEqual(
			clientTimeline.items.map((item) => ({ messageId: item.messageId, role: item.role })),
			[
				{ messageId: "outbound-1", role: "to" },
				{ messageId: "inbound-1", role: "from" },
			],
		);
	}
	state.value.close();
});

test("projection includes only explicitly authoritative mail in eligible folders", () => {
	const state = database();
	const fixtures = [
		{ id: "inbox-live", folder: "inbox", origin: "live_inbound", eligible: true },
		{ id: "sent-accepted", folder: "sent", origin: "accepted_outbound", eligible: true },
		{ id: "archive-import", folder: "archive", origin: "admin_import", eligible: true },
		{ id: "snoozed-live", folder: "snoozed", origin: "live_inbound", eligible: true },
		{ id: "custom-live", folder: "custom", origin: "live_inbound", eligible: true },
		{ id: "draft", folder: "draft", origin: "live_inbound", eligible: false },
		{ id: "outbox", folder: "outbox", origin: "accepted_outbound", eligible: false },
		{ id: "retired", folder: "_cancelled_outbound", origin: "accepted_outbound", eligible: false },
		{ id: "spam", folder: "spam", origin: "live_inbound", eligible: false },
		{ id: "trash", folder: "trash", origin: "live_inbound", eligible: false },
		{ id: "failed", folder: "sent", origin: null, eligible: false },
		{ id: "unknown", folder: "inbox", origin: null, eligible: false },
	] as const;
	for (const fixture of fixtures) {
		insertEmail(state.value, {
			id: fixture.id,
			folder: fixture.folder,
			sender: fixture.origin === "accepted_outbound"
				? "team@example.com"
				: `${fixture.id}@example.com`,
			recipient: fixture.origin === "accepted_outbound"
				? `${fixture.id}@example.com`
				: "team@example.com",
			date: "2026-07-12T10:00:00.000Z",
			thread: `conversation-${fixture.id}`,
			origin: fixture.origin,
		});
		state.projector.projectMessage(fixture.id);
	}
	assert.deepEqual(
		state.value.prepare(`
			SELECT p.address FROM mail_people p
			JOIN mail_message_participants mp ON mp.person_id = p.id
			ORDER BY p.address
		`).all().map((row) => row.address),
		fixtures
			.filter((fixture) => fixture.eligible)
			.map((fixture) => `${fixture.id}@example.com`)
			.sort(),
	);
	state.value.close();
});

test("projection fails closed when one Message exceeds the participant bound", () => {
	const state = database();
	insertEmail(state.value, {
		id: "oversized-outbound",
		folder: "sent",
		sender: "team@example.com",
		recipient: Array.from({ length: 51 }, (_, index) => `person-${index}@example.com`).join(","),
		date: "2026-07-12T10:00:00.000Z",
		thread: "conversation-oversized",
		origin: "accepted_outbound",
	});
	state.projector.projectMessage("oversized-outbound");
	assert.equal(
		state.value.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total,
		0,
	);
	state.value.close();
});

test("backfill is bounded, newest-first, resumable, and becomes ready only after the complete scan", () => {
	const state = database();
	for (let index = 0; index < 120; index += 1) {
		insertEmail(state.value, {
			id: `message-${String(index).padStart(3, "0")}`,
			folder: "inbox",
			sender: `person-${index}@example.com`,
			recipient: "team@example.com",
			date: `2026-07-12T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`,
			thread: `conversation-${index}`,
			origin: index === 0 ? "admin_import" : "live_inbound",
			senderName: index === 0 ? "Historical Import" : null,
		});
	}

	const first = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.deepEqual(first, {
		status: "building",
		schemaVersion: 1,
		processedMessages: 100,
		retryAfterMs: 750,
	});
	const cursor = state.value.prepare(`
		SELECT backfill_date, backfill_message_id, status
		FROM people_projection_state WHERE id = 1
	`).get();
	assert.deepEqual(JSON.parse(JSON.stringify(cursor)), {
		backfill_date: "2026-07-12T00:20:00.000Z",
		backfill_message_id: "message-020",
		status: "building",
	});

	// This message lands after the immutable change-feed baseline and is newer
	// than the backfill cursor, so only replay can close the gap exactly once.
	insertEmail(state.value, {
		id: "created-during-backfill",
		folder: "inbox",
		sender: "new-during-backfill@example.com",
		recipient: "team@example.com",
		date: "2026-07-12T13:00:00.000Z",
		thread: "conversation-created-during-backfill",
		origin: "live_inbound",
	});
	state.value.prepare(
		"INSERT INTO mailbox_changes (resource, entity_id) VALUES ('message', 'created-during-backfill')",
	).run();

	const second = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.equal(second.status, "ready");
	assert.equal(
		state.value.prepare("SELECT processed_messages FROM people_projection_state").get()?.processed_messages,
		120,
	);
	assert.equal(
		state.value.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total,
		121,
	);
	assert.equal(
		state.value.prepare(
			"SELECT COUNT(*) AS total FROM mail_message_participants WHERE source_email_id = 'created-during-backfill'",
		).get()?.total,
		1,
	);
	assert.deepEqual(
		JSON.parse(JSON.stringify(state.value.prepare(`
			SELECT mp.origin, mp.observed_name
			FROM mail_message_participants mp
			JOIN mail_people p ON p.id = mp.person_id
			WHERE p.address = 'person-0@example.com'
		`).get())),
		{ origin: "admin_import", observed_name: "Historical Import" },
	);
	assert.equal(
		state.value.prepare("SELECT COUNT(*) AS total FROM recipient_interactions").get()?.total,
		0,
	);
	state.value.close();
});

test("list pagination is stable for recent, frequent, address, and filtered views", () => {
	const state = database();
	for (const input of [
		{ id: "a-1", address: "alpha@example.com", date: "2026-07-12T10:00:00.000Z", thread: "alpha-1" },
		{ id: "b-1", address: "beta@example.com", date: "2026-07-12T10:00:00.000Z", thread: "beta-1" },
		{ id: "b-2", address: "beta@example.com", date: "2026-07-12T09:00:00.000Z", thread: "beta-2" },
		{ id: "c-1", address: "charlie@other.net", date: "2026-07-12T08:00:00.000Z", thread: "charlie-1" },
	]) {
		insertEmail(state.value, {
			id: input.id,
			folder: "inbox",
			sender: input.address,
			recipient: "team@example.com",
			date: input.date,
			thread: input.thread,
			origin: "live_inbound",
		});
	}

	const addressesFor = (sort: "recent" | "frequent" | "address", q = "") => {
		const first = state.projector.listPeople({ q, sort, limit: 2, cursor: null });
		assert.equal(first.status, "ready");
		if (first.status !== "ready") return [];
		if (first.nextCursor === null) return first.people.map((person) => person.address);
		const second = state.projector.listPeople({ q, sort, limit: 2, cursor: first.nextCursor });
		assert.equal(second.status, "ready");
		if (second.status !== "ready") return [];
		assert.equal(second.nextCursor, null);
		return [...first.people, ...second.people].map((person) => person.address);
	};

	assert.deepEqual(addressesFor("recent"), [
		"alpha@example.com",
		"beta@example.com",
		"charlie@other.net",
	]);
	assert.deepEqual(addressesFor("frequent"), [
		"beta@example.com",
		"alpha@example.com",
		"charlie@other.net",
	]);
	assert.deepEqual(addressesFor("address"), [
		"alpha@example.com",
		"beta@example.com",
		"charlie@other.net",
	]);
	assert.deepEqual(addressesFor("address", "example.com"), [
		"alpha@example.com",
		"beta@example.com",
	]);
	state.value.close();
});

test("Unicode address ties paginate with one SQLite BINARY order for every sort", () => {
	const state = database();
	for (const [index, address] of [
		"z@example.com",
		"ä@example.com",
		"😀@example.com",
	].entries()) {
		insertEmail(state.value, {
			id: `unicode-${index}`,
			folder: "inbox",
			sender: address,
			recipient: "team@example.com",
			date: "2026-07-12T10:00:00.000Z",
			thread: `unicode-conversation-${index}`,
			origin: "live_inbound",
		});
	}

	for (const sort of ["recent", "frequent", "address"] as const) {
		const addresses: string[] = [];
		let cursor: string | null = null;
		do {
			const page = state.projector.listPeople({ q: "", sort, limit: 1, cursor });
			assert.equal(page.status, "ready");
			if (page.status !== "ready") break;
			addresses.push(...page.people.map((person) => person.address));
			cursor = page.nextCursor;
		} while (cursor);
		assert.deepEqual(addresses, [
			"z@example.com",
			"ä@example.com",
			"😀@example.com",
		]);
	}
	state.value.close();
});

test("ready reads replay more than one change page and reconcile Trash plus restore without stale evidence", () => {
	const state = database();
	insertEmail(state.value, {
		id: "message-1",
		folder: "inbox",
		sender: "person@example.com",
		recipient: "team@example.com",
		date: "2026-07-12T10:00:00.000Z",
		thread: "conversation-1",
		origin: "live_inbound",
	});
	const initial = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.equal(initial.status, "ready");

	state.value.prepare("UPDATE emails SET folder_id = 'trash' WHERE id = 'message-1'").run();
	state.value.prepare("INSERT INTO mailbox_changes (resource, entity_id) VALUES ('message', 'message-1')").run();
	const trashed = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.deepEqual(trashed, { status: "ready", people: [], nextCursor: null });

	state.value.prepare("UPDATE emails SET folder_id = 'inbox' WHERE id = 'message-1'").run();
	for (let index = 0; index < 101; index += 1) {
		state.value.prepare("INSERT INTO mailbox_changes (resource, entity_id) VALUES ('attachment', ?)")
			.run(`attachment-${index}`);
	}
	state.value.prepare("INSERT INTO mailbox_changes (resource, entity_id) VALUES ('message', 'message-1')").run();
	const catchingUp = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.equal(catchingUp.status, "building");
	const restored = state.projector.listPeople({ q: "", sort: "recent", limit: 50, cursor: null });
	assert.equal(restored.status, "ready");
	if (restored.status === "ready") {
		assert.deepEqual(restored.people.map((person) => person.address), ["person@example.com"]);
	}
	assert.equal(
		state.value.prepare("SELECT applied_change_sequence FROM people_projection_state").get()?.applied_change_sequence,
		103,
	);
	state.value.close();
});

test("projection fails closed on unsafe identities and canonicalizes bounded timeline presentation", () => {
	const state = database();
	insertEmail(state.value, {
		id: "unsafe-message",
		folder: "inbox",
		sender: "unsafe\u200B@example.com",
		recipient: "team@example.com",
		date: "not-a-date",
		thread: `conversation-${"x".repeat(400)}`,
		origin: "live_inbound",
		senderName: "Unsafe\u202EName",
	});
	state.projector.projectMessage("unsafe-message");
	assert.equal(
		state.value.prepare("SELECT COUNT(*) AS total FROM mail_message_participants").get()?.total,
		0,
	);

	insertEmail(state.value, {
		id: "safe-message",
		folder: "inbox",
		sender: "safe@example.com",
		recipient: "team@example.com",
		date: "2026-07-12T10:00:00.000Z",
		thread: "conversation-safe",
		origin: "live_inbound",
	});
	state.value.prepare("UPDATE emails SET subject = ? WHERE id = 'safe-message'")
		.run(`  Hello\u202E ${"x".repeat(1_100)}  `);
	state.value.prepare(`
		INSERT INTO attachments (id, email_id, filename, mimetype, size, disposition)
		VALUES
			('inline-1', 'safe-message', 'inline.png', 'image/png', 12, 'inline'),
			('file-1', 'safe-message', '  proposal\u200B.pdf  ', ' application/pdf ', 42, 'attachment')
	`).run();
	state.projector.projectMessage("safe-message");
	state.value.exec(`
		INSERT INTO people_projection_state VALUES (
			1, 1, 'ready', 0, 0, NULL, NULL, 1,
			'2026-07-12T12:00:00.000Z', '2026-07-12T12:00:00.000Z', NULL
		)
	`);
	const personId = String(state.value.prepare("SELECT id FROM mail_people WHERE address = 'safe@example.com'").get()?.id);
	const timeline = state.projector.listPersonTimeline(personId, { limit: 25, cursor: null });
	assert.equal(timeline.status, "ready");
	if (timeline.status === "ready") {
		assert.equal(timeline.items[0]?.subject.length, 1_000);
		assert.deepEqual(timeline.items[0]?.attachments, [{
			id: "file-1",
			filename: "proposal.pdf",
			mimetype: "application/pdf",
			size: 42,
		}]);
	}
	state.value.close();
});
