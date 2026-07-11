import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";

import type { Env } from "../types.ts";
import { createLoginThrottle } from "./login-throttle.ts";
import { d1LoginThrottleStore } from "./login-throttle-d1.ts";

class SqliteD1Statement {
	readonly #db: DatabaseSync;
	readonly #sql: string;
	#values: unknown[] = [];

	constructor(db: DatabaseSync, sql: string) {
		this.#db = db;
		this.#sql = sql;
	}

	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}

	async run() {
		return this.runSync();
	}

	async first<T>() {
		return (this.statement().get(...this.#values) as T | undefined) ?? null;
	}

	runSync() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}

	private statement(): StatementSync {
		return this.#db.prepare(this.#sql);
	}
}

function sqliteD1(db: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			return new SqliteD1Statement(db, sql);
		},
		async batch(statements: SqliteD1Statement[]) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const results = statements.map((statement) => statement.runSync());
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

function setup() {
	const db = new DatabaseSync(":memory:");
	db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
	db.exec(
		readFileSync(
			new URL("../../migrations/0005_auth_security.sql", import.meta.url),
			"utf8",
		),
	);
	const env = { DB: sqliteD1(db) } as unknown as Env;
	return { db, store: d1LoginThrottleStore(env) };
}

test("D1 atomically admits at most five parallel checks for one account", async () => {
	const { db, store } = setup();
	let id = 0;
	const throttle = createLoginThrottle(store, {
		now: () => 1_000_000,
		createId: () => `attempt-${++id}`,
	});
	const identity = {
		email: "member@example.com",
		ip: "203.0.113.10",
		secret: "test-secret",
	};

	const admissions = await Promise.all(
		Array.from({ length: 20 }, () => throttle.admit(identity)),
	);
	assert.equal(admissions.filter((admission) => admission.allowed).length, 5);
	assert.equal(
		db.prepare("SELECT COUNT(DISTINCT attempt_id) AS count FROM login_attempt_leases")
			.get()!.count,
		5,
	);
	db.close();
});

test("D1 success releases only its lease while failure consumes the bucket", async () => {
	const { db, store } = setup();
	let id = 0;
	const throttle = createLoginThrottle(store, {
		now: () => 2_000_000,
		createId: () => `attempt-${++id}`,
	});
	const identity = {
		email: "member@example.com",
		ip: "203.0.113.20",
		secret: "test-secret",
	};

	for (let count = 0; count < 4; count++) {
		const admission = await throttle.admit(identity);
		assert.equal(admission.allowed, true);
		if (!admission.allowed) assert.fail("attempt should be admitted");
		await throttle.recordFailure(admission.attempt);
	}
	const successful = await throttle.admit(identity);
	assert.equal(successful.allowed, true);
	if (!successful.allowed) assert.fail("attempt should be admitted");
	await throttle.recordSuccess(successful.attempt);

	const finalFailure = await throttle.admit(identity);
	assert.equal(finalFailure.allowed, true);
	if (!finalFailure.allowed) assert.fail("attempt should be admitted");
	await throttle.recordFailure(finalFailure.attempt);
	assert.deepEqual(await throttle.admit(identity), {
		allowed: false,
		retryAfterSeconds: 900,
	});
	db.close();
});
