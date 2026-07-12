import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
	readRecipientSuggestions,
	recordRecipientInteractions,
	seedRecipientInteractions,
} from "./recipient-memory.ts";

function database() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (
			id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, sender TEXT,
			recipient TEXT, cc TEXT, bcc TEXT, date TEXT,
			recipient_memory_origin TEXT CHECK(
				recipient_memory_origin IN ('live_inbound', 'accepted_outbound', 'admin_import')
			)
		);
		CREATE TABLE recipient_interactions (
			source_email_id TEXT NOT NULL,
			address TEXT NOT NULL COLLATE NOCASE,
			direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
			occurred_at TEXT NOT NULL,
			PRIMARY KEY(source_email_id, address, direction),
			FOREIGN KEY(source_email_id) REFERENCES emails(id) ON DELETE CASCADE
		);
		CREATE INDEX idx_recipient_interactions_address
			ON recipient_interactions(address, direction, occurred_at DESC);
		CREATE INDEX idx_recipient_interactions_occurred
			ON recipient_interactions(occurred_at DESC, address);
		CREATE TABLE recipient_interaction_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	return {
		db,
		sql: {
			exec<T>(
				query: string,
				...bindings: Array<string | number | null>
			) {
				return db.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

function email(
	db: DatabaseSync,
	input: {
		id: string;
		folder?: string;
		sender: string;
		to?: string;
		cc?: string;
		bcc?: string;
		date: string;
		origin?: "live_inbound" | "accepted_outbound" | "admin_import";
	},
) {
	db.prepare(`INSERT INTO emails
		(id, folder_id, sender, recipient, cc, bcc, date, recipient_memory_origin)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			input.id,
			input.folder ?? "inbox",
			input.sender,
			input.to ?? "team@example.com",
			input.cc ?? null,
			input.bcc ?? null,
			input.date,
			input.origin ?? null,
		);
}

test("recipient interactions normalize, exclude self and invalid addresses, and stay idempotent", () => {
	const { db, sql } = database();
	email(db, {
		id: "sent-1",
		folder: "sent",
		sender: "team@example.com",
		date: "2026-07-10T10:00:00.000Z",
	});
	const input = {
		sourceEmailId: "sent-1",
		direction: "sent" as const,
		occurredAt: "2026-07-10T10:00:00.000Z",
		mailboxAddress: "team@example.com",
		addresses: [
			" Alice@Example.com ",
			"alice@example.com",
			"team@example.com",
			"not-an-address",
		],
	};
	assert.equal(recordRecipientInteractions(sql, input), 1);
	assert.equal(recordRecipientInteractions(sql, input), 0);
	assert.deepEqual(
		db.prepare("SELECT address, direction FROM recipient_interactions").all()
			.map((row) => ({ ...row })),
		[{ address: "alice@example.com", direction: "sent" }],
	);
	db.close();
});

test("recipient interaction writes reject more than 50 unique recipients", () => {
	const { db, sql } = database();
	email(db, {
		id: "sent-many",
		folder: "sent",
		sender: "team@example.com",
		date: "2026-07-10T10:00:00.000Z",
	});
	assert.throws(
		() => recordRecipientInteractions(sql, {
			sourceEmailId: "sent-many",
			direction: "sent",
			occurredAt: "2026-07-10T10:00:00.000Z",
			mailboxAddress: "team@example.com",
			addresses: Array.from(
				{ length: 51 },
				(_, index) => `person-${index + 1}@example.com`,
			),
		}),
		/A message cannot contain more than 50 recipients/,
	);
	assert.equal(
		(db.prepare("SELECT COUNT(*) AS count FROM recipient_interactions").get() as {
			count: number;
		}).count,
		0,
	);
	db.close();
});

test("recipient suggestions rank exact, prefix, recent sent, frequency, recent received, then address", () => {
	const { db, sql } = database();
	const interactions = [
		["exact", "al@example.com", "sent", "2026-01-01T00:00:00.000Z"],
		["recent", "alex@example.com", "sent", "2026-07-10T00:00:00.000Z"],
		["frequent-1", "alice@example.com", "sent", "2026-07-09T00:00:00.000Z"],
		["frequent-2", "alice@example.com", "received", "2026-07-08T00:00:00.000Z"],
		["received", "ally@example.com", "received", "2026-07-11T00:00:00.000Z"],
	] as const;
	for (const [id, address, direction, at] of interactions) {
		email(db, { id, sender: address, date: at });
		recordRecipientInteractions(sql, {
			sourceEmailId: id,
			direction,
			occurredAt: at,
			mailboxAddress: "team@example.com",
			addresses: [address],
		});
	}
	assert.deepEqual(
		readRecipientSuggestions(sql, "team@example.com", "al", 20).map(
			(suggestion) => suggestion.address,
		),
		["alex@example.com", "alice@example.com", "al@example.com", "ally@example.com"],
	);
	assert.deepEqual(
		readRecipientSuggestions(sql, "team@example.com", "al@example.com", 20)
			.map((suggestion) => suggestion.address),
		["al@example.com"],
	);
	db.close();
});

test("recipient seed learns outbound recipients and inbound senders from eligible mail only once", () => {
	const { db, sql } = database();
	email(db, {
		id: "outbound",
		folder: "archive",
		sender: "team@example.com",
		to: "Alice@Example.com, team@example.com",
		cc: "copy@example.com",
		bcc: "blind@example.com",
		date: "2026-07-11T10:00:00.000Z",
		origin: "accepted_outbound",
	});
	email(db, {
		id: "inbound",
		folder: "snoozed",
		sender: "sender@example.com",
		to: "team@example.com, unrelated@example.com",
		cc: "also-unrelated@example.com",
		date: "2026-07-10T10:00:00.000Z",
		origin: "live_inbound",
	});
	for (const folder of ["draft", "outbox", "_cancelled_outbound", "spam", "trash"]) {
		email(db, {
			id: `excluded-${folder}`,
			folder,
			sender: `excluded-${folder}@example.com`,
			date: "2026-07-09T10:00:00.000Z",
		});
	}
	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: true,
		interactionCount: 4,
	});
	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: false,
		interactionCount: 0,
	});
	assert.deepEqual(
		db.prepare("SELECT address, direction FROM recipient_interactions ORDER BY address").all()
			.map((row) => ({ ...row })),
		[
			{ address: "alice@example.com", direction: "sent" },
			{ address: "blind@example.com", direction: "sent" },
			{ address: "copy@example.com", direction: "sent" },
			{ address: "sender@example.com", direction: "received" },
		],
	);
	db.close();
});

test("recipient seed fails closed for legacy and admin imports before and after first seed", () => {
	const { db, sql } = database();
	email(db, {
		id: "legacy-ambiguous",
		folder: "inbox",
		sender: "legacy@example.com",
		date: "2026-07-11T09:00:00.000Z",
	});
	email(db, {
		id: "import-before",
		folder: "archive",
		sender: "import-before@example.com",
		date: "2026-07-11T10:00:00.000Z",
		origin: "admin_import",
	});
	email(db, {
		id: "live-before",
		folder: "inbox",
		sender: "live-before@example.com",
		date: "2026-07-11T11:00:00.000Z",
		origin: "live_inbound",
	});
	email(db, {
		id: "accepted-before",
		folder: "sent",
		sender: "team@example.com",
		to: "accepted-before@example.com",
		date: "2026-07-11T12:00:00.000Z",
		origin: "accepted_outbound",
	});

	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: true,
		interactionCount: 2,
	});
	assert.deepEqual(
		readRecipientSuggestions(sql, "team@example.com", "", 20).map(({ address }) => address),
		["accepted-before@example.com", "live-before@example.com"],
	);

	email(db, {
		id: "import-after",
		folder: "inbox",
		sender: "import-after@example.com",
		date: "2026-07-11T13:00:00.000Z",
		origin: "admin_import",
	});
	email(db, {
		id: "live-after",
		folder: "inbox",
		sender: "live-after@example.com",
		date: "2026-07-11T14:00:00.000Z",
		origin: "live_inbound",
	});
	recordRecipientInteractions(sql, {
		sourceEmailId: "live-after",
		direction: "received",
		occurredAt: "2026-07-11T14:00:00.000Z",
		mailboxAddress: "team@example.com",
		addresses: ["live-after@example.com"],
	});
	email(db, {
		id: "accepted-after",
		folder: "sent",
		sender: "team@example.com",
		to: "accepted-after@example.com",
		date: "2026-07-11T15:00:00.000Z",
		origin: "accepted_outbound",
	});
	recordRecipientInteractions(sql, {
		sourceEmailId: "accepted-after",
		direction: "sent",
		occurredAt: "2026-07-11T15:00:00.000Z",
		mailboxAddress: "team@example.com",
		addresses: ["accepted-after@example.com"],
	});
	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: false,
		interactionCount: 0,
	});
	assert.deepEqual(
		readRecipientSuggestions(sql, "team@example.com", "import", 20),
		[],
	);
	assert.deepEqual(
		readRecipientSuggestions(sql, "team@example.com", "", 20).map(({ address }) => address),
		[
			"accepted-after@example.com",
			"accepted-before@example.com",
			"live-after@example.com",
			"live-before@example.com",
		],
	);
	db.close();
});

test("recipient seed has a hard 2,000 normalized interaction cap", () => {
	const { db, sql } = database();
	const insert = db.prepare(`INSERT INTO emails
		(id, folder_id, sender, recipient, cc, bcc, date, recipient_memory_origin)
		VALUES (?, 'inbox', ?, 'team@example.com', NULL, NULL, ?, 'live_inbound')`);
	db.exec("BEGIN");
	for (let index = 0; index < 2_001; index += 1) {
		insert.run(
			`mail-${index}`,
			`sender-${index}@example.com`,
			new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		);
	}
	db.exec("COMMIT");
	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: true,
		interactionCount: 2_000,
	});
	assert.equal(
		(db.prepare("SELECT COUNT(*) AS count FROM recipient_interactions").get() as {
			count: number;
		}).count,
		2_000,
	);
	db.close();
});

test("recipient seed truncates an oversized authoritative recipient list without bricking memory", () => {
	const { db, sql } = database();
	email(db, {
		id: "legacy-many",
		folder: "sent",
		sender: "team@example.com",
		to: Array.from(
			{ length: 51 },
			(_, index) => `legacy-${index + 1}@example.com`,
		).join(", "),
		date: "2026-07-10T10:00:00.000Z",
		origin: "accepted_outbound",
	});
	assert.deepEqual(seedRecipientInteractions(sql, "team@example.com"), {
		seeded: true,
		interactionCount: 50,
	});
	db.close();
});
