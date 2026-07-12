import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CONVERSATION_ACTIVITY_LABELS } from "../../shared/conversation-activity.ts";
import { readConversationActivityProjection } from "./conversation-activity.ts";

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		CREATE TABLE emails (
			id TEXT PRIMARY KEY,
			folder_id TEXT NOT NULL,
			thread_id TEXT
		);
		CREATE TABLE outbound_deliveries (
			id TEXT PRIMARY KEY,
			email_id TEXT NOT NULL
		);
		CREATE TABLE activity_events (
			id TEXT PRIMARY KEY,
			actor_kind TEXT NOT NULL,
			actor_id TEXT,
			action TEXT NOT NULL,
			entity_type TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			metadata_json TEXT,
			occurred_at TEXT NOT NULL
		);
	`);
	return {
		database,
		sql: {
			exec<T extends Record<string, ArrayBuffer | string | number | null>>(
				query: string,
				...bindings: (ArrayBuffer | string | number | null)[]
			) {
				return database.prepare(query).all(...bindings) as T[];
			},
		},
	};
}

function insertEvent(
	database: DatabaseSync,
	input: {
		id: string;
		action: string;
		entityType: string;
		entityId: string;
		metadata?: unknown;
		actorKind?: string;
		actorId?: string | null;
		occurredAt?: string;
	},
) {
	database.prepare(
		`INSERT INTO activity_events
		 (id, actor_kind, actor_id, action, entity_type, entity_id, metadata_json, occurred_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.actorKind ?? "user",
		input.actorId === undefined ? "user-1" : input.actorId,
		input.action,
		input.entityType,
		input.entityId,
		typeof input.metadata === "string"
			? input.metadata
			: JSON.stringify(input.metadata ?? {}),
		input.occurredAt ?? "2026-07-12T10:00:00.000Z",
	);
}

function cursorWithId(id: string): string {
	return Buffer.from(JSON.stringify({
		version: 1,
		occurredAt: "2026-07-12T10:00:00.000Z",
		id,
	})).toString("base64url");
}

test("canonical scope includes Message, thread, Conversation, and authoritative delivery events only", () => {
	const { database, sql } = fixture();
	const insertEmail = database.prepare("INSERT INTO emails VALUES (?, ?, ?)");
	insertEmail.run("root", "inbox", null);
	insertEmail.run("reply", "inbox", "root");
	insertEmail.run("sent", "sent", "root");
	insertEmail.run("other", "inbox", "other-thread");
	database.prepare("INSERT INTO outbound_deliveries VALUES (?, ?)").run("delivery-root", "sent");
	database.prepare("INSERT INTO outbound_deliveries VALUES (?, ?)").run("delivery-other", "other");

	insertEvent(database, {
		id: "event-message",
		action: "email_updated",
		entityType: "email",
		entityId: "reply",
		metadata: { read: true },
	});
	insertEvent(database, {
		id: "event-thread",
		action: "thread_marked_read",
		entityType: "thread",
		entityId: "root",
	});
	insertEvent(database, {
		id: "event-conversation",
		action: "conversation_archived",
		entityType: "conversation",
		entityId: "root",
	});
	insertEvent(database, {
		id: "event-custom-move",
		action: "email_moved",
		entityType: "conversation",
		entityId: "root",
		metadata: { fromFolderId: "inbox", toFolderId: "projects", affectedCount: 2 },
		actorKind: "rule",
		actorId: "rule-1",
	});
	insertEvent(database, {
		id: "event-delivery",
		action: "outbound_enqueued",
		entityType: "outbound_delivery",
		entityId: "delivery-root",
		metadata: { emailId: "sent", providerSecret: "must-not-leak" },
		actorKind: "mcp",
	});
	insertEvent(database, {
		id: "event-other-message",
		action: "email_trashed",
		entityType: "email",
		entityId: "other",
	});
	insertEvent(database, {
		id: "event-other-delivery",
		action: "outbound_cancelled",
		entityType: "outbound_delivery",
		entityId: "delivery-other",
	});
	insertEvent(database, {
		id: "event-global",
		action: "label_applied",
		entityType: "label",
		entityId: "secret-label",
		metadata: { labelId: "secret-label", affectedCount: 1 },
	});

	const result = readConversationActivityProjection(sql, {
		emailId: "reply",
		limit: 50,
		cursor: null,
	});
	assert.equal(result.state, "ready");
	if (result.state !== "ready") return;
	assert.deepEqual(
		new Set(result.items.map((item) => item.id)),
		new Set([
			"event-message",
			"event-thread",
			"event-conversation",
			"event-custom-move",
			"event-delivery",
		]),
	);
	assert.equal(
		result.items.find((item) => item.id === "event-custom-move")?.code,
		"moved",
	);
	assert.equal(
		result.items.find((item) => item.id === "event-delivery")?.code,
		"send_queued",
	);
	assert.ok(result.items.every((item) => item.label === CONVERSATION_ACTIVITY_LABELS[item.code]));
	assert.doesNotMatch(JSON.stringify(result), /providerSecret|secret-label|metadata/i);
	database.close();
});

test("unknown, malformed, deleted-row, and ambiguous events are omitted", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	insertEvent(database, {
		id: "unknown",
		action: "attachment_cleanup_queued",
		entityType: "email",
		entityId: "root",
	});
	insertEvent(database, {
		id: "malformed-json",
		action: "email_updated",
		entityType: "email",
		entityId: "root",
		metadata: "not-json",
	});
	insertEvent(database, {
		id: "ambiguous-update",
		action: "email_updated",
		entityType: "email",
		entityId: "root",
		metadata: { read: true, starred: true },
	});
	insertEvent(database, {
		id: "deleted-row",
		action: "draft_updated",
		entityType: "email",
		entityId: "deleted",
	});
	insertEvent(database, {
		id: "valid",
		action: "email_updated",
		entityType: "email",
		entityId: "root",
		metadata: {
			starred: true,
			automationRunId: "automation:message-1",
			ruleVersion: 2,
		},
		actorKind: "rule",
		actorId: "rule-1",
	});
	const result = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 50,
		cursor: null,
	});
	assert.equal(result.state, "ready");
	if (result.state === "ready") {
		assert.deepEqual(result.items.map((item) => item.id), ["valid"]);
	}
	database.close();
});

test("pagination is opaque, deterministic for same-time events, stable, and bounded to fifty", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	for (let index = 0; index < 65; index++) {
		insertEvent(database, {
			id: `event-${String(index).padStart(2, "0")}`,
			action: "thread_marked_read",
			entityType: "thread",
			entityId: "root",
			actorKind: "system",
			actorId: null,
		});
	}
	const first = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 50,
		cursor: null,
	});
	assert.equal(first.state, "ready");
	if (first.state !== "ready") return;
	assert.equal(first.items.length, 50);
	assert.deepEqual(
		first.items.slice(0, 3).map((item) => item.id),
		["event-64", "event-63", "event-62"],
	);
	assert.match(first.nextCursor ?? "", /^[A-Za-z0-9_-]+$/);
	assert.doesNotMatch(first.nextCursor ?? "", /event|2026/);
	const second = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 50,
		cursor: first.nextCursor,
	});
	assert.equal(second.state, "ready");
	if (second.state !== "ready") return;
	assert.equal(second.items.length, 15);
	assert.equal(second.nextCursor, null);
	assert.equal(
		new Set([...first.items, ...second.items].map((item) => item.id)).size,
		65,
	);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "root",
			limit: 50,
			cursor: first.nextCursor,
		}),
		second,
	);
	database.close();
});

test("an overlong canonical thread key is rejected instead of scoping by a truncated prefix", () => {
	const { database, sql } = fixture();
	const prefix = "t".repeat(300);
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(
		"selected",
		"inbox",
		`${prefix}-private-suffix`,
	);
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(prefix, "inbox", null);
	insertEvent(database, {
		id: "prefix-event",
		action: "email_updated",
		entityType: "email",
		entityId: prefix,
		metadata: { read: true },
	});

	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "selected",
			limit: 25,
			cursor: null,
		}),
		{ state: "not_found" },
	);
	database.close();
});

test("non-canonical stored thread keys cannot scope to trimmed or NFC-normalized rows", () => {
	for (const [storedThreadId, unrelatedCanonicalId] of [
		[" canonical-thread ", "canonical-thread"],
		["cafe\u0301-thread", "caf\u00e9-thread"],
	] as const) {
		const { database, sql } = fixture();
		database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(
			"selected",
			"inbox",
			storedThreadId,
		);
		database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run(
			unrelatedCanonicalId,
			"inbox",
			null,
		);
		insertEvent(database, {
			id: "unrelated-event",
			action: "email_updated",
			entityType: "email",
			entityId: unrelatedCanonicalId,
			metadata: { read: true },
		});

		assert.deepEqual(
			readConversationActivityProjection(sql, {
				emailId: "selected",
				limit: 25,
				cursor: null,
			}),
			{ state: "not_found" },
		);
		database.close();
	}
});

test("overlong same-time event IDs cannot collide or corrupt cursor progress", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	const sharedPrefix = "x".repeat(200);
	for (const suffix of ["-one", "-two"]) {
		insertEvent(database, {
			id: `${sharedPrefix}${suffix}`,
			action: "thread_marked_read",
			entityType: "thread",
			entityId: "root",
		});
	}
	for (const id of ["valid-b", "valid-a"]) {
		insertEvent(database, {
			id,
			action: "thread_marked_read",
			entityType: "thread",
			entityId: "root",
		});
	}

	const first = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 1,
		cursor: null,
	});
	assert.equal(first.state, "ready");
	if (first.state !== "ready") return;
	assert.deepEqual(first.items.map((item) => item.id), ["valid-b"]);
	assert.ok(first.nextCursor);

	const second = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 1,
		cursor: first.nextCursor,
	});
	assert.equal(second.state, "ready");
	if (second.state !== "ready") return;
	assert.deepEqual(second.items.map((item) => item.id), ["valid-a"]);
	assert.equal(second.nextCursor, null);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "root",
			limit: 1,
			cursor: first.nextCursor,
		}),
		second,
	);
	database.close();
});

test("padded and NFD event IDs cannot collapse or skip same-time cursor progress", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	for (const id of ["z-event ", "z\u0301-event", "valid-b", "valid-a"]) {
		insertEvent(database, {
			id,
			action: "thread_marked_read",
			entityType: "thread",
			entityId: "root",
		});
	}

	const first = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 1,
		cursor: null,
	});
	assert.equal(first.state, "ready");
	if (first.state !== "ready") return;
	assert.deepEqual(first.items.map((item) => item.id), ["valid-b"]);
	assert.ok(first.nextCursor);

	const second = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 1,
		cursor: first.nextCursor,
	});
	assert.equal(second.state, "ready");
	if (second.state !== "ready") return;
	assert.deepEqual(second.items.map((item) => item.id), ["valid-a"]);
	assert.equal(second.nextCursor, null);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "root",
			limit: 1,
			cursor: first.nextCursor,
		}),
		second,
	);
	database.close();
});

test("metadata larger than 4096 characters is omitted instead of parsed from a truncated prefix", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	insertEvent(database, {
		id: "oversized-metadata",
		action: "email_updated",
		entityType: "email",
		entityId: "root",
		metadata: `${JSON.stringify({ read: true })}${" ".repeat(5_000)}`,
	});
	insertEvent(database, {
		id: "valid-metadata",
		action: "email_updated",
		entityType: "email",
		entityId: "root",
		metadata: { read: false },
	});

	const result = readConversationActivityProjection(sql, {
		emailId: "root",
		limit: 25,
		cursor: null,
	});
	assert.equal(result.state, "ready");
	if (result.state === "ready") {
		assert.deepEqual(result.items.map((item) => item.id), ["valid-metadata"]);
	}
	database.close();
});

test("invalid cursors, bounds, missing anchors, and internal anchors fail closed before event reads", () => {
	const { database, sql } = fixture();
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("root", "inbox", null);
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("caf\u00e9", "inbox", null);
	database.prepare("INSERT INTO emails VALUES (?, ?, ?)").run("internal", "_cancelled_outbound", null);
	for (const emailId of [" root ", "cafe\u0301"]) {
		assert.deepEqual(
			readConversationActivityProjection(sql, {
				emailId,
				limit: 25,
				cursor: null,
			}),
			{ state: "not_found" },
		);
	}
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "missing",
			limit: 25,
			cursor: null,
		}),
		{ state: "not_found" },
	);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "internal",
			limit: 25,
			cursor: null,
		}),
		{ state: "not_found" },
	);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "internal",
			limit: 51,
			cursor: null,
		}),
		{ state: "invalid_request" },
	);
	assert.deepEqual(
		readConversationActivityProjection(sql, {
			emailId: "root",
			limit: 25,
			cursor: "bm90LWEtY3Vyc29y",
		}),
		{ state: "invalid_cursor" },
	);
	for (const id of [" padded-event ", "e\u0301vent"]) {
		assert.deepEqual(
			readConversationActivityProjection(sql, {
				emailId: "root",
				limit: 25,
				cursor: cursorWithId(id),
			}),
			{ state: "invalid_cursor" },
		);
	}
	database.close();
});
