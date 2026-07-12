import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { mailboxMigrations } from "../../durableObject/migrations.ts";
import { buildPushPayload } from "./payload.ts";
import {
	enqueuePushNotification,
	processPushOutbox,
	readPushHealth,
	sendPushBeforeDeadline,
	type PushOutboxStorage,
} from "./outbox.ts";

const NOW = Date.parse("2026-07-12T10:00:00.000Z");

function harness() {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE emails (id TEXT PRIMARY KEY);
		CREATE TABLE push_subscriptions (
		 id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL,
		 auth TEXT NOT NULL, user_agent TEXT, device_label TEXT,
		 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
		 last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), user_id TEXT
		);
	`);
	const migration = mailboxMigrations.find((item) => item.name === "25_add_durable_push_outbox");
	assert.ok(migration);
	db.exec(migration.sql);
	const sql = {
		exec<T extends Record<string, string | number | null>>(query: string, ...bindings: Array<string | number | null>): Iterable<T> {
			const statement = db.prepare(query);
			if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) return statement.all(...bindings) as T[];
			statement.run(...bindings);
			return [];
		},
	};
	const storage: PushOutboxStorage = {
		sql,
		transactionSync<T>(operation: () => T): T {
			db.exec("BEGIN");
			try {
				const result = operation();
				db.exec("COMMIT");
				return result;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	};
	return { db, storage };
}

function payload(emailId = "message-1") {
	return buildPushPayload({
		emailId,
		mailboxId: "team@example.com",
		fromName: "Mona",
		fromAddress: "mona@example.net",
		subject: "Proposal",
		body: "Please review",
		icon: "/icon.png",
		badge: "/badge.png",
	});
}

function seed(db: DatabaseSync, input: { emailId?: string; deviceId?: string; userId?: string } = {}) {
	const emailId = input.emailId ?? "message-1";
	const deviceId = input.deviceId ?? "device-1";
	const userId = input.userId ?? "user-1";
	db.prepare("INSERT INTO emails VALUES (?)").run(emailId);
	db.prepare(`INSERT INTO push_subscriptions
	 (id, endpoint, p256dh, auth, device_label, created_at, last_seen_at, user_id)
	 VALUES (?, ?, 'key', 'auth', 'Chrome on Mac', ?, ?, ?)`)
		.run(deviceId, `https://push.example/${deviceId}`, new Date(NOW).toISOString(), new Date(NOW).toISOString(), userId);
}

test("atomic enqueue snapshots only devices present at Message acceptance", () => {
	const { db, storage } = harness();
	seed(db);
	storage.transactionSync(() => enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	}));
	seed(db, { emailId: "message-2", deviceId: "device-2", userId: "user-2" });
	assert.deepEqual(
		db.prepare("SELECT subscription_id, target_user_id FROM push_notification_deliveries").all()
			.map((row) => ({ ...row })),
		[{ subscription_id: "device-1", target_user_id: "user-1" }],
	);
	assert.throws(() => storage.transactionSync(() => enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	})));
	db.close();
});

test("accepted handoff atomically settles delivery and actor-private device health", async () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	const alarms: number[] = [];
	const next = await processPushOutbox({
		storage,
		vapidConfigured: true,
		canAccess: async () => true,
		send: async () => ({ ok: true }),
		now: () => NOW,
		createToken: () => "lease-1",
		scheduleAlarmAt: async (at) => { alarms.push(at); },
	});
	assert.equal(db.prepare("SELECT status FROM push_notification_deliveries").get()?.status, "accepted");
	assert.equal(db.prepare("SELECT state FROM push_notifications").get()?.state, "completed");
	assert.equal(alarms[0], NOW + 30_000);
	assert.equal(next, NOW + 7 * 24 * 60 * 60_000);
	assert.deepEqual(readPushHealth(storage.sql, {
		userId: "user-1", configured: true, now: new Date(NOW).toISOString(),
	}), {
		state: "healthy",
		pendingCount: 0,
		refreshedAt: new Date(NOW).toISOString(),
		devices: [{
			id: "device-1", label: "Chrome on Mac", registeredAt: new Date(NOW).toISOString(),
			lastAttemptAt: new Date(NOW).toISOString(), lastAcceptedAt: new Date(NOW).toISOString(),
			health: "accepted", consecutiveFailures: 0,
		}],
	});
	db.close();
});

test("a capability rebound to another actor is never dispatched to the old target", async () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	db.prepare("UPDATE push_subscriptions SET user_id='user-2', generation=2 WHERE id='device-1'").run();
	let sends = 0;
	await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => { sends += 1; return { ok: true }; }, now: () => NOW,
		createToken: () => "lease-1", scheduleAlarmAt: async () => undefined,
	});
	assert.equal(sends, 0);
	assert.equal(db.prepare("SELECT last_reason FROM push_notification_deliveries").get()?.last_reason, "subscription_removed");
	db.close();
});

test("a refreshed generation fences an in-flight 410 and retries without deleting the device", async () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => {
			db.prepare("UPDATE push_subscriptions SET generation=2, p256dh='new-key' WHERE id='device-1'").run();
			return { ok: false, reason: "PERMISSION_REVOKED", shouldDelete: true, statusCode: 410 };
		},
		now: () => NOW, createToken: () => "lease-1", scheduleAlarmAt: async () => undefined,
	});
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get()?.count, 1);
	assert.equal(db.prepare("SELECT status FROM push_notification_deliveries").get()?.status, "retrying");
	db.close();
});

test("corrupted stored payload and missing VAPID perform no provider call", async () => {
	for (const corrupted of [true, false]) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		if (corrupted) db.prepare("UPDATE push_notifications SET payload_json='{}'").run();
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: corrupted, canAccess: async () => true,
			send: async () => { sends += 1; return { ok: true }; }, now: () => NOW,
			createToken: () => "lease-1", scheduleAlarmAt: async () => undefined,
		});
		assert.equal(sends, 0);
		assert.equal(db.prepare("SELECT status FROM push_notification_deliveries").get()?.status, "terminal");
		db.close();
	}
});

test("transport outcomes use the closed retry and terminal classification", async () => {
	const cases = [
		{ status: 400, expected: "terminal", reason: "configuration_issue", removed: false },
		{ status: 401, expected: "terminal", reason: "configuration_issue", removed: false },
		{ status: 403, expected: "terminal", reason: "configuration_issue", removed: false },
		{ status: 404, expected: "terminal", reason: "permission_revoked", removed: true },
		{ status: 410, expected: "terminal", reason: "permission_revoked", removed: true },
		{ status: 413, expected: "terminal", reason: "payload_defect", removed: false },
		{ status: 429, expected: "retrying", reason: "temporary_issue", removed: false },
		{ status: 500, expected: "retrying", reason: "temporary_issue", removed: false },
		{ status: 503, expected: "retrying", reason: "temporary_issue", removed: false },
		{ status: null, expected: "retrying", reason: "temporary_issue", removed: false },
	] as const;
	for (const item of cases) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		await processPushOutbox({
			storage, vapidConfigured: true, canAccess: async () => true,
			send: async () => ({
				ok: false,
				reason: item.status === 404 || item.status === 410 ? "PERMISSION_REVOKED" : "SEND_FAILED",
				shouldDelete: item.removed,
				statusCode: item.status,
			}),
			now: () => NOW, createToken: () => "lease", scheduleAlarmAt: async () => undefined,
		});
		assert.deepEqual({ ...db.prepare(
			"SELECT status, last_reason AS reason FROM push_notification_deliveries",
		).get()! }, { status: item.expected, reason: item.reason });
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get()?.count, item.removed ? 0 : 1);
		db.close();
	}
});

test("authorization revocation deletes the exact device while authority outage retries fail closed", async () => {
	for (const mode of ["revoked", "outage"] as const) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: true,
			canAccess: async () => {
				if (mode === "outage") throw new Error("D1 unavailable");
				return false;
			},
			send: async () => { sends += 1; return { ok: true }; },
			now: () => NOW, createToken: () => "lease", scheduleAlarmAt: async () => undefined,
		});
		assert.equal(sends, 0);
		assert.equal(db.prepare("SELECT status FROM push_notification_deliveries").get()?.status,
			mode === "revoked" ? "terminal" : "retrying");
		assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_subscriptions").get()?.count,
			mode === "revoked" ? 0 : 1);
		db.close();
	}
});

test("attempt cap, hard deadline, expired lease, and alarm failure remain bounded", async () => {
	for (const mode of ["cap", "deadline", "lease", "alarm"] as const) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		if (mode === "cap") db.prepare("UPDATE push_notification_deliveries SET attempt_count=3").run();
		if (mode === "deadline") db.prepare("UPDATE push_notifications SET expires_at=?").run(new Date(NOW).toISOString());
		if (mode === "lease") db.prepare(`UPDATE push_notification_deliveries SET
		 status='sending', attempt_count=1, lease_token='old', lease_expires_at=?`).run(new Date(NOW).toISOString());
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: true, canAccess: async () => true,
			send: async () => { sends += 1; return mode === "lease" ? { ok: true } : {
				ok: false, reason: "SERVICE_UNAVAILABLE", shouldDelete: false, statusCode: 503,
			}; },
			now: () => NOW, createToken: () => "new-lease",
			scheduleAlarmAt: async () => { if (mode === "alarm") throw new Error("alarm unavailable"); },
		});
		const row = db.prepare("SELECT status, attempt_count AS attempts, next_attempt_at AS nextAt FROM push_notification_deliveries").get() as Record<string, unknown>;
		if (mode === "cap" || mode === "deadline") assert.equal(row.status, "terminal");
		if (mode === "cap") assert.equal(db.prepare("SELECT state FROM push_notifications").get()?.state, "completed");
		if (mode === "deadline") assert.equal(db.prepare("SELECT state FROM push_notifications").get()?.state, "expired");
		if (mode === "lease") { assert.equal(row.status, "accepted"); assert.equal(row.attempts, 2); }
		if (mode === "alarm") {
			assert.equal(row.status, "retrying");
			assert.equal(row.nextAt, new Date(NOW + 10_000).toISOString());
			assert.equal(sends, 0);
		}
		db.close();
	}
});

test("terminal infrastructure exhaustion remains visible as degraded device health", async () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	db.prepare("UPDATE push_notification_deliveries SET attempt_count=3").run();
	await processPushOutbox({
		storage, vapidConfigured: true,
		canAccess: async () => { throw new Error("authority unavailable"); },
		send: async () => ({ ok: true }), now: () => NOW,
		createToken: () => "lease", scheduleAlarmAt: async () => undefined,
	});
	const health = readPushHealth(storage.sql, {
		userId: "user-1", configured: true, now: new Date(NOW).toISOString(),
	});
	assert.equal(db.prepare("SELECT last_reason FROM push_notification_deliveries").get()?.last_reason, "attempts_exhausted");
	assert.equal(health.state, "degraded");
	assert.equal(health.pendingCount, 0);
	assert.equal(health.devices[0]?.health, "temporary_issue");
	db.close();
});

test("batch wall budget reserves the full provider timeout before another send", async () => {
	const { db, storage } = harness();
	for (let index = 0; index < 3; index += 1) {
		seed(db, {
			emailId: index === 0 ? "message-1" : `unused-${index}`,
			deviceId: `device-${index}`,
			userId: `user-${index}`,
		});
	}
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	let clock = NOW;
	let sends = 0;
	await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => {
			sends += 1;
			clock += 8_000;
			return { ok: true };
		},
		now: () => clock,
		createToken: () => `lease-${sends}`,
		scheduleAlarmAt: async () => undefined,
	});
	assert.equal(sends, 2);
	assert.equal(clock - NOW, 16_000);
	assert.equal(db.prepare(
		"SELECT COUNT(*) AS count FROM push_notification_deliveries WHERE status='pending'",
	).get()?.count, 1);
	db.close();
});

test("the coordinator aborts and returns when the complete transport misses its deadline", async () => {
	let aborted = false;
	const startedAt = Date.now();
	const outcome = await sendPushBeforeDeadline({
		deadlineMs: startedAt + 15,
		send: (signal) => new Promise((_resolve) => {
			signal.addEventListener("abort", () => { aborted = true; }, { once: true });
		}),
	});
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.result.ok, false);
	assert.equal(aborted, true);
	assert.ok(Date.now() - startedAt < 250);
});

test("a late transport result can never finalize accepted across expiry or batch boundaries", async () => {
	for (const boundary of ["expiry", "batch"] as const) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		let clock = NOW;
		if (boundary === "expiry") {
			db.prepare("UPDATE push_notifications SET expires_at=?").run(
				new Date(NOW + 8_501).toISOString(),
			);
		}
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: true,
			canAccess: async () => {
				if (boundary === "batch") clock = NOW + 11_499;
				return true;
			},
			send: async () => {
				sends += 1;
				clock += 8_002;
				return { ok: true };
			},
			now: () => clock,
			createToken: () => "lease",
			scheduleAlarmAt: async () => undefined,
		});
		assert.equal(sends, 1);
		const row = { ...db.prepare(
			`SELECT n.state, d.status, d.last_reason AS reason
			 FROM push_notifications n
			 JOIN push_notification_deliveries d ON d.notification_id=n.id`,
		).get()! };
		if (boundary === "expiry") {
			assert.deepEqual(row, { state: "expired", status: "terminal", reason: "expired" });
		} else {
			assert.deepEqual(row, { state: "pending", status: "retrying", reason: "temporary_issue" });
			assert.ok(clock - NOW < 20_000);
		}
		db.close();
	}
});

test("dispatch never starts when the provider timeout could cross Message expiry", async () => {
	for (const advanceDuringAlarm of [false, true]) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		let clock = NOW;
		db.prepare("UPDATE push_notifications SET expires_at=?").run(
			new Date(NOW + (advanceDuringAlarm ? 9_000 : 7_000)).toISOString(),
		);
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: true, canAccess: async () => true,
			send: async () => { sends += 1; return { ok: true }; },
			now: () => clock,
			createToken: () => "lease",
			scheduleAlarmAt: async () => {
				if (advanceDuringAlarm) clock += 2_000;
			},
		});
		assert.equal(sends, 0);
		assert.deepEqual({ ...db.prepare(
			`SELECT n.state, d.status, d.last_reason AS reason
			 FROM push_notifications n
			 JOIN push_notification_deliveries d ON d.notification_id=n.id`,
		).get()! }, { state: "expired", status: "terminal", reason: "expired" });
		assert.equal(readPushHealth(storage.sql, {
			userId: "user-1", configured: true, now: new Date(clock).toISOString(),
		}).state, "degraded");
		db.close();
	}
});

test("alarm and authority stages cannot start a send at the exact batch boundary", async () => {
	for (const slowStage of ["alarm", "authority"] as const) {
		const { db, storage } = harness();
		seed(db);
		enqueuePushNotification(storage.sql, {
			emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
		});
		let clock = NOW;
		let sends = 0;
		await processPushOutbox({
			storage, vapidConfigured: true,
			canAccess: async () => {
				if (slowStage === "authority") clock = NOW + 12_000;
				return true;
			},
			send: async () => { sends += 1; return { ok: true }; },
			now: () => clock,
			createToken: () => "lease",
			scheduleAlarmAt: async () => {
				if (slowStage === "alarm") clock = NOW + 12_000;
			},
		});
		assert.equal(sends, 0);
		assert.deepEqual({ ...db.prepare(
			"SELECT status, attempt_count AS attempts FROM push_notification_deliveries",
		).get()! }, { status: "pending", attempts: 0 });
		db.close();
	}
});

test("mailbox identity corruption is rejected before access or provider dispatch", async () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	db.prepare("UPDATE push_notifications SET mailbox_id='other@example.com'").run();
	let externalCalls = 0;
	await processPushOutbox({
		storage, vapidConfigured: true,
		canAccess: async () => { externalCalls += 1; return true; },
		send: async () => { externalCalls += 1; return { ok: true }; },
		now: () => NOW, createToken: () => "lease", scheduleAlarmAt: async () => undefined,
	});
	assert.equal(externalCalls, 0);
	assert.equal(db.prepare("SELECT last_reason FROM push_notification_deliveries").get()?.last_reason, "payload_defect");
	db.close();
});

test("removing the last device cannot leave actor health retrying for a dead target", () => {
	const { db, storage } = harness();
	seed(db);
	enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	db.prepare("DELETE FROM push_subscriptions WHERE id='device-1'").run();
	assert.deepEqual(readPushHealth(storage.sql, {
		userId: "user-1", configured: true, now: new Date(NOW).toISOString(),
	}), {
		state: "no_devices", pendingCount: 0, refreshedAt: new Date(NOW).toISOString(), devices: [],
	});
	db.close();
});

test("batch size, no-target completion, and seven-day prune stay bounded", async () => {
	const { db, storage } = harness();
	db.prepare("INSERT INTO emails VALUES ('message-1')").run();
	const noTargets = enqueuePushNotification(storage.sql, {
		emailId: "message-1", mailboxId: "team@example.com", payload: payload(), now: new Date(NOW).toISOString(),
	});
	assert.equal(noTargets.targetCount, 0);
	assert.equal(db.prepare("SELECT state FROM push_notifications").get()?.state, "no_targets");
	const retentionAlarm = await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => ({ ok: true }), now: () => NOW,
		createToken: () => "no-target", scheduleAlarmAt: async () => undefined,
	});
	assert.equal(retentionAlarm, NOW + 7 * 24 * 60 * 60_000);
	for (let index = 0; index < 11; index += 1) {
		db.prepare(`INSERT INTO push_subscriptions
		 (id, endpoint, p256dh, auth, device_label, created_at, last_seen_at, user_id)
		 VALUES (?, ?, 'key', 'auth', 'Device', ?, ?, ?)`)
			.run(`device-${index}`, `https://push.example/${index}`, new Date(NOW).toISOString(), new Date(NOW).toISOString(), `user-${index}`);
	}
	db.prepare("INSERT INTO emails VALUES ('message-2')").run();
	enqueuePushNotification(storage.sql, {
		emailId: "message-2", mailboxId: "team@example.com", payload: payload("message-2"), now: new Date(NOW).toISOString(),
	});
	let sends = 0;
	await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => { sends += 1; return { ok: true }; }, now: () => NOW,
		createToken: () => `lease-${sends}`, scheduleAlarmAt: async () => undefined,
	});
	assert.equal(sends, 10);
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_notification_deliveries WHERE status='pending'").get()?.count, 1);
	const old = new Date(NOW - 8 * 24 * 60 * 60_000).toISOString();
	for (let index = 0; index < 101; index += 1) {
		db.prepare("INSERT INTO emails VALUES (?)").run(`old-${index}`);
		db.prepare(`INSERT INTO push_notifications
		 (id,email_id,mailbox_id,payload_json,state,target_count,created_at,expires_at,completed_at)
		 VALUES (?,?, 'team@example.com','{}','no_targets',0,?,?,?)`)
			.run(`old-push-${index}`, `old-${index}`, old, old, old);
	}
	await processPushOutbox({
		storage, vapidConfigured: true, canAccess: async () => true,
		send: async () => ({ ok: true }), now: () => NOW,
		createToken: () => "lease-extra", scheduleAlarmAt: async () => undefined,
	});
	assert.equal(db.prepare("SELECT COUNT(*) AS count FROM push_notifications WHERE id LIKE 'old-push-%'").get()?.count, 1);
	db.close();
});
