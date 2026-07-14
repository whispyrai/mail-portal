import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
	currentAgentActorSessionVersion,
	hasExactLiveMailboxAccess,
	isAgentMailboxActive,
	listExactLiveMailboxes,
	listStableLiveMailboxes,
} from "./live-mailbox-authorization.ts";
import { mcpCredentialSessionVersion } from "./mcp-authorization.ts";

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
		return {
			success: true,
			results: this.statement().all(...this.#values) as T[],
		};
	}
	private statement(): StatementSync {
		return this.#db.prepare(this.#sql);
	}
}

function fixture() {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
	]) {
		db.exec(readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"));
	}
	db.prepare(
		`INSERT INTO users
		   (id, email, password_hash, password_salt, session_version, role, is_active,
		    mailbox_address, created_at, updated_at)
		 VALUES ('user-1', 'one@example.com', 'hash', 'salt', 7, 'AGENT', 1,
		         'one@example.com', 1, 1)`,
	).run();
	db.prepare(
		`INSERT INTO mailboxes
		   (id, address, type, owner_user_id, is_active, created_at, updated_at)
		 VALUES ('one@example.com', 'one@example.com', 'PERSONAL', 'user-1', 1, 1, 1),
		        ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1)`,
	).run();
	db.prepare(
		"INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at) VALUES ('team@example.com', 'user-1', 1)",
	).run();
	const env = {
		DB: {
			prepare(sql: string) {
				return new Statement(db, sql);
			},
		},
	} as unknown as Env;
	return { db, env };
}

test("live mailbox authorization reads the current generation only for active grants", async () => {
	const { db, env } = fixture();
	assert.equal(
		await hasExactLiveMailboxAccess(env, "TEAM@EXAMPLE.COM", "user-1", 7),
		true,
	);
	assert.equal(
		await hasExactLiveMailboxAccess(env, "team@example.com", "user-1", 6),
		false,
	);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "user-1", 7)).map((mailbox) => mailbox.id),
		["one@example.com", "team@example.com"],
	);
	assert.equal(await currentAgentActorSessionVersion(env, "TEAM@EXAMPLE.COM", "user-1"), 7);
	db.prepare(
		"DELETE FROM mailbox_memberships WHERE mailbox_id = 'team@example.com' AND user_id = 'user-1'",
	).run();
	assert.equal(
		await hasExactLiveMailboxAccess(env, "team@example.com", "user-1", 7),
		false,
	);
	assert.deepEqual(
		(await listExactLiveMailboxes(env, "user-1", 7)).map((mailbox) => mailbox.id),
		["one@example.com"],
	);
	assert.equal(await currentAgentActorSessionVersion(env, "team@example.com", "user-1"), null);
	db.prepare("UPDATE users SET is_active = 0 WHERE id = 'user-1'").run();
	assert.equal(await currentAgentActorSessionVersion(env, "one@example.com", "user-1"), null);
	db.close();
});

test("stable mailbox rosters suppress access removed during the read", async () => {
	const mailbox = {
		id: "team@example.com",
		address: "team@example.com",
		type: "SHARED" as const,
		owner_user_id: null,
		is_active: 1,
		created_at: 1,
		updated_at: 1,
	};
	let reads = 0;
	assert.deepEqual(
		await listStableLiveMailboxes(
			{} as never,
			"user-1",
			7,
			async () => (reads += 1) === 1 ? [mailbox] : [],
		),
		[],
	);
	assert.equal(reads, 2);
});

test("legacy generation-one MCP grants retain exact live mail access", async () => {
	const { db, env } = fixture();
	db.prepare("UPDATE users SET session_version = 1 WHERE id = 'user-1'").run();
	assert.equal(
		await hasExactLiveMailboxAccess(
			env,
			"team@example.com",
			"user-1",
			mcpCredentialSessionVersion({}),
		),
		true,
	);
	assert.deepEqual(
		(
			await listExactLiveMailboxes(
				env,
				"user-1",
				mcpCredentialSessionVersion({}),
			)
		).map((mailbox) => mailbox.id),
		["one@example.com", "team@example.com"],
	);
	db.close();
});

test("mailbox reconciliation preserves only active mailboxes", async () => {
	const { db, env } = fixture();
	assert.equal(await isAgentMailboxActive(env, "TEAM@EXAMPLE.COM"), true);
	db.prepare("UPDATE mailboxes SET is_active = 0 WHERE id = 'team@example.com'").run();
	assert.equal(await isAgentMailboxActive(env, "team@example.com"), false);
	assert.equal(await isAgentMailboxActive(env, "missing@example.com"), false);
	db.close();
});
