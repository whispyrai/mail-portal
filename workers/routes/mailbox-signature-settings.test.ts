import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import { MailboxSettingsConflictError } from "../lib/mailbox-settings-store.ts";
import {
	createMailboxSignatureSettingsRoutes,
	type MailboxSignatureSettingsOperations,
	type MailboxSignatureSettingsRouteContext,
} from "./mailbox-signature-settings.ts";

const session: SessionClaims = { sub: "user-1", email: "user@example.com", role: "AGENT", mailbox: "user@example.com" };

function app(input: {
	session?: SessionClaims;
	access?: { canRead: boolean; canManage: boolean };
	settings?: Record<string, unknown> | null;
}) {
	let written: Record<string, unknown> | undefined;
	const operations: MailboxSignatureSettingsOperations = {
		async access() { return input.access ?? { canRead: true, canManage: true }; },
		async read() { return input.settings === undefined ? { signature: { enabled: false, text: "" } } : input.settings; },
		async updateSignature(_env, _mailbox, signature) {
			const current = input.settings === undefined
				? { signature: { enabled: false, text: "" } }
				: input.settings;
			if (!current) throw new Error("missing settings");
			written = { ...current, signature };
			return written;
		},
	};
	const root = new Hono<MailboxSignatureSettingsRouteContext>();
	root.use("*", async (c, next) => { if (input.session) c.set("session", input.session); await next(); });
	root.route("/", createMailboxSignatureSettingsRoutes({ operations }));
	return { root, written: () => written };
}

function request(root: Hono<MailboxSignatureSettingsRouteContext>, path: string, init?: RequestInit) {
	return root.request(`http://mail.test/api/v1/mailboxes/team%40example.com${path}`, init, {} as never);
}

test("signature settings require auth and allow read-only Shared members", async () => {
	assert.equal((await request(app({}).root, "/settings")).status, 401);
	const member = app({ session, access: { canRead: true, canManage: false }, settings: { signature: { enabled: true, text: "Team" }, secret: "hidden" } });
	const get = await request(member.root, "/settings");
	assert.equal(get.status, 200);
	assert.deepEqual(await get.json(), { signature: { enabled: true, text: "Team" }, canManage: false });
	assert.equal((await request(member.root, "/settings/signature", { method: "PATCH", body: JSON.stringify({ enabled: true, text: "x" }) })).status, 403);
});

test("narrow Shared admin management works without mailbox content access", async () => {
	const target = app({
		session: { ...session, role: "ADMIN" },
		access: { canRead: false, canManage: true },
		settings: { fromName: "Support", signature: { enabled: true, html: "<b>Old</b>" }, forwarding: { enabled: true } },
	});
	assert.equal((await request(target.root, "/settings")).status, 200);
	const response = await request(target.root, "/settings/signature", {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ enabled: true, text: "Line 1\r\nLine 2" }),
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { signature: { enabled: true, text: "Line 1\nLine 2" }, canManage: true });
	assert.deepEqual(target.written(), {
		fromName: "Support",
		signature: { enabled: true, text: "Line 1\nLine 2" },
		forwarding: { enabled: true },
	});
});

test("signature PATCH rejects nonmanagers, nonmembers, malformed and oversized bodies", async () => {
	const forbidden = app({ session, access: { canRead: false, canManage: false } });
	assert.equal((await request(forbidden.root, "/settings")).status, 403);
	const target = app({ session });
	for (const body of [
		"not-json",
		JSON.stringify({ enabled: true, text: "ok", extra: true }),
		JSON.stringify({ enabled: true, text: "x".repeat(2_001) }),
	]) {
		const response = await request(target.root, "/settings/signature", { method: "PATCH", body });
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "Signature settings are invalid", code: "INVALID" });
	}
	const oversized = await request(target.root, "/settings/signature", {
		method: "PATCH",
		headers: { "Content-Length": "8193" },
		body: JSON.stringify({ enabled: true, text: "ok" }),
	});
	assert.equal(oversized.status, 413);
	assert.deepEqual(await oversized.json(), { error: "Signature settings request is too large", code: "REQUEST_TOO_LARGE" });
	const streamedOversized = await request(target.root, "/settings/signature", {
		method: "PATCH",
		body: JSON.stringify({ enabled: true, text: "x".repeat(9_000) }),
	});
	assert.equal(streamedOversized.status, 413);
});

test("missing mailbox settings return a stable not-found response", async () => {
	const target = app({ session, settings: null });
	const response = await request(target.root, "/settings");
	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Mailbox settings were not found", code: "NOT_FOUND" });
});

test("settings GET suppresses R2 output when Shared access is revoked in flight", async () => {
	let accessChecks = 0;
	const operations: MailboxSignatureSettingsOperations = {
		async access() {
			accessChecks += 1;
			return accessChecks === 1
				? { canRead: true, canManage: false }
				: { canRead: false, canManage: false };
		},
		async read() {
			return { signature: { enabled: true, text: "private signature" } };
		},
		async updateSignature() {
			throw new Error("not used");
		},
	};
	const root = new Hono<MailboxSignatureSettingsRouteContext>();
	root.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	root.route("/", createMailboxSignatureSettingsRoutes({ operations }));

	const response = await request(root, "/settings");

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Mailbox settings are not available",
		code: "FORBIDDEN",
	});
	assert.equal(accessChecks, 2);
});

test("settings revocation wins over an in-flight R2 failure", async () => {
	let accessChecks = 0;
	const operations: MailboxSignatureSettingsOperations = {
		async access() {
			accessChecks += 1;
			return accessChecks === 1
				? { canRead: true, canManage: false }
				: { canRead: false, canManage: false };
		},
		async read() {
			throw new Error("private R2 failure");
		},
		async updateSignature() {
			throw new Error("not used");
		},
	};
	const root = new Hono<MailboxSignatureSettingsRouteContext>();
	root.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	root.route("/", createMailboxSignatureSettingsRoutes({ operations }));

	const response = await request(root, "/settings");

	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), {
		error: "Mailbox settings are not available",
		code: "FORBIDDEN",
	});
	assert.equal(accessChecks, 2);
});

test("unexpected settings failures use a stable credential-free response", async () => {
	const operations: MailboxSignatureSettingsOperations = {
		async access() { return { canRead: true, canManage: true }; },
		async read() { throw new Error("secret storage detail"); },
		async updateSignature() { throw new Error("secret storage detail"); },
	};
	const root = new Hono<MailboxSignatureSettingsRouteContext>();
	root.use("*", async (c, next) => { c.set("session", session); await next(); });
	root.route("/", createMailboxSignatureSettingsRoutes({ operations }));
	const response = await request(root, "/settings");
	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), {
		error: "Mailbox settings are unavailable",
		code: "SETTINGS_UNAVAILABLE",
	});
});

test("signature write conflicts return a stable retryable response", async () => {
	const operations: MailboxSignatureSettingsOperations = {
		async access() { return { canRead: true, canManage: true }; },
		async read() { return { signature: { enabled: false, text: "" } }; },
		async updateSignature() { throw new MailboxSettingsConflictError(); },
	};
	const root = new Hono<MailboxSignatureSettingsRouteContext>();
	root.use("*", async (c, next) => { c.set("session", session); await next(); });
	root.route("/", createMailboxSignatureSettingsRoutes({ operations }));
	const response = await request(root, "/settings/signature", {
		method: "PATCH",
		body: JSON.stringify({ enabled: true, text: "New" }),
	});

	assert.equal(response.status, 409);
	assert.deepEqual(await response.json(), {
		error: "Mailbox settings changed concurrently. Please retry.",
		code: "SETTINGS_CONFLICT",
	});
});
