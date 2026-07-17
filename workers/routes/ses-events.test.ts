import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import test from "node:test";
import { Hono } from "hono";
import type { Env } from "../types.ts";
import { markCredentialRecoveryAccepted } from "../lib/credential-recovery-delivery-outbox.ts";
import { handleSesEvent } from "./ses-events.ts";

class D1Statement {
	#values: unknown[] = [];
	private readonly database: DatabaseSync;
	private readonly sql: string;
	constructor(database: DatabaseSync, sql: string) {
		this.database = database;
		this.sql = sql;
	}
	bind(...values: unknown[]) {
		this.#values = values;
		return this;
	}
	async run() {
		const result = this.statement().run(...this.#values);
		return { success: true, meta: { changes: Number(result.changes) } };
	}
	async first<T>() {
		return (this.statement().get(...this.#values) as T | undefined) ?? null;
	}
	private statement(): StatementSync {
		return this.database.prepare(this.sql);
	}
}

function d1(database: DatabaseSync): D1Database {
	return {
		prepare(sql: string) {
			return new D1Statement(database, sql);
		},
		async batch(statements: D1Statement[]) {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results = [];
				for (const statement of statements) results.push(await statement.run());
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
}

function mailboxKey(value: string) {
	return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function recipientHash(value: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value.toLowerCase()),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function testApp(resultStatus = "recorded") {
	const recorded: unknown[] = [];
	const app = new Hono();
	app.post("/webhooks/ses", handleSesEvent as never);
	const env = {
		SES_EVENT_WEBHOOK_SECRET: "event-secret",
		DOMAINS: "wiserchat.ai,test.wiserchat.ai",
		MAILBOX: {
			idFromName(value: string) {
				return value;
			},
			get(value: string) {
				assert.equal(value, "team@wiserchat.ai");
				return {
					async recordSesProviderEvent(input: unknown) {
						recorded.push(input);
						return resultStatus === "recovery_pending"
							? { status: "recorded", recoveryPending: true }
							: { status: resultStatus };
					},
				};
			},
		},
	};
	return { app, env, recorded };
}

test("SES event callback requires its dedicated bearer secret", async () => {
	const { app, env } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{ method: "POST", body: "{}", headers: { "Content-Type": "application/json" } },
		env as never,
	);
	assert.equal(response.status, 401);
});

test("authenticated bounce is correlated to the tagged mailbox and delivery", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-1",
				time: "2026-07-16T10:00:00.000Z",
				detail: {
					eventType: "Bounce",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
					bounce: {
						bounceType: "Permanent",
						bouncedRecipients: [{ emailAddress: "Customer@Example.com" }],
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.equal(recorded.length, 1);
	assert.deepEqual(recorded[0], {
		eventId: "event-1",
		deliveryId: "delivery-1",
		attemptId: "attempt-1",
		sesMessageId: "ses-message-1",
		eventType: "bounce",
		recipientHashes: [await recipientHash("customer@example.com")],
		occurredAt: "2026-07-16T10:00:00.000Z",
		receivedAt: (recorded[0] as { receivedAt: string }).receivedAt,
	});
});

test("a bounce without parseable recipient scope is preserved for unknown-outcome handling", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-unscoped-bounce",
				detail: {
					eventType: "Bounce",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
					bounce: { bouncedRecipients: [{ diagnosticCode: "scope omitted" }] },
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(
		(recorded[0] as { recipientHashes: string[] }).recipientHashes,
		[],
	);
});

test("unsupported SES events are ignored without touching mailbox state", async () => {
	const { app, env, recorded } = testApp();
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({ detail: { eventType: "Open" } }),
		},
		env as never,
	);
	assert.equal(response.status, 202);
	assert.deepEqual(recorded, []);
});

test("raced SES events return a retryable response", async () => {
	const { app, env } = testApp("not_found");
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-2",
				detail: {
					eventType: "Complaint",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 503);
});

test("a committed event with pending projection asks the provider to retry", async () => {
	const { app, env } = testApp("recovery_pending");
	const response = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "event-recovery",
				detail: {
					eventType: "Delivery",
					mail: {
						messageId: "ses-message-1",
						tags: {
							MailboxKey: [mailboxKey("team@wiserchat.ai")],
							DeliveryId: ["delivery-1"],
							AttemptId: ["attempt-1"],
						},
					},
				},
			}),
		},
		env as never,
	);
	assert.equal(response.status, 503);
});

test("credential recovery provider events are idempotent D1 evidence and preserve acceptance", async () => {
	const database = new DatabaseSync(":memory:");
	for (const migration of [
		"0001_create_users.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
		"0012_create_credential_recovery_jobs.sql",
	]) {
		database.exec(
			readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
		);
	}
	database.prepare(
		`INSERT INTO users
		 (id, email, password_hash, password_salt, mailbox_address,
		  ownership_confirmed_at, created_at, updated_at)
		 VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt',
		         'member@wiserchat.ai', 1, 1, 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_tokens
		 (id, user_id, token_hash, expires_at, purpose, created_at)
		 VALUES ('token-1', 'user-1', 'token-hash', 999999999, 'recovery', 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_delivery_outbox
		 (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
		  state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
		  dispatch_started_at, created_at, updated_at)
		 VALUES ('recovery-delivery-1', 'token-1', 1, 'AAAAAAAAAAAAAAAA', ?,
		         'dispatching', 1, 1, 'attempt-1', 999999999, 10, 1, 10)`,
	).run("c".repeat(24));
	database.prepare(
		`INSERT INTO credential_recovery_delivery_attempts
		 (attempt_id, outbox_id, state, dispatch_started_at, created_at, updated_at)
		 VALUES ('attempt-1', 'recovery-delivery-1', 'dispatching', 10, 10, 10)`,
	).run();

	const app = new Hono();
	app.post("/webhooks/ses", handleSesEvent as never);
	const env = {
		SES_EVENT_WEBHOOK_SECRET: "event-secret",
		DB: d1(database),
	} as never;
	const request = () =>
		app.request(
			"http://local/webhooks/ses",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer event-secret",
				},
				body: JSON.stringify({
					id: "recovery-event-1",
					time: "2026-07-16T10:00:00.000Z",
					detail: {
						eventType: "Bounce",
						mail: {
							messageId: "ses-recovery-1",
							tags: {
								CredentialRecoveryId: ["recovery-delivery-1"],
								CredentialRecoveryAttempt: ["attempt-1"],
							},
						},
					},
				}),
			},
			env,
		);
	assert.equal((await request()).status, 202);
	assert.equal((await request()).status, 202);
	assert.equal(
		database.prepare(
			"SELECT COUNT(*) AS count FROM credential_recovery_delivery_events",
		).get()!.count,
		1,
	);
	const outbox = database.prepare(
		`SELECT state, provider_message_id, provider_event_status
		 FROM credential_recovery_delivery_outbox`,
	).get()!;
	assert.equal(outbox.state, "accepted");
	assert.equal(outbox.provider_message_id, "ses-recovery-1");
	assert.equal(outbox.provider_event_status, "bounce");
	database.close();
});

test("an older exact SES attempt becomes provider truth after a newer dispatch fence", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
		"0012_create_credential_recovery_jobs.sql",
	]) {
		database.exec(
			readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
		);
	}
	database.prepare(
		`INSERT INTO users
		 (id, email, password_hash, password_salt, mailbox_address,
		  ownership_confirmed_at, created_at, updated_at)
		 VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt',
		         'member@wiserchat.ai', 1, 1, 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_tokens
		 (id, user_id, token_hash, expires_at, purpose, created_at)
		 VALUES ('token-1', 'user-1', 'token-hash', 999999999, 'recovery', 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_delivery_outbox
		 (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
		  state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
		  dispatch_started_at, ambiguous_dispatch_count, last_ambiguity_at,
		  created_at, updated_at)
		 VALUES ('recovery-delivery-1', 'token-1', 1, 'AAAAAAAAAAAAAAAA', ?,
		         'dispatching', 1, 1, 'fresh-attempt', 999999999,
		         20, 1, 15, 1, 20)`,
	).run("c".repeat(24));
	database.prepare(
		`INSERT INTO credential_recovery_delivery_attempts
		 (attempt_id, outbox_id, state, dispatch_started_at, resolved_at,
		  created_at, updated_at)
		 VALUES ('old-attempt', 'recovery-delivery-1', 'ambiguous', 10, 15, 10, 15),
		        ('fresh-attempt', 'recovery-delivery-1', 'dispatching', 20, NULL, 20, 20)`,
	).run();

	const app = new Hono();
	app.post("/webhooks/ses", handleSesEvent as never);
	const env = {
		SES_EVENT_WEBHOOK_SECRET: "event-secret",
		DB: d1(database),
	} as unknown as Env;
	const eventResponse = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "late-old-event",
				detail: {
					eventType: "Delivery",
					mail: {
						messageId: "ses-old-message",
						tags: {
							CredentialRecoveryId: ["recovery-delivery-1"],
							CredentialRecoveryAttempt: ["old-attempt"],
						},
					},
				},
			}),
		},
		env,
	);
	assert.equal(eventResponse.status, 202);
	const accepted = database.prepare(
		`SELECT state, lease_token, provider_message_id, accepted_attempt_id
		 FROM credential_recovery_delivery_outbox`,
	).get()!;
	assert.equal(accepted.state, "accepted");
	assert.equal(accepted.lease_token, null);
	assert.equal(accepted.provider_message_id, "ses-old-message");
	assert.equal(accepted.accepted_attempt_id, "old-attempt");

	assert.equal(
		await markCredentialRecoveryAccepted(
			env,
			{ id: "recovery-delivery-1", leaseToken: "fresh-attempt" },
			"ses-fresh-message",
			30,
		),
		true,
	);
	assert.deepEqual(
		database.prepare(
			`SELECT attempt_id, state, provider_message_id
			 FROM credential_recovery_delivery_attempts ORDER BY attempt_id`,
		).all().map((row) => ({ ...row })),
		[
			{
				attempt_id: "fresh-attempt",
				state: "accepted",
				provider_message_id: "ses-fresh-message",
			},
			{
				attempt_id: "old-attempt",
				state: "accepted",
				provider_message_id: "ses-old-message",
			},
		],
	);
	assert.deepEqual(
		{ ...database.prepare(
			`SELECT provider_message_id, accepted_attempt_id
			 FROM credential_recovery_delivery_outbox`,
		).get()! },
		{
			provider_message_id: "ses-old-message",
			accepted_attempt_id: "old-attempt",
		},
	);

	const mismatched = await app.request(
		"http://local/webhooks/ses",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer event-secret",
			},
			body: JSON.stringify({
				id: "mismatched-event",
				detail: {
					eventType: "Delivery",
					mail: {
						messageId: "ses-not-real",
						tags: {
							CredentialRecoveryId: ["recovery-delivery-1"],
							CredentialRecoveryAttempt: ["not-an-attempt"],
						},
					},
				},
			}),
		},
		env,
	);
	assert.equal(mismatched.status, 400);
	database.close();
});

test("an older preserved attempt promotes acceptance from pending or a newer lease", async () => {
	for (const [state, attemptState] of [
		["pending", "ambiguous"],
		["leased", "ambiguous"],
		["pending", "http_rejected"],
		["leased", "http_rejected"],
	] as const) {
		const database = new DatabaseSync(":memory:");
		database.exec("PRAGMA foreign_keys = ON");
		for (const migration of [
			"0001_create_users.sql",
			"0005_auth_security.sql",
			"0006_credential_recovery.sql",
			"0012_create_credential_recovery_jobs.sql",
		]) {
			database.exec(
				readFileSync(
					new URL(`../../migrations/${migration}`, import.meta.url),
					"utf8",
				),
			);
		}
		database.prepare(
			`INSERT INTO users
			 (id, email, password_hash, password_salt, mailbox_address,
			  ownership_confirmed_at, created_at, updated_at)
			 VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt',
			         'member@wiserchat.ai', 1, 1, 1)`,
		).run();
		database.prepare(
			`INSERT INTO credential_recovery_tokens
			 (id, user_id, token_hash, expires_at, purpose, created_at)
			 VALUES ('token-1', 'user-1', 'token-hash', 999999999, 'recovery', 1)`,
		).run();
		database.prepare(
			`INSERT INTO credential_recovery_delivery_outbox
			 (id, token_id, payload_key_version, payload_iv, payload_ciphertext,
			  state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
			  ambiguous_dispatch_count, last_ambiguity_at, created_at, updated_at)
			 VALUES ('recovery-delivery-1', 'token-1', 1, 'AAAAAAAAAAAAAAAA', ?,
			         ?, 1, 1, ?, ?, ?, ?, 1, 20)`,
		).run(
			"c".repeat(24),
			state,
			state === "leased" ? "newer-lease" : null,
			state === "leased" ? 999999999 : null,
			attemptState === "ambiguous" ? 1 : 0,
			attemptState === "ambiguous" ? 15 : null,
		);
		database.prepare(
			`INSERT INTO credential_recovery_delivery_attempts
			 (attempt_id, outbox_id, state, dispatch_started_at, resolved_at,
			  created_at, updated_at)
			 VALUES ('old-attempt', 'recovery-delivery-1', ?, 10, 15, 10, 15)`,
		).run(attemptState);

		const app = new Hono();
		app.post("/webhooks/ses", handleSesEvent as never);
		const env = {
			SES_EVENT_WEBHOOK_SECRET: "event-secret",
			DB: d1(database),
		} as unknown as Env;
		const response = await app.request(
			"http://local/webhooks/ses",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer event-secret",
				},
				body: JSON.stringify({
					id: `late-${state}-${attemptState}-event`,
					detail: {
						eventType: "Delivery",
						mail: {
							messageId: `ses-${state}-${attemptState}-message`,
							tags: {
								CredentialRecoveryId: ["recovery-delivery-1"],
								CredentialRecoveryAttempt: ["old-attempt"],
							},
						},
					},
				}),
			},
			env,
		);
		assert.equal(response.status, 202);
		const accepted = database.prepare(
			`SELECT state, lease_token, provider_message_id, accepted_attempt_id
			 FROM credential_recovery_delivery_outbox`,
		).get()!;
		assert.equal(accepted.state, "accepted");
		assert.equal(accepted.lease_token, null);
		assert.equal(
			accepted.provider_message_id,
			`ses-${state}-${attemptState}-message`,
		);
		assert.equal(accepted.accepted_attempt_id, "old-attempt");
		database.close();
	}
});

test("noncanonical attempt events persist but only canonical acceptance drives provider status", async () => {
	const database = new DatabaseSync(":memory:");
	database.exec("PRAGMA foreign_keys = ON");
	for (const migration of [
		"0001_create_users.sql",
		"0005_auth_security.sql",
		"0006_credential_recovery.sql",
		"0012_create_credential_recovery_jobs.sql",
	]) {
		database.exec(
			readFileSync(new URL(`../../migrations/${migration}`, import.meta.url), "utf8"),
		);
	}
	database.prepare(
		`INSERT INTO users
		 (id, email, password_hash, password_salt, mailbox_address,
		  ownership_confirmed_at, created_at, updated_at)
		 VALUES ('user-1', 'member@wiserchat.ai', 'hash', 'salt',
		         'member@wiserchat.ai', 1, 1, 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_tokens
		 (id, user_id, token_hash, expires_at, purpose, created_at)
		 VALUES ('token-1', 'user-1', 'token-hash', 999999999, 'recovery', 1)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_delivery_outbox
		 (id, token_id, state, attempt_count, next_attempt_at,
		  provider_message_id, accepted_attempt_id, accepted_at, completed_at,
		  ambiguous_dispatch_count, last_ambiguity_at, created_at, updated_at)
		 VALUES ('recovery-delivery-1', 'token-1', 'accepted', 2, 1,
		         'provider-b', 'attempt-b', 30, 30, 1, 20, 1, 30)`,
	).run();
	database.prepare(
		`INSERT INTO credential_recovery_delivery_attempts
		 (attempt_id, outbox_id, state, provider_message_id,
		  dispatch_started_at, resolved_at, created_at, updated_at)
		 VALUES ('attempt-a', 'recovery-delivery-1', 'ambiguous', NULL,
		         10, 20, 10, 20),
		        ('attempt-b', 'recovery-delivery-1', 'accepted', 'provider-b',
		         21, 30, 21, 30)`,
	).run();

	const app = new Hono();
	app.post("/webhooks/ses", handleSesEvent as never);
	const env = {
		SES_EVENT_WEBHOOK_SECRET: "event-secret",
		DB: d1(database),
	} as unknown as Env;
	const send = (
		id: string,
		attemptId: string,
		providerMessageId: string,
		eventType: "Delivery" | "Bounce" | "Complaint",
		occurredAt: number,
	) =>
		app.request(
			"http://local/webhooks/ses",
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer event-secret",
				},
				body: JSON.stringify({
					id,
					time: new Date(occurredAt).toISOString(),
					detail: {
						eventType,
						mail: {
							messageId: providerMessageId,
							tags: {
								CredentialRecoveryId: ["recovery-delivery-1"],
								CredentialRecoveryAttempt: [attemptId],
							},
						},
					},
				}),
			},
			env,
		);

	for (const [id, eventType, occurredAt] of [
		["event-a-delivery", "Delivery", 1_000],
		["event-a-bounce", "Bounce", 2_000],
		["event-a-complaint", "Complaint", 3_000],
	] as const) {
		assert.equal(
			(await send(id, "attempt-a", "provider-a", eventType, occurredAt)).status,
			202,
		);
		const status = database.prepare(
			`SELECT provider_event_status, provider_event_at
			 FROM credential_recovery_delivery_outbox`,
		).get()!;
		assert.equal(status.provider_event_status, null);
		assert.equal(status.provider_event_at, null);
	}
	assert.equal(
		database.prepare(
			"SELECT COUNT(*) AS count FROM credential_recovery_delivery_events WHERE attempt_id = 'attempt-a'",
		).get()!.count,
		3,
	);

	assert.equal(
		(await send("event-b-bounce", "attempt-b", "provider-b", "Bounce", 2_000)).status,
		202,
	);
	assert.equal(
		(await send("event-b-older", "attempt-b", "provider-b", "Delivery", 1_000)).status,
		202,
	);
	let canonical = database.prepare(
		`SELECT provider_event_status, provider_event_at,
		        provider_message_id, accepted_attempt_id
		 FROM credential_recovery_delivery_outbox`,
	).get()!;
	assert.equal(canonical.provider_event_status, "bounce");
	assert.equal(canonical.provider_event_at, 2_000);
	assert.equal(canonical.provider_message_id, "provider-b");
	assert.equal(canonical.accepted_attempt_id, "attempt-b");
	assert.equal(
		(await send("event-b-complaint", "attempt-b", "provider-b", "Complaint", 3_000)).status,
		202,
	);
	assert.equal(
		(await send("event-b-complaint", "attempt-b", "provider-b", "Complaint", 3_000)).status,
		202,
	);
	canonical = database.prepare(
		`SELECT provider_event_status, provider_event_at
		 FROM credential_recovery_delivery_outbox`,
	).get()!;
	assert.equal(canonical.provider_event_status, "complaint");
	assert.equal(canonical.provider_event_at, 3_000);
	assert.equal(
		database.prepare(
			"SELECT COUNT(*) AS count FROM credential_recovery_delivery_events",
		).get()!.count,
		6,
	);
	database.close();
});
