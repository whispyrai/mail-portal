import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import {
	getLatestCachedAiResponseForScope,
	putCachedAiResponse,
} from "./ai-cost-control-d1.ts";

class Statement {
	#values: unknown[] = [];
	readonly #statement: StatementSync;
	constructor(database: DatabaseSync, sql: string) {
		this.#statement = database.prepare(sql);
	}
	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}
	async first<T>() {
		return (this.#statement.get(...this.#values) as T | undefined) ?? null;
	}
	async run() {
		const result = this.#statement.run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}
}

function d1(database: DatabaseSync): D1Database {
	return { prepare: (sql: string) => new Statement(database, sql) } as unknown as D1Database;
}

test("latest scoped cache lookup is feature-private, actor-private, and expiry-aware", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec(readFileSync(new URL("../../migrations/0004_create_ai_cost_controls.sql", import.meta.url), "utf8"));
	database.exec(readFileSync(new URL("../../migrations/0009_create_global_today_brief_claims.sql", import.meta.url), "utf8"));
	const env = { DB: d1(database), BRAND: "wiser" } as Env;
	const cacheScope = "global-today-brief:owner:user-a";
	await putCachedAiResponse(env, { cacheKey: "old", cacheScope, feature: "global_today_brief", value: { value: "old" }, now: 1_000, ttlMs: 5_000 });
	await putCachedAiResponse(env, { cacheKey: "new", cacheScope, feature: "global_today_brief", value: { value: "new" }, now: 2_000, ttlMs: 5_000 });
	await putCachedAiResponse(env, { cacheKey: "other-feature", cacheScope, feature: "other", value: { value: "wrong" }, now: 3_000, ttlMs: 5_000 });
	await putCachedAiResponse(env, { cacheKey: "other-actor", cacheScope: "global-today-brief:owner:user-b", feature: "global_today_brief", value: { value: "private" }, now: 4_000, ttlMs: 5_000 });

	assert.deepEqual(await getLatestCachedAiResponseForScope<{ value: string }>(env, {
		cacheScope,
		feature: "global_today_brief",
		now: 2_500,
	}), { cacheKey: "new", createdAt: 2_000, value: { value: "new" } });
	assert.equal(await getLatestCachedAiResponseForScope(env, {
		cacheScope,
		feature: "global_today_brief",
		now: 7_001,
	}), null);
	database.close();
});
