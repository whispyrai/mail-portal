import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import { createAdminReadDisclosureGuard } from "./admin-read-disclosure-guard.ts";

type TestContext = {
	Bindings: Env;
	Variables: { session?: SessionClaims };
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	let administrator = true;
	let infrastructureFailure = false;
	let checks = 0;
	let mutationRuns = 0;
	const readStarted = deferred();
	const finishRead = deferred();
	const session: SessionClaims = {
		sub: "admin",
		email: "admin@example.com",
		role: "ADMIN",
		mailbox: "admin@example.com",
	};
	const app = new Hono<TestContext>();
	app.onError(() =>
		new Response("private downstream failure for admin@example.com", {
			status: 500,
			headers: { "X-Private-Error": "database-internal" },
		}),
	);
	app.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	app.use(
		"*",
		createAdminReadDisclosureGuard({
			checkAdministrator: async () => {
				checks += 1;
				if (infrastructureFailure) throw new Error("database unavailable");
				return administrator;
			},
		}),
	);
	const privateRead = async () => {
		readStarted.resolve();
		await finishRead.promise;
		return new Response("<p>private administrator data for admin@example.com</p>", {
			headers: {
				"Cache-Control": "public, max-age=3600",
				"Content-Disposition": 'attachment; filename="admin-roster.html"',
				"Content-Type": "text/html; charset=UTF-8",
				ETag: '"private-admin-version"',
				"Last-Modified": "Mon, 13 Jul 2026 12:00:00 GMT",
				"Set-Cookie": "private-admin-state=secret; HttpOnly; Path=/",
				"X-Private-Metadata": "private-admin-value",
			},
		});
	};
	app.get("/private", privateRead);
	app.get("/private-error", async () => {
		readStarted.resolve();
		await finishRead.promise;
		throw new Error("private downstream failure");
	});
	app.post("/mutation", (c) => {
		mutationRuns += 1;
		return c.text("mutation complete");
	});

	return {
		readStarted: readStarted.promise,
		finishRead: finishRead.resolve,
		request: (init?: RequestInit, path = "/private") =>
			app.request(path, init, {} as Env),
		requestMutation: () =>
			app.request("/mutation", { method: "POST" }, {} as Env),
		revokeAdministrator: () => {
			administrator = false;
		},
		failInfrastructure: () => {
			infrastructureFailure = true;
		},
		checks: () => checks,
		mutationRuns: () => mutationRuns,
	};
}

test("admin GET disclosure is suppressed when live administrator access is revoked in flight", async () => {
	const state = fixture();
	const responsePromise = state.request();
	await state.readStarted;
	state.revokeAdministrator();
	state.finishRead();

	const response = await responsePromise;
	assert.equal(response.status, 403);
	const body = await response.text();
	assert.equal(body, "Forbidden");
	assert.doesNotMatch(body, /admin@example\.com/);
	assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
	assert.equal(response.headers.get("content-disposition"), null);
	assert.equal(response.headers.get("etag"), null);
	assert.equal(response.headers.get("last-modified"), null);
	assert.equal(response.headers.get("set-cookie"), null);
	assert.equal(response.headers.get("x-private-metadata"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(state.checks(), 2);
});

test("admin HEAD disclosure uses the same post-read authorization boundary", async () => {
	const state = fixture();
	const responsePromise = state.request({ method: "HEAD" });
	await state.readStarted;
	state.revokeAdministrator();
	state.finishRead();

	const response = await responsePromise;
	assert.equal(response.status, 403);
	assert.equal(await response.text(), "");
	assert.equal(response.headers.get("etag"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(state.checks(), 2);
});

test("admin read disclosure fails closed when the live authorization store is unavailable", async () => {
	const state = fixture();
	const responsePromise = state.request();
	await state.readStarted;
	state.failInfrastructure();
	state.finishRead();

	const response = await responsePromise;
	assert.equal(response.status, 500);
	assert.equal(await response.text(), "Internal Server Error");
	assert.equal(response.headers.get("etag"), null);
	assert.equal(response.headers.get("x-private-metadata"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(state.checks(), 2);
});

test("live revocation wins over a downstream administrator read failure", async () => {
	const state = fixture();
	const responsePromise = state.request(undefined, "/private-error");
	await state.readStarted;
	state.revokeAdministrator();
	state.finishRead();

	const response = await responsePromise;
	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Forbidden");
	assert.equal(response.headers.get("x-private-error"), null);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(state.checks(), 2);
});

test("admin read disclosure guard performs only its entry check for mutations", async () => {
	const state = fixture();
	const response = await state.requestMutation();

	assert.equal(response.status, 200);
	assert.equal(await response.text(), "mutation complete");
	assert.equal(state.checks(), 1);
	assert.equal(state.mutationRuns(), 1);
});

test("admin disclosure guard rejects revoked administrators before route work", async () => {
	const state = fixture();
	state.revokeAdministrator();

	const response = await state.requestMutation();
	assert.equal(response.status, 403);
	assert.equal(await response.text(), "Forbidden");
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(state.checks(), 1);
	assert.equal(state.mutationRuns(), 0);
});

test("the real administrator app mounts the live read guard before direct and nested pages", () => {
	const source = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
	const guard = source.indexOf("createAdminReadDisclosureGuard({");
	const nestedRoutes = source.indexOf('adminApp.route("/quizzes", adminQuizApp)');
	const directRoutes = source.indexOf('adminApp.get("/ai-cost"');

	assert.notEqual(guard, -1);
	assert.ok(guard < nestedRoutes);
	assert.ok(guard < directRoutes);
	assert.match(
		source,
		/requireMailboxAdministrator\(userId\)[\s\S]*error instanceof MailboxAccessError[\s\S]*error\.code === "FORBIDDEN"/,
	);
});
