import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { MailboxContext } from "../lib/mailbox.ts";
import { requireMailbox } from "../lib/mailbox.ts";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import {
	createMailboxEmailBodyRoutes,
	type MailboxEmailBodyRouteDependencies,
} from "./mailbox-email-body.ts";

const bodyUrl = "/api/v1/mailboxes/team%40example.com/emails/message-1/body";
const externalSource = {
	storage: "external" as const,
	parts: [{
		contentType: "text/plain" as const,
		partIndex: 0,
		r2Key: "private/body/message-1/part-0",
		byteLength: 4,
	}],
};

function app(dependencies: MailboxEmailBodyRouteDependencies) {
	const root = new Hono<MailboxContext>();
	root.route("/", createMailboxEmailBodyRoutes(dependencies));
	return root;
}

function dependencies(overrides: Partial<MailboxEmailBodyRouteDependencies> = {}) {
	return {
		source: async () => externalSource,
		bucket: () => ({
			get: async () => ({ size: 4, text: async () => "body" }),
		}),
		revalidateAccess: async () => true,
		...overrides,
	} satisfies MailboxEmailBodyRouteDependencies;
}

async function assertUnavailable(response: Response) {
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), {
		error: "Complete message body is temporarily unavailable",
		code: "BODY_OBJECT_UNAVAILABLE",
	});
}

test("email body route returns inline content only after final access revalidation", async () => {
	let bucketReads = 0;
	let accessChecks = 0;
	const response = await app(dependencies({
		source: async () => ({ storage: "inline", body: "inline body" }),
		bucket: () => ({
			get: async () => {
				bucketReads += 1;
				return null;
			},
		}),
		revalidateAccess: async () => {
			accessChecks += 1;
			return true;
		},
	})).request(bodyUrl);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), "inline body");
	assert.equal(bucketReads, 0);
	assert.equal(accessChecks, 1);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("email body route composes external parts in authoritative part order", async () => {
	const keys: string[] = [];
	const source = {
		storage: "external" as const,
		parts: [
			{ contentType: "text/html" as const, partIndex: 1, r2Key: "key-html", byteLength: 11 },
			{ contentType: "text/plain" as const, partIndex: 0, r2Key: "key-plain", byteLength: 7 },
		],
	};
	const values = new Map([
		["key-plain", "A & < B"],
		["key-html", "<p>HTML</p>"],
	]);
	const response = await app(dependencies({
		source: async () => source,
		bucket: () => ({
			get: async (key) => {
				keys.push(key);
				const value = values.get(key)!;
				return { size: new TextEncoder().encode(value).byteLength, text: async () => value };
			},
		}),
	})).request(bodyUrl);
	assert.equal(response.status, 200);
	assert.deepEqual(keys, ["key-plain", "key-html"]);
	assert.equal(await response.text(), "<pre>A &amp; &lt; B</pre><br/>\n<p>HTML</p>");
});

for (const scenario of ["missing", "size", "get", "text"] as const) {
	test(`email body route returns a stable key-free 503 when R2 ${scenario} fails`, async () => {
		let accessChecks = 0;
		const secretKey = externalSource.parts[0].r2Key;
		const response = await app(dependencies({
			bucket: () => ({
				get: async () => {
					if (scenario === "get") throw new Error(`failed ${secretKey}`);
					if (scenario === "missing") return null;
					return {
						size: scenario === "size" ? 99 : 4,
						text: async () => {
							if (scenario === "text") throw new Error(`failed ${secretKey}`);
							return "body";
						},
					};
				},
			}),
			revalidateAccess: async () => {
				accessChecks += 1;
				return true;
			},
		})).request(bodyUrl);
		const responseText = await response.clone().text();
		await assertUnavailable(response);
		assert.equal(accessChecks, 1);
		assert.equal(responseText.includes(secretKey), false);
	});
}

test("email body route returns 403 when access was revoked during an R2 failure", async () => {
	const response = await app(dependencies({
		bucket: () => ({ get: async () => null }),
		revalidateAccess: async () => false,
	})).request(bodyUrl);
	assert.equal(response.status, 403);
	assert.deepEqual(await response.json(), { error: "Forbidden" });
});

test("email body route fails closed when final access is revoked or unavailable", async () => {
	const revoked = await app(dependencies({
		revalidateAccess: async () => false,
	})).request(bodyUrl);
	assert.equal(revoked.status, 403);
	assert.deepEqual(await revoked.json(), { error: "Forbidden" });

	const unavailable = await app(dependencies({
		revalidateAccess: async () => { throw new Error("access service unavailable"); },
	})).request(bodyUrl);
	await assertUnavailable(unavailable);
});

test("email body route owns final revalidation through requireMailbox and preserves stable 503", async () => {
	let authorizationReads = 0;
	const env = {
		DB: {
			prepare() {
				return {
					bind() {
						return {
							async first() {
								authorizationReads += 1;
								if (authorizationReads > 1) {
									throw new Error("middleware performed a duplicate final check");
								}
								return { authorized: 1 };
							},
						};
					},
				};
			},
		},
		BUCKET: { head: async () => ({ exists: true }) },
		MAILBOX: {
			idFromName: (name: string) => name,
			get: () => ({}),
		},
	} as unknown as Env;
	const session: SessionClaims = {
		sub: "member",
		email: "member@example.com",
		role: "AGENT",
		mailbox: "member@example.com",
		sessionVersion: 1,
	};
	const mounted = new Hono<MailboxContext>();
	mounted.use("*", async (c, next) => {
		c.set("session", session);
		await next();
	});
	mounted.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);
	mounted.route("/", createMailboxEmailBodyRoutes({
		source: async () => externalSource,
		bucket: () => ({
			get: async () => { throw new Error("R2 unavailable"); },
		}),
		revalidateAccess: async () => { throw new Error("authorization unavailable"); },
	}));

	const response = await mounted.request(bodyUrl, undefined, env);
	await assertUnavailable(response);
	assert.equal(authorizationReads, 1);
});
