import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

test("migration 25 preserves subscriptions and installs the durable push constraints", () => {
	const migration = mailboxMigrations.find((item) => item.name === "25_add_durable_push_outbox");
	assert.ok(migration);
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		CREATE TABLE push_subscriptions (
		 id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
		 auth TEXT NOT NULL, user_agent TEXT, device_label TEXT,
		 created_at TEXT NOT NULL DEFAULT (datetime('now')),
		 last_seen_at TEXT NOT NULL DEFAULT (datetime('now')), user_id TEXT
		);
		INSERT INTO emails VALUES ('message-1');
		INSERT INTO push_subscriptions(id, endpoint, p256dh, auth, user_id)
		 VALUES ('device-1', 'https://push.example/1', 'key', 'auth', 'user-1');
	`);
	db.exec(migration.sql);
	assert.equal(db.prepare("SELECT generation FROM push_subscriptions").get()?.generation, 1);
	const ddl = String(db.prepare(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='push_notification_deliveries'",
	).get()?.sql).toLowerCase();
	const notificationDdl = String(db.prepare(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='push_notifications'",
	).get()?.sql).toLowerCase();
	const subscriptionDdl = String(db.prepare(
		"SELECT sql FROM sqlite_master WHERE type='table' AND name='push_subscriptions'",
	).get()?.sql).toLowerCase();
	assert.match(ddl, /primary key\s*\(notification_id, subscription_id\)/);
	assert.match(ddl, /status in \('pending', 'sending', 'retrying', 'accepted', 'terminal'\)/);
	assert.match(ddl, /attempt_count >= 0/);
	assert.match(notificationDdl, /state in \('pending', 'completed', 'no_targets', 'expired'\)/);
	assert.match(notificationDdl, /target_count >= 0/);
	assert.match(subscriptionDdl, /created_at text not null default \(datetime\('now'\)\)/);
	assert.match(subscriptionDdl, /last_seen_at text not null default \(datetime\('now'\)\)/);
	assert.doesNotMatch(ddl, /foreign key\s*\(subscription_id\)/);
	assert.equal(db.prepare(
		"SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE 'idx_push_%'",
	).get()?.count, 4);
	db.close();
});

test("Drizzle mirrors migration 25 defaults, closed states, checks, and descending health index", () => {
	const source = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
	assert.match(source, /created_at: text\("created_at"\)\.notNull\(\)\.default\(sql`\(datetime\('now'\)\)`\)/);
	assert.match(source, /last_seen_at: text\("last_seen_at"\)\.notNull\(\)\.default\(sql`\(datetime\('now'\)\)`\)/);
	assert.match(source, /push_notifications_state_closed/);
	assert.match(source, /sql`\$\{table\.state\} IN \('pending', 'completed', 'no_targets', 'expired'\)`/);
	assert.match(source, /push_notifications_target_count_nonnegative/);
	assert.match(source, /sql`\$\{table\.target_count\} >= 0`/);
	assert.match(source, /push_notification_deliveries_attempt_count_nonnegative/);
	assert.match(source, /sql`\$\{table\.attempt_count\} >= 0`/);
	assert.match(source, /push_notification_deliveries_status_closed/);
	assert.match(source, /sql`\$\{table\.status\} IN \('pending', 'sending', 'retrying', 'accepted', 'terminal'\)`/);
	assert.match(
		source,
		/idx_push_deliveries_actor_health[\s\S]*?table\.target_user_id,[\s\S]*?sql`\$\{table\.updated_at\} DESC`/,
	);
});
