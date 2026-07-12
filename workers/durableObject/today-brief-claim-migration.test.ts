import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mailboxMigrations } from "./migrations.ts";

const durableObjectSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(
	new URL("../lib/today-brief-runtime.ts", import.meta.url),
	"utf8",
);

test("Today brief distributed generation claims are durable and owner-scoped", () => {
	const migration = mailboxMigrations.find(
		(item) => item.name === "20_add_today_brief_generation_claims",
	);
	assert.ok(migration);
	assert.match(migration.sql, /CREATE TABLE today_brief_generation_claims/);
	assert.match(migration.sql, /cache_key TEXT PRIMARY KEY/);
	assert.match(migration.sql, /owner_user_id TEXT NOT NULL/);
	assert.match(migration.sql, /claim_token TEXT NOT NULL/);
	assert.match(migration.sql, /expires_at INTEGER NOT NULL/);
	assert.match(migration.sql, /idx_today_brief_generation_claim_expiry/);
});

test("Today brief claims renew during provider work and cache is rechecked after claim", () => {
	assert.match(durableObjectSource, /sameOwner && expiresAt > current\.expires_at/);
	assert.match(durableObjectSource, /UPDATE today_brief_generation_claims SET expires_at/);
	assert.match(runtimeSource, /renewal = setInterval/);
	assert.match(runtimeSource, /Close the cache-miss\/claim handoff race/);
	assert.match(runtimeSource, /cachedTodayBriefResponse\([\s\S]*?return await generateTodayBrief/);
});
