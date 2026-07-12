import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import type { Env } from "../types.ts";
import { globalTodayBriefClaimStore } from "./global-today-brief-claims-d1.ts";

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
	return {
		prepare: (sql: string) => new Statement(database, sql),
	} as unknown as D1Database;
}

test("global Today brief claims isolate scope, renew by token, expire, and release safely", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec(readFileSync(new URL("../../migrations/0004_create_ai_cost_controls.sql", import.meta.url), "utf8"));
	database.exec(readFileSync(new URL("../../migrations/0009_create_global_today_brief_claims.sql", import.meta.url), "utf8"));
	const store = globalTodayBriefClaimStore({ DB: d1(database), BRAND: "wiser" } as Env);
	const base = {
		cacheKey: `global-key-${"x".repeat(30)}`,
		cacheScope: "global-today-brief:owner:user-a",
		ownerUserId: "user-a",
	};
	const tokenA = "claim-token-aaaaaaaa";
	const tokenB = "claim-token-bbbbbbbb";

	assert.equal(await store.claim({ ...base, claimToken: tokenA, expiresAt: 2_000 }, 1_000), true);
	assert.equal(await store.claim({ ...base, claimToken: tokenB, expiresAt: 2_100 }, 1_100), false);
	assert.equal(await store.claim({ ...base, claimToken: tokenA, expiresAt: 2_500 }, 1_200), true);
	assert.equal(await store.owns({ ...base, claimToken: tokenA }, 2_000), true);
	assert.equal(await store.claim({ ...base, claimToken: tokenB, expiresAt: 3_500 }, 2_600), true);
	assert.equal(await store.owns({ ...base, claimToken: tokenA }, 2_700), false);
	assert.equal(await store.release({ ...base, claimToken: tokenA }), false);
	assert.equal(await store.release({ ...base, claimToken: tokenB }), true);
	database.prepare(
		"INSERT INTO global_today_brief_generation_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
	).run("default", "expired-unrelated-key-xxxxxxxx", "global-today-brief:owner:old", "old", "expired-token-aaaa", 3_000, 1_000, 1_000);

	assert.equal(await store.claim({ ...base, cacheScope: "global-today-brief:owner:user-a", claimToken: tokenA, expiresAt: 5_000 }, 4_000), true);
	assert.equal(database.prepare("SELECT COUNT(*) AS total FROM global_today_brief_generation_claims WHERE expires_at <= 4000").get().total, 0);
	assert.equal(await store.claim({ ...base, cacheScope: "global-today-brief:owner:user-b", ownerUserId: "user-b", claimToken: tokenB, expiresAt: 5_000 }, 4_000), true);
	database.close();
});
