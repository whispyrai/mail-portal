import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("every subscription rebind advances its fence while only capability change resets health", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	const statement = source.match(/this\.ctx\.storage\.sql\.exec\(\s*`(INSERT INTO push_subscriptions[\s\S]*?last_seen_at = datetime\('now'\))`/)?.[1];
	assert.ok(statement, "upsert statement remains directly testable");
	const db = new DatabaseSync(":memory:");
	db.exec(`CREATE TABLE emails(id TEXT PRIMARY KEY); CREATE TABLE push_subscriptions (
	 id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
	 user_agent TEXT, device_label TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
	 last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), user_id TEXT
	);`);
	const migration = mailboxMigrations.find((item) => item.name === "25_add_durable_push_outbox");
	assert.ok(migration);
	db.exec(migration.sql);
	db.prepare(`${statement}`).run("device-1", "user-1", "https://push.example/1", "key-1", "auth-1", "ua", "Chrome");
	db.prepare(`UPDATE push_subscriptions SET
	 last_push_attempt_at='2026-07-12T10:00:00.000Z',
	 last_push_accepted_at='2026-07-12T10:00:00.000Z', consecutive_push_failures=0
	 WHERE id='device-1'`).run();
	db.prepare(`${statement}`).run("ignored", "user-1", "https://push.example/1", "key-1", "auth-1", "ua", "Chrome");
	assert.deepEqual({ ...db.prepare(`SELECT generation, last_push_accepted_at AS accepted
	 FROM push_subscriptions`).get()! }, { generation: 2, accepted: "2026-07-12T10:00:00.000Z" });
	db.prepare(`${statement}`).run("ignored", "user-1", "https://push.example/1", "key-2", "auth-1", "ua", "Chrome");
	assert.deepEqual({ ...db.prepare(`SELECT generation, last_push_accepted_at AS accepted,
	 consecutive_push_failures AS failures FROM push_subscriptions`).get()! }, {
		generation: 3, accepted: null, failures: 0,
	});
	db.close();
});
