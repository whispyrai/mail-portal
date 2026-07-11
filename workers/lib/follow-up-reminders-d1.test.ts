import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { followUpReminderD1Store } from "./follow-up-reminders-d1.ts";
import {
	FollowUpReminderError,
	createFollowUpReminderService,
} from "./follow-up-reminders.ts";

const NOW = Date.parse("2026-07-11T12:00:00.000Z");
const MAILBOX = "support@example.com";

class Statement {
	#values: unknown[] = [];
	readonly #db: DatabaseSync;
	readonly #sql: string;

	constructor(db: DatabaseSync, sql: string) {
		this.#db = db;
		this.#sql = sql;
	}

	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}

	async first<T>() {
		return (this.statement().get(...this.#values) as T | undefined) ?? null;
	}

	async all<T>() {
		return { success: true, results: this.statement().all(...this.#values) as T[] };
	}

	async run() {
		return this.runSync();
	}

	runSync() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}

	private statement(): StatementSync {
		return this.#db.prepare(this.#sql);
	}
}

function d1(db: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			return new Statement(db, sql);
		},
		async batch(statements: D1PreparedStatement[]) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const results = statements.map((statement) =>
					(statement as unknown as Statement).runSync());
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0008_create_follow_up_reminders.sql",
	]) {
		db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
	}
	db.prepare(
		`INSERT INTO users
		 (id, email, password_hash, password_salt, role, is_active, mailbox_address, created_at, updated_at)
		 VALUES ('user-1', 'one@example.com', 'hash', 'salt', 'AGENT', 1, 'one@example.com', 1, 1),
		        ('user-2', 'two@example.com', 'hash', 'salt', 'AGENT', 1, 'two@example.com', 1, 1)`,
	).run();
	db.prepare(
		`INSERT INTO mailboxes (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES (?, ?, 'SHARED', NULL, 1, 1, 1)`,
	).run(MAILBOX, MAILBOX);
	db.prepare(
		`INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
		 VALUES (?, 'user-1', 1), (?, 'user-2', 1)`,
	).run(MAILBOX, MAILBOX);
	const store = followUpReminderD1Store({ DB: d1(db) } as Pick<Env, "DB">);
	let sequence = 0;
	let timestamp = NOW;
	const service = createFollowUpReminderService({
		store,
		canAccessMailbox: async () => true,
		resolveReminderAnchor: async (_mailboxAddress, emailId) => ({
			conversationKey: "thread-1",
			baselineMessageId: emailId,
			baselineMessageDate: "2026-07-11T10:00:00.000Z",
		}),
		now: () => timestamp,
		id: () => `reminder-${++sequence}`,
	});
	return {
		db,
		store,
		service,
		advance(ms = 1) {
			timestamp += ms;
		},
	};
}

const createInput = {
	emailId: "message-1",
	remindAt: "2026-07-12T09:00:00.000Z",
	idempotencyKey: "create-reminder-1",
};

test("D1 reminder store preserves owner scope, create idempotency, and active uniqueness", async () => {
	const { db, service } = fixture();
	const created = await service.create("user-1", MAILBOX, createInput);
	assert.equal((await service.list("user-1", MAILBOX)).length, 1);
	assert.equal((await service.list("user-2", MAILBOX)).length, 0);
	assert.deepEqual(await service.create("user-1", MAILBOX, createInput), created);
	await assert.rejects(
		() => service.create("user-1", MAILBOX, { ...createInput, remindAt: "2026-07-13T09:00:00.000Z" }),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "IDEMPOTENCY_CONFLICT",
	);
	await assert.rejects(
		() => service.create("user-1", MAILBOX, { ...createInput, idempotencyKey: "create-reminder-2" }),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "ACTIVE_CONFLICT",
	);
	db.close();
});

test("D1 mutation ledger replays the immutable result after a later mutation", async () => {
	const { db, service, advance } = fixture();
	const created = await service.create("user-1", MAILBOX, createInput);
	advance();
	const snoozed = await service.apply("user-1", MAILBOX, created.id, {
		action: "snooze",
		operationId: "snooze-reminder-1",
		expectedVersion: 1,
		remindAt: "2026-07-14T09:00:00.000Z",
	});
	advance();
	const completed = await service.apply("user-1", MAILBOX, created.id, {
		action: "complete",
		operationId: "complete-reminder-1",
		expectedVersion: 2,
	});
	assert.equal(completed.state, "completed");
	const replay = await service.apply("user-1", MAILBOX, created.id, {
		action: "snooze",
		operationId: "snooze-reminder-1",
		expectedVersion: 1,
		remindAt: "2026-07-14T09:00:00.000Z",
	});
	assert.deepEqual(replay, snoozed);
	assert.equal(replay.state, "active");
	assert.equal(replay.version, 2);
	assert.deepEqual(
		await service.create("user-1", MAILBOX, createInput),
		created,
	);
	db.close();
});

test("D1 mutations fail closed for cross-owner and stale requests", async () => {
	const { db, service } = fixture();
	const created = await service.create("user-1", MAILBOX, createInput);
	await assert.rejects(
		() => service.apply("user-2", MAILBOX, created.id, {
			action: "dismiss",
			operationId: "dismiss-other-user",
			expectedVersion: 1,
		}),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "NOT_FOUND",
	);
	await service.apply("user-1", MAILBOX, created.id, {
		action: "snooze",
		operationId: "snooze-owner-user",
		expectedVersion: 1,
		remindAt: "2026-07-14T09:00:00.000Z",
	});
	await assert.rejects(
		() => service.apply("user-1", MAILBOX, created.id, {
			action: "dismiss",
			operationId: "dismiss-stale-version",
			expectedVersion: 1,
		}),
		(error: unknown) => error instanceof FollowUpReminderError && error.code === "STATE_CONFLICT",
	);
	db.close();
});

test("D1 inbound completion rechecks conversation identity and baseline time in the write", async () => {
	const { db, store, service } = fixture();
	await service.create("user-1", MAILBOX, createInput);
	assert.equal(await store.completeForInboundReply({
		mailboxAddress: MAILBOX,
		conversationKey: "different-thread",
		inboundMessageId: "message-2",
		inboundMessageDate: "2026-07-11T13:00:00.000Z",
		occurredAt: NOW + 1,
	}), 0);
	assert.equal(await store.completeForInboundReply({
		mailboxAddress: MAILBOX,
		conversationKey: "thread-1",
		inboundMessageId: "message-2",
		inboundMessageDate: "2026-07-11T09:00:00.000Z",
		occurredAt: NOW + 2,
	}), 0);
	const completed = await store.completeForInboundReply({
		mailboxAddress: MAILBOX,
		conversationKey: "thread-1",
		inboundMessageId: "message-2",
		inboundMessageDate: "2026-07-11T13:00:00.000Z",
		occurredAt: NOW + 3,
	});
	assert.equal(completed, 1);
	db.close();
});

test("D1 inbound completion atomically excludes revoked and inactive owners", async () => {
	const { db, store, service } = fixture();
	await service.create("user-1", MAILBOX, createInput);
	await service.create("user-2", MAILBOX, {
		...createInput,
		emailId: "message-2",
		idempotencyKey: "create-reminder-user-2",
	});
	db.prepare(
		"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = 'user-2'",
	).run(MAILBOX);
	const completed = await store.completeForInboundReply({
		mailboxAddress: MAILBOX,
		conversationKey: "thread-1",
		inboundMessageId: "message-3",
		inboundMessageDate: "2026-07-11T13:00:00.000Z",
		occurredAt: NOW + 1,
	});
	assert.equal(completed, 1);
	assert.equal(
		db.prepare("SELECT state FROM follow_up_reminders WHERE owner_user_id = 'user-1'").get()!.state,
		"completed",
	);
	assert.equal(
		db.prepare("SELECT state FROM follow_up_reminders WHERE owner_user_id = 'user-2'").get()!.state,
		"active",
	);
	db.close();
});
