import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
	new URL("../../migrations/0004_create_ai_cost_controls.sql", import.meta.url),
	"utf8",
)
	.replace(/\s+/g, " ")
	.toLowerCase();

test("AI cost migration keeps per-environment monthly and per-feature ledgers", () => {
	assert.match(migration, /create table if not exists ai_usage_months/);
	assert.match(migration, /primary key \(environment, month_key\)/);
	assert.match(migration, /create table if not exists ai_usage_events/);
	assert.match(migration, /feature text not null/);
	assert.match(migration, /estimated_cost_micros integer not null/);
	assert.match(migration, /actual_cost_micros integer not null/);
	assert.match(migration, /prompt_tokens integer not null/);
	assert.match(migration, /completion_tokens integer not null/);
});

test("AI cost migration reconciles reservations and audits admin reviews", () => {
	assert.match(migration, /create trigger if not exists ai_usage_reserve_after_insert/);
	assert.match(migration, /reserved_micros = reserved_micros \+ new.estimated_cost_micros/);
	assert.match(migration, /create trigger if not exists ai_usage_complete_after_update/);
	assert.match(migration, /spent_micros = spent_micros \+ new.actual_cost_micros/);
	assert.match(migration, /create trigger if not exists ai_usage_fail_after_update/);
	assert.match(migration, /create table if not exists ai_budget_reviews/);
	assert.match(migration, /create trigger if not exists ai_budget_review_after_insert/);
	assert.match(migration, /reservation_expires_at integer/);
	assert.match(migration, /provider_started_at integer/);
	assert.match(migration, /idx_ai_usage_events_reservation_expiry/);
	assert.match(
		migration,
		/ai_usage_fail_after_update.*spent_micros = spent_micros \+ new.actual_cost_micros/,
	);
});

test("AI cost migration provides scoped response caching with expiry", () => {
	assert.match(migration, /create table if not exists ai_response_cache/);
	assert.match(migration, /primary key \(environment, cache_key, mailbox_scope\)/);
	assert.match(migration, /mailbox_scope text not null/);
	assert.match(migration, /mailbox_id text/);
	assert.match(migration, /expires_at integer not null/);
	assert.match(migration, /idx_ai_response_cache_expiry/);
});
