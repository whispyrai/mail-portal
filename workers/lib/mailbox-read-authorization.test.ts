import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "./auth.ts";
import { requireMailbox, type MailboxContext } from "./mailbox.ts";
import type { Env } from "../types.ts";

class Statement {
	#values: unknown[] = [];
	readonly #database: DatabaseSync;
	readonly #sql: string;
	readonly #beforeRead?: (sql: string) => void;

	constructor(
		database: DatabaseSync,
		sql: string,
		beforeRead?: (sql: string) => void,
	) {
		this.#database = database;
		this.#sql = sql;
		this.#beforeRead = beforeRead;
	}

	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}

	async first<T>() {
		this.#beforeRead?.(this.#sql);
		return (this.statement().get(...this.#values) as T | undefined) ?? null;
	}

	async all<T>() {
		this.#beforeRead?.(this.#sql);
		return {
			success: true,
			results: this.statement().all(...this.#values) as T[],
		};
	}

	async raw<T extends unknown[]>() {
		this.#beforeRead?.(this.#sql);
		return this.statement()
			.all(...this.#values)
			.map((row) => Object.values(row)) as T[];
	}

	async run() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}

	private statement(): StatementSync {
		return this.#database.prepare(this.#sql);
	}
}

function d1(
	database: DatabaseSync,
	beforeRead?: (sql: string) => void,
): D1Database {
	return {
		prepare(sql: string) {
			return new Statement(database, sql, beforeRead);
		},
	} as unknown as D1Database;
}

function fixture(options: { failPostAuthorization?: boolean } = {}) {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0003_create_mailbox_access.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
	]) {
		database.exec(
			readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
		);
	}
	database.exec(`
		INSERT INTO users
		 (id, email, password_hash, password_salt, role, is_active, mailbox_address,
		  session_version, created_at, updated_at)
		VALUES
		 ('member', 'member@example.com', 'hash', 'salt', 'AGENT', 1, 'member@example.com', 1, 1, 1);
		INSERT INTO mailboxes
		 (id, address, type, owner_user_id, is_active, created_at, updated_at)
		VALUES
		 ('team@example.com', 'team@example.com', 'SHARED', NULL, 1, 1, 1);
		INSERT INTO mailbox_memberships (mailbox_id, user_id, created_at)
		VALUES ('team@example.com', 'member', 1);
	`);

	const session: SessionClaims = {
		sub: "member",
		email: "member@example.com",
		role: "AGENT",
		mailbox: "member@example.com",
		sessionVersion: 1,
	};
	let routeWorkStarted = false;
	const env = {
		DB: d1(database, (sql) => {
			if (
				options.failPostAuthorization &&
				routeWorkStarted
			) {
				throw new Error(`authorization database unavailable: ${sql.length}`);
			}
		}),
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: {
			idFromName: (name: string) => name,
			get: () => ({}),
		},
	} as unknown as Env;
	const app = new Hono<MailboxContext>();
	app.onError((error, c) => c.json({ error: error.message }, 500));
	app.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	app.get("/api/v1/mailboxes/:mailboxId/private-content", async (c) => {
		database
			.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
			)
			.run("team@example.com", "member");
		return c.json({ subject: "private mailbox content" });
	});
	app.get("/api/v1/mailboxes/:mailboxId/private-error", () => {
		database
			.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
			)
			.run("team@example.com", "member");
		throw new Error("private storage failure");
	});
	app.get("/api/v1/mailboxes/:mailboxId/private-headers", () => {
		routeWorkStarted = true;
		database
			.prepare(
				"DELETE FROM mailbox_memberships WHERE mailbox_id = ? AND user_id = ?",
			)
			.run("team@example.com", "member");
		return new Response("private body", {
				headers: {
					"Cache-Control": "public, max-age=3600",
					"Content-Disposition": 'attachment; filename="private.pdf"',
					ETag: '"private-message-version"',
					"Last-Modified": "Mon, 13 Jul 2026 12:00:00 GMT",
					"Set-Cookie": "private-mailbox-state=secret; HttpOnly; Path=/",
					"X-Private-Metadata": "mailbox-internal-value",
			},
		});
	});
	app.post("/api/v1/mailboxes/:mailboxId/authorized-identity", (c) =>
		c.json({ mailboxId: c.var.authorizedMailboxId }),
	);
	app.get("/api/v1/mailboxes/:mailboxId/settings", (c) =>
		c.json({ mailboxId: c.var.authorizedMailboxId }),
	);

	return {
		database,
		request: (resource = "private-content", init?: RequestInit) =>
			app.request(
				`/api/v1/mailboxes/team%40example.com/${resource}`,
				init,
				env,
			),
		requestPath: (path: string, init?: RequestInit) => app.request(path, init, env),
	};
}

test("mailbox middleware canonicalizes one decoded route identity exactly once", async () => {
	const state = fixture();
	const canonical = await state.requestPath(
		"/api/v1/mailboxes/TEAM%40EXAMPLE.COM/authorized-identity",
		{ method: "POST" },
	);
	assert.equal(canonical.status, 200);
	assert.deepEqual(await canonical.json(), { mailboxId: "team@example.com" });

	const doubleEncoded = await state.requestPath(
		"/api/v1/mailboxes/team%2540example.com/authorized-identity",
		{ method: "POST" },
	);
	assert.equal(doubleEncoded.status, 400);
	assert.deepEqual(await doubleEncoded.json(), { error: "Invalid Mailbox ID" });
	state.database.close();
});

test("settings bypass keeps the same once-decoded canonical mailbox identity", async () => {
	const state = fixture();
	const response = await state.requestPath(
		"/api/v1/mailboxes/team%252edoe%40example.com/settings",
	);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		mailboxId: "team%2edoe@example.com",
	});
	state.database.close();
});

test("mailbox middleware suppresses a GET response when Shared access is revoked in flight", async () => {
	const state = fixture();
	const response = await state.request();

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	state.database.close();
});

test("mailbox middleware suppresses a HEAD response when Shared access is revoked in flight", async () => {
	const state = fixture();
	const response = await state.request("private-content", { method: "HEAD" });

	assert.equal(response.status, 403);
	assert.equal(await response.text(), "");
	state.database.close();
});

test("post-read revocation wins over a downstream storage failure", async () => {
	const state = fixture();
	const response = await state.request("private-error");

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	state.database.close();
});

test("revocation strips private downstream response headers", async () => {
	const state = fixture();
	const response = await state.request("private-headers");

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
	assert.equal(response.headers.get("content-disposition"), null);
	assert.equal(response.headers.get("etag"), null);
	assert.equal(response.headers.get("last-modified"), null);
	assert.equal(response.headers.get("x-private-metadata"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	state.database.close();
});

test("post-read authorization failure strips the finalized private response", async () => {
	const state = fixture({ failPostAuthorization: true });
	const response = await state.request("private-headers");

	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: "Authorization unavailable" });
	assert.equal(response.headers.get("content-disposition"), null);
	assert.equal(response.headers.get("etag"), null);
	assert.equal(response.headers.get("last-modified"), null);
	assert.equal(response.headers.get("x-private-metadata"), null);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	state.database.close();
});
