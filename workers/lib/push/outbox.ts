import type { PushHealthResponse, PushDeviceHealthState } from "../../../shared/push-health.ts";
import type { PushPayload, PushSubscription, SendPushResult } from "./types.ts";
import { validateStoredPushPayload } from "./types.ts";

type SqlValue = string | number | null;

export interface PushOutboxSql {
	exec<T extends Record<string, SqlValue>>(
		query: string,
		...bindings: SqlValue[]
	): Iterable<T>;
}

export interface PushOutboxStorage {
	sql: PushOutboxSql;
	transactionSync<T>(closure: () => T): T;
}

export const PUSH_OUTBOX_LIMITS = {
	expiryMs: 5 * 60_000,
	retentionMs: 7 * 24 * 60 * 60_000,
	leaseMs: 30_000,
	batchSize: 10,
	batchWallMs: 20_000,
	sendBudgetMs: 8_000,
	finalizationBudgetMs: 500,
	maxAttempts: 4,
	pruneLimit: 100,
	retryMs: [10_000, 30_000, 120_000] as const,
};

export type PushOutboxSafeReason =
	| "temporary_issue"
	| "permission_revoked"
	| "payload_defect"
	| "configuration_issue"
	| "authorization_revoked"
	| "subscription_removed"
	| "service_unavailable"
	| "attempts_exhausted"
	| "expired";

export function enqueuePushNotification(
	sql: PushOutboxSql,
	input: { emailId: string; mailboxId: string; payload: PushPayload; now: string },
): { notificationId: string; targetCount: number } {
	const payload = validateStoredPushPayload(input.payload, input);
	const nowMs = Date.parse(input.now);
	if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== input.now) {
		throw new Error("Push notification timestamp is invalid");
	}
	const notificationId = `push:${input.emailId}`;
	const expiresAt = new Date(nowMs + PUSH_OUTBOX_LIMITS.expiryMs).toISOString();
	sql.exec(
		`INSERT INTO push_notifications
		 (id, email_id, mailbox_id, payload_json, state, target_count, created_at, expires_at)
		 VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
		notificationId,
		input.emailId,
		input.mailboxId.trim().toLowerCase(),
		JSON.stringify(payload),
		input.now,
		expiresAt,
	);
	sql.exec(
		`INSERT INTO push_notification_deliveries
		 (notification_id, subscription_id, target_user_id, status, attempt_count,
		  next_attempt_at, created_at, updated_at)
		 SELECT ?, id, user_id, 'pending', 0, ?, ?, ?
		 FROM push_subscriptions
		 WHERE user_id IS NOT NULL`,
		notificationId,
		input.now,
		input.now,
		input.now,
	);
	const targetCount = Number([...sql.exec<{ count: number }>(
		"SELECT COUNT(*) AS count FROM push_notification_deliveries WHERE notification_id = ?",
		notificationId,
	)][0]?.count ?? 0);
	sql.exec(
		`UPDATE push_notifications
		 SET target_count = ?, state = ?, completed_at = ?
		 WHERE id = ?`,
		targetCount,
		targetCount === 0 ? "no_targets" : "pending",
		targetCount === 0 ? input.now : null,
		notificationId,
	);
	return { notificationId, targetCount };
}

type DueDelivery = {
	notificationId: string;
	subscriptionId: string;
	targetUserId: string;
	attemptCount: number;
	payloadJson: string;
	expiresAt: string;
	emailId: string;
	mailboxId: string;
	leaseExpiresAt: string;
};

type SubscriptionIdentity = { id: string; userId: string; generation: number };
type SubscriptionCapability = SubscriptionIdentity & PushSubscription;

export type ProcessPushOutboxDependencies = {
	storage: PushOutboxStorage;
	vapidConfigured: boolean;
	canAccess(userId: string, mailboxId: string): Promise<boolean>;
	send(
		subscription: PushSubscription,
		payload: string,
		options: { signal: AbortSignal; deadlineMs: number },
	): Promise<SendPushResult>;
	scheduleAlarmAt?(timestamp: number): Promise<void>;
	now?: () => number;
	createToken?: () => string;
};

function first<T extends Record<string, SqlValue>>(
	sql: PushOutboxSql,
	query: string,
	...bindings: SqlValue[]
): T | null {
	return [...sql.exec<T>(query, ...bindings)][0] ?? null;
}

function recoverAndExpire(sql: PushOutboxSql, now: string): void {
	sql.exec(
		`UPDATE push_subscriptions
		 SET last_push_attempt_at = ?, last_push_failure_at = ?,
		     last_push_failure_reason = 'expired',
		     consecutive_push_failures = consecutive_push_failures + 1
		 WHERE EXISTS (
		   SELECT 1
		   FROM push_notification_deliveries d
		   JOIN push_notifications n ON n.id = d.notification_id
		   WHERE d.subscription_id = push_subscriptions.id
		     AND d.target_user_id = push_subscriptions.user_id
		     AND d.status IN ('pending', 'retrying', 'sending')
		     AND n.expires_at <= ?
		 )`,
		now,
		now,
		now,
	);
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'terminal', terminal_at = ?, updated_at = ?,
		     lease_token = NULL, lease_expires_at = NULL,
		     last_reason = 'attempts_exhausted'
		 WHERE status = 'sending' AND lease_expires_at <= ? AND attempt_count >= ?`,
		now,
		now,
		now,
		PUSH_OUTBOX_LIMITS.maxAttempts,
	);
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'retrying', next_attempt_at = ?, lease_token = NULL,
		     lease_expires_at = NULL, last_reason = 'temporary_issue', updated_at = ?
		 WHERE status = 'sending' AND lease_expires_at <= ? AND attempt_count < ?`,
		now,
		now,
		now,
		PUSH_OUTBOX_LIMITS.maxAttempts,
	);
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'terminal', terminal_at = ?, updated_at = ?,
		     last_reason = 'expired', lease_token = NULL, lease_expires_at = NULL
		 WHERE status IN ('pending', 'retrying', 'sending')
		   AND notification_id IN (
		     SELECT id FROM push_notifications WHERE expires_at <= ?
		   )`,
		now,
		now,
		now,
	);
	sql.exec(
		`UPDATE push_notifications
		 SET state = 'expired', completed_at = COALESCE(completed_at, ?)
		 WHERE state = 'pending' AND expires_at <= ?`,
		now,
		now,
	);
	sql.exec(
		`UPDATE push_notifications SET state = 'completed', completed_at = COALESCE(completed_at, ?)
		 WHERE state = 'pending' AND NOT EXISTS (
		   SELECT 1 FROM push_notification_deliveries d
		   WHERE d.notification_id = push_notifications.id
		     AND d.status IN ('pending', 'sending', 'retrying')
		 )`,
		now,
	);
}

function prune(sql: PushOutboxSql, before: string): void {
	sql.exec(
		`DELETE FROM push_notifications WHERE id IN (
		 SELECT id FROM push_notifications
		 WHERE state IN ('completed', 'no_targets', 'expired')
		   AND COALESCE(completed_at, created_at) <= ?
		 ORDER BY COALESCE(completed_at, created_at) ASC, id ASC
		 LIMIT ?
		)`,
		before,
		PUSH_OUTBOX_LIMITS.pruneLimit,
	);
}

function claimNext(
	storage: PushOutboxStorage,
	now: string,
	token: string,
): DueDelivery | null {
	return storage.transactionSync(() => {
		const row = first<DueDelivery>(
			storage.sql,
			`SELECT d.notification_id AS notificationId,
			        d.subscription_id AS subscriptionId,
			        d.target_user_id AS targetUserId,
			        d.attempt_count AS attemptCount,
			        n.payload_json AS payloadJson,
			        n.expires_at AS expiresAt,
			        n.email_id AS emailId
			        , n.mailbox_id AS mailboxId
			 FROM push_notification_deliveries d
			 JOIN push_notifications n ON n.id = d.notification_id
			 WHERE d.status IN ('pending', 'retrying')
			   AND d.next_attempt_at <= ? AND n.state = 'pending' AND n.expires_at > ?
			 ORDER BY d.next_attempt_at ASC, d.notification_id ASC, d.subscription_id ASC
			 LIMIT 1`,
			now,
			now,
		);
		if (!row) return null;
		const leaseExpiresAt = new Date(Date.parse(now) + PUSH_OUTBOX_LIMITS.leaseMs).toISOString();
		storage.sql.exec(
			`UPDATE push_notification_deliveries
			 SET status = 'sending', attempt_count = attempt_count + 1,
			     lease_token = ?, lease_expires_at = ?, updated_at = ?
			 WHERE notification_id = ? AND subscription_id = ?
			   AND status IN ('pending', 'retrying')`,
			token,
			leaseExpiresAt,
			now,
			row.notificationId,
			row.subscriptionId,
		);
		return { ...row, attemptCount: row.attemptCount + 1, leaseExpiresAt };
	});
}

function expireNotification(
	sql: PushOutboxSql,
	notificationId: string,
	now: string,
): void {
	sql.exec(
		`UPDATE push_subscriptions
		 SET last_push_attempt_at = ?, last_push_failure_at = ?,
		     last_push_failure_reason = 'expired',
		     consecutive_push_failures = consecutive_push_failures + 1
		 WHERE EXISTS (
		   SELECT 1 FROM push_notification_deliveries d
		   WHERE d.notification_id = ?
		     AND d.subscription_id = push_subscriptions.id
		     AND d.target_user_id = push_subscriptions.user_id
		     AND d.status IN ('pending', 'retrying', 'sending')
		 )`,
		now,
		now,
		notificationId,
	);
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'terminal', terminal_at = ?, updated_at = ?,
		     last_reason = 'expired', lease_token = NULL, lease_expires_at = NULL
		 WHERE notification_id = ? AND status IN ('pending', 'retrying', 'sending')`,
		now,
		now,
		notificationId,
	);
	sql.exec(
		`UPDATE push_notifications
		 SET state = 'expired', completed_at = COALESCE(completed_at, ?)
		 WHERE id = ? AND state = 'pending'`,
		now,
		notificationId,
	);
}

function identity(sql: PushOutboxSql, subscriptionId: string): SubscriptionIdentity | null {
	return first<SubscriptionIdentity>(sql,
		`SELECT id, user_id AS userId, generation
		 FROM push_subscriptions WHERE id = ? AND user_id IS NOT NULL`,
		subscriptionId,
	);
}

function capability(
	sql: PushOutboxSql,
	subscriptionId: string,
	targetUserId: string,
): SubscriptionCapability | null {
	return first<SubscriptionCapability>(sql,
		`SELECT id, user_id AS userId, generation, endpoint, p256dh, auth
		 FROM push_subscriptions WHERE id = ? AND user_id = ?`,
		subscriptionId,
		targetUserId,
	);
}

function ownsLease(sql: PushOutboxSql, row: DueDelivery, token: string): boolean {
	return Boolean(first<{ found: number }>(sql,
		`SELECT 1 AS found FROM push_notification_deliveries
		 WHERE notification_id = ? AND subscription_id = ?
		   AND status = 'sending' AND lease_token = ?`,
		row.notificationId,
		row.subscriptionId,
		token,
	));
}

function completeNotification(sql: PushOutboxSql, notificationId: string, now: string): void {
	const active = Number(first<{ count: number }>(sql,
		`SELECT COUNT(*) AS count FROM push_notification_deliveries
		 WHERE notification_id = ? AND status IN ('pending', 'retrying', 'sending')`,
		notificationId,
	)?.count ?? 0);
	if (active === 0) {
		sql.exec(
			`UPDATE push_notifications
			 SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'completed' END,
			     completed_at = ?
			 WHERE id = ? AND state = 'pending'`,
			now,
			now,
			notificationId,
		);
	}
}

function deferClaim(
	sql: PushOutboxSql,
	row: DueDelivery,
	token: string,
	now: string,
): void {
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'pending', attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
		     next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL
		 WHERE notification_id = ? AND subscription_id = ?
		   AND status = 'sending' AND lease_token = ?`,
		now,
		now,
		row.notificationId,
		row.subscriptionId,
		token,
	);
}

function terminal(
	sql: PushOutboxSql,
	row: DueDelivery,
	token: string,
	now: string,
	reason: PushOutboxSafeReason,
	httpStatus: number | null = null,
): void {
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'terminal', terminal_at = ?, updated_at = ?, last_reason = ?,
		     last_http_status = ?, lease_token = NULL, lease_expires_at = NULL
		 WHERE notification_id = ? AND subscription_id = ?
		   AND status = 'sending' AND lease_token = ?`,
		now,
		now,
		reason,
		httpStatus,
		row.notificationId,
		row.subscriptionId,
		token,
	);
	completeNotification(sql, row.notificationId, now);
}

function retry(
	sql: PushOutboxSql,
	row: DueDelivery,
	token: string,
	nowMs: number,
	reason: PushOutboxSafeReason = "temporary_issue",
): void {
	const now = new Date(nowMs).toISOString();
	if (
		row.attemptCount >= PUSH_OUTBOX_LIMITS.maxAttempts ||
		nowMs >= Date.parse(row.expiresAt)
	) {
		terminal(sql, row, token, now, row.attemptCount >= PUSH_OUTBOX_LIMITS.maxAttempts ? "attempts_exhausted" : "expired");
		return;
	}
	const delay = PUSH_OUTBOX_LIMITS.retryMs[Math.min(row.attemptCount - 1, PUSH_OUTBOX_LIMITS.retryMs.length - 1)]!;
	sql.exec(
		`UPDATE push_notification_deliveries
		 SET status = 'retrying', next_attempt_at = ?, updated_at = ?, last_reason = ?,
		     lease_token = NULL, lease_expires_at = NULL
		 WHERE notification_id = ? AND subscription_id = ?
		   AND status = 'sending' AND lease_token = ?`,
		new Date(Math.min(nowMs + delay, Date.parse(row.expiresAt))).toISOString(),
		now,
		reason,
		row.notificationId,
		row.subscriptionId,
		token,
	);
}

function updateDeviceFailure(
	sql: PushOutboxSql,
	capability: SubscriptionCapability,
	now: string,
	reason: PushOutboxSafeReason,
): void {
	sql.exec(
		`UPDATE push_subscriptions
		 SET last_push_attempt_at = ?, last_push_failure_at = ?,
		     last_push_failure_reason = ?,
		     consecutive_push_failures = consecutive_push_failures + 1
		 WHERE id = ? AND user_id = ? AND generation = ?
		   AND endpoint = ? AND p256dh = ? AND auth = ?`,
		now,
		now,
		reason,
		capability.id,
		capability.userId,
		capability.generation,
		capability.endpoint,
		capability.p256dh,
		capability.auth,
	);
}

function updateDeviceFailureByIdentity(
	sql: PushOutboxSql,
	current: SubscriptionIdentity,
	now: string,
	reason: PushOutboxSafeReason,
): void {
	sql.exec(
		`UPDATE push_subscriptions
		 SET last_push_attempt_at = ?, last_push_failure_at = ?,
		     last_push_failure_reason = ?,
		     consecutive_push_failures = consecutive_push_failures + 1
		 WHERE id = ? AND user_id = ? AND generation = ?`,
		now,
		now,
		reason,
		current.id,
		current.userId,
		current.generation,
	);
}

class PushOutboxStageDeadlineError extends Error {}

async function awaitBeforeDeadline<T>(
	work: Promise<T>,
	remainingMs: number,
): Promise<T> {
	if (remainingMs <= 0) throw new PushOutboxStageDeadlineError();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(
					() => reject(new PushOutboxStageDeadlineError()),
					remainingMs,
				);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

const PUSH_SEND_TIMEOUT_RESULT: SendPushResult = {
	ok: false,
	reason: "SEND_FAILED",
	shouldDelete: false,
	statusCode: null,
};

export async function sendPushBeforeDeadline(input: {
	deadlineMs: number;
	now?: () => number;
	send(signal: AbortSignal): Promise<SendPushResult>;
}): Promise<{ result: SendPushResult; timedOut: boolean }> {
	const clock = input.now ?? Date.now;
	const remainingMs = input.deadlineMs - clock();
	if (remainingMs <= 0) {
		return { result: PUSH_SEND_TIMEOUT_RESULT, timedOut: true };
	}
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const work = Promise.resolve()
		.then(() => input.send(controller.signal))
		.then(
			(result) => ({ result, timedOut: false }),
			() => ({ result: PUSH_SEND_TIMEOUT_RESULT, timedOut: false }),
		);
	const deadline = new Promise<{ result: SendPushResult; timedOut: boolean }>((resolve) => {
		timeout = setTimeout(() => {
			controller.abort();
			resolve({ result: PUSH_SEND_TIMEOUT_RESULT, timedOut: true });
		}, remainingMs);
	});
	try {
		return await Promise.race([work, deadline]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export async function processPushOutbox(
	dependencies: ProcessPushOutboxDependencies,
): Promise<number | null> {
	const clock = dependencies.now ?? Date.now;
	const token = dependencies.createToken ?? crypto.randomUUID;
	const startedAt = clock();
	const initialNow = new Date(startedAt).toISOString();
	dependencies.storage.transactionSync(() => {
		recoverAndExpire(dependencies.storage.sql, initialNow);
		prune(
			dependencies.storage.sql,
			new Date(startedAt - PUSH_OUTBOX_LIMITS.retentionMs).toISOString(),
		);
	});

	for (let processed = 0; processed < PUSH_OUTBOX_LIMITS.batchSize; processed += 1) {
		if (
			clock() - startedAt >=
			PUSH_OUTBOX_LIMITS.batchWallMs -
			PUSH_OUTBOX_LIMITS.sendBudgetMs -
			PUSH_OUTBOX_LIMITS.finalizationBudgetMs
		) break;
		const nowMs = clock();
		const now = new Date(nowMs).toISOString();
		const claimToken = token();
		const row = claimNext(dependencies.storage, now, claimToken);
		if (!row) break;
		const batchSendDeadline =
			startedAt + PUSH_OUTBOX_LIMITS.batchWallMs - PUSH_OUTBOX_LIMITS.finalizationBudgetMs;
		const expirySendDeadline =
			Date.parse(row.expiresAt) - PUSH_OUTBOX_LIMITS.finalizationBudgetMs;
		const latestBatchSendStart = batchSendDeadline - PUSH_OUTBOX_LIMITS.sendBudgetMs;
		const latestExpirySendStart = expirySendDeadline - PUSH_OUTBOX_LIMITS.sendBudgetMs;
		const releaseAtBoundary = (boundaryMs: number): "batch" | "expired" | null => {
			if (boundaryMs >= latestExpirySendStart) {
				dependencies.storage.transactionSync(() => {
					expireNotification(
						dependencies.storage.sql,
						row.notificationId,
						new Date(boundaryMs).toISOString(),
					);
				});
				return "expired";
			}
			if (boundaryMs >= latestBatchSendStart) {
				deferClaim(
					dependencies.storage.sql,
					row,
					claimToken,
					new Date(boundaryMs).toISOString(),
				);
				return "batch";
			}
			return null;
		};
		const initialBoundary = releaseAtBoundary(clock());
		if (initialBoundary === "batch") break;
		if (initialBoundary === "expired") continue;
		try {
			if (dependencies.scheduleAlarmAt) {
				await awaitBeforeDeadline(
					dependencies.scheduleAlarmAt(Date.parse(row.leaseExpiresAt)),
					Math.min(latestBatchSendStart, latestExpirySendStart) - clock(),
				);
			}
		} catch {
			const failedAtMs = clock();
			const boundary = releaseAtBoundary(failedAtMs);
			if (boundary === "batch") break;
			if (boundary === "expired") continue;
			const failedAt = new Date(failedAtMs).toISOString();
			const currentIdentity = identity(dependencies.storage.sql, row.subscriptionId);
			dependencies.storage.transactionSync(() => {
				if (currentIdentity?.userId === row.targetUserId) {
					updateDeviceFailureByIdentity(
						dependencies.storage.sql,
						currentIdentity,
						failedAt,
						"service_unavailable",
					);
				}
				retry(dependencies.storage.sql, row, claimToken, failedAtMs, "service_unavailable");
			});
			continue;
		}

		let payload: PushPayload;
		try {
			const candidate: unknown = JSON.parse(row.payloadJson);
			payload = validateStoredPushPayload(candidate, {
				emailId: row.emailId,
				mailboxId: row.mailboxId,
			});
		} catch {
			terminal(dependencies.storage.sql, row, claimToken, now, "payload_defect");
			continue;
		}

		if (!dependencies.vapidConfigured) {
			terminal(dependencies.storage.sql, row, claimToken, now, "service_unavailable");
			continue;
		}
		const currentIdentity = identity(dependencies.storage.sql, row.subscriptionId);
		if (!currentIdentity || currentIdentity.userId !== row.targetUserId) {
			terminal(dependencies.storage.sql, row, claimToken, now, "subscription_removed");
			continue;
		}
		let authorized: boolean;
		try {
			authorized = await awaitBeforeDeadline(
				dependencies.canAccess(row.targetUserId, row.mailboxId),
				Math.min(latestBatchSendStart, latestExpirySendStart) - clock(),
			);
		} catch {
			const failedAtMs = clock();
			const boundary = releaseAtBoundary(failedAtMs);
			if (boundary === "batch") break;
			if (boundary === "expired") continue;
			const failedAt = new Date(failedAtMs).toISOString();
			dependencies.storage.transactionSync(() => {
				updateDeviceFailureByIdentity(
					dependencies.storage.sql,
					currentIdentity,
					failedAt,
					"service_unavailable",
				);
				retry(dependencies.storage.sql, row, claimToken, failedAtMs, "service_unavailable");
			});
			continue;
		}
		if (!ownsLease(dependencies.storage.sql, row, claimToken)) continue;
		if (!authorized) {
			dependencies.storage.transactionSync(() => {
				terminal(dependencies.storage.sql, row, claimToken, new Date(clock()).toISOString(), "authorization_revoked");
				dependencies.storage.sql.exec(
					"DELETE FROM push_subscriptions WHERE id = ? AND user_id = ? AND generation = ?",
					currentIdentity.id,
					currentIdentity.userId,
					currentIdentity.generation,
				);
			});
			continue;
		}
		const currentCapability = capability(
			dependencies.storage.sql,
			row.subscriptionId,
			row.targetUserId,
		);
		if (!currentCapability) {
			terminal(dependencies.storage.sql, row, claimToken, new Date(clock()).toISOString(), "subscription_removed");
			continue;
		}
		const beforeSendMs = clock();
		const beforeSendBoundary = releaseAtBoundary(beforeSendMs);
		if (beforeSendBoundary === "batch") break;
		if (beforeSendBoundary === "expired") continue;
		dependencies.storage.sql.exec(
			`UPDATE push_notification_deliveries SET attempted_subscription_generation = ?
			 WHERE notification_id = ? AND subscription_id = ? AND lease_token = ?`,
			currentCapability.generation,
			row.notificationId,
			row.subscriptionId,
			claimToken,
		);

		const sendDeadline = Math.min(batchSendDeadline, expirySendDeadline);
		const sendOutcome = await sendPushBeforeDeadline({
			deadlineMs: sendDeadline,
			now: clock,
			send: (signal) => dependencies.send(
				currentCapability,
				JSON.stringify(payload),
				{ signal, deadlineMs: sendDeadline },
			),
		});
		const result = sendOutcome.result;
		if (!ownsLease(dependencies.storage.sql, row, claimToken)) continue;
		const after = identity(dependencies.storage.sql, row.subscriptionId);
		if (
			!after ||
			after.userId !== row.targetUserId ||
			after.generation !== currentCapability.generation
		) {
			retry(dependencies.storage.sql, row, claimToken, clock());
			continue;
		}
		const finishedAtMs = clock();
		if (
			finishedAtMs >= expirySendDeadline ||
			(sendOutcome.timedOut && expirySendDeadline <= batchSendDeadline)
		) {
			dependencies.storage.transactionSync(() => {
				expireNotification(
					dependencies.storage.sql,
					row.notificationId,
					new Date(finishedAtMs).toISOString(),
				);
			});
			continue;
		}
		if (finishedAtMs >= batchSendDeadline || sendOutcome.timedOut) {
			const finishedAt = new Date(finishedAtMs).toISOString();
			dependencies.storage.transactionSync(() => {
				updateDeviceFailure(
					dependencies.storage.sql,
					currentCapability,
					finishedAt,
					"temporary_issue",
				);
				retry(
					dependencies.storage.sql,
					row,
					claimToken,
					finishedAtMs,
				);
			});
			break;
		}
		const finishedAt = new Date(finishedAtMs).toISOString();
		if (result.ok) {
			dependencies.storage.transactionSync(() => {
				dependencies.storage.sql.exec(
				`UPDATE push_notification_deliveries
				 SET status = 'accepted', accepted_at = ?, updated_at = ?,
				     last_reason = NULL, last_http_status = NULL,
				     lease_token = NULL, lease_expires_at = NULL
				 WHERE notification_id = ? AND subscription_id = ?
				   AND status = 'sending' AND lease_token = ?`,
				finishedAt,
				finishedAt,
				row.notificationId,
				row.subscriptionId,
				claimToken,
			);
				dependencies.storage.sql.exec(
				`UPDATE push_subscriptions
				 SET last_push_attempt_at = ?, last_push_accepted_at = ?,
				     last_push_failure_at = NULL, last_push_failure_reason = NULL,
				     consecutive_push_failures = 0
				 WHERE id = ? AND user_id = ? AND generation = ?
				   AND endpoint = ? AND p256dh = ? AND auth = ?`,
				finishedAt,
				finishedAt,
				currentCapability.id,
				currentCapability.userId,
				currentCapability.generation,
				currentCapability.endpoint,
				currentCapability.p256dh,
				currentCapability.auth,
			);
				completeNotification(dependencies.storage.sql, row.notificationId, finishedAt);
			});
			continue;
		}

		const status = result.statusCode;
		if (status === 404 || status === 410) {
			dependencies.storage.transactionSync(() => {
				terminal(dependencies.storage.sql, row, claimToken, finishedAt, "permission_revoked", status);
				dependencies.storage.sql.exec(
				`DELETE FROM push_subscriptions
				 WHERE id = ? AND user_id = ? AND generation = ?
				   AND endpoint = ? AND p256dh = ? AND auth = ?`,
				currentCapability.id,
				currentCapability.userId,
				currentCapability.generation,
				currentCapability.endpoint,
				currentCapability.p256dh,
				currentCapability.auth,
			);
			});
		} else if (status === 413) {
			dependencies.storage.transactionSync(() => {
				terminal(dependencies.storage.sql, row, claimToken, finishedAt, "payload_defect", status);
				updateDeviceFailure(dependencies.storage.sql, currentCapability, finishedAt, "payload_defect");
			});
		} else if (status !== null && status >= 400 && status < 500 && status !== 429) {
			dependencies.storage.transactionSync(() => {
				terminal(dependencies.storage.sql, row, claimToken, finishedAt, "configuration_issue", status);
				updateDeviceFailure(dependencies.storage.sql, currentCapability, finishedAt, "configuration_issue");
			});
		} else {
			dependencies.storage.transactionSync(() => {
				updateDeviceFailure(dependencies.storage.sql, currentCapability, finishedAt, "temporary_issue");
				retry(dependencies.storage.sql, row, claimToken, clock());
			});
		}
	}
	dependencies.storage.transactionSync(() => {
		recoverAndExpire(dependencies.storage.sql, new Date(clock()).toISOString());
	});

	const next = first<{ nextAttemptAt: string | null }>(
		dependencies.storage.sql,
		`SELECT MIN(due_at) AS nextAttemptAt FROM (
		 SELECT next_attempt_at AS due_at
		 FROM push_notification_deliveries
		 WHERE status IN ('pending', 'retrying')
		 UNION ALL
		 SELECT lease_expires_at AS due_at
		 FROM push_notification_deliveries
		 WHERE status = 'sending' AND lease_expires_at IS NOT NULL
		 UNION ALL
		 SELECT strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(completed_at, created_at), '+7 days') AS due_at
		 FROM push_notifications
		 WHERE state IN ('completed', 'no_targets', 'expired')
		)`,
	)?.nextAttemptAt;
	return next ? Date.parse(next) : null;
}

function deviceHealth(row: {
	lastAttemptAt: string | null;
	lastAcceptedAt: string | null;
	lastFailureAt: string | null;
	lastFailureReason: string | null;
}): PushDeviceHealthState {
	if (!row.lastAttemptAt) return "never_attempted";
	if (row.lastAcceptedAt && (!row.lastFailureAt || row.lastAcceptedAt >= row.lastFailureAt)) {
		return "accepted";
	}
	return ["permission_revoked", "authorization_revoked", "subscription_removed"].includes(
		row.lastFailureReason ?? "",
	) ? "reenable_required" : "temporary_issue";
}

export function readPushHealth(
	sql: PushOutboxSql,
	input: { userId: string; configured: boolean; now: string },
): PushHealthResponse {
	const rows = [...sql.exec<{
		id: string;
		label: string | null;
		createdAt: string;
		lastAttemptAt: string | null;
		lastAcceptedAt: string | null;
		lastFailureAt: string | null;
		lastFailureReason: string | null;
		consecutiveFailures: number;
	}>(
		`SELECT id, device_label AS label, created_at AS createdAt,
		        last_push_attempt_at AS lastAttemptAt,
		        last_push_accepted_at AS lastAcceptedAt,
		        last_push_failure_at AS lastFailureAt,
		        last_push_failure_reason AS lastFailureReason,
		        consecutive_push_failures AS consecutiveFailures
		 FROM push_subscriptions WHERE user_id = ?
		 ORDER BY created_at DESC, id ASC LIMIT 50`,
		input.userId,
	)];
	const pendingCount = Number(first<{ count: number }>(sql,
		`SELECT COUNT(*) AS count
		 FROM push_notification_deliveries d
		 JOIN push_subscriptions s
		   ON s.id = d.subscription_id AND s.user_id = d.target_user_id
		 WHERE d.target_user_id = ? AND d.status IN ('pending', 'sending', 'retrying')`,
		input.userId,
	)?.count ?? 0);
	const devices = rows.map((row) => ({
		id: row.id,
		label: (row.label?.trim() || "This device").normalize("NFC").slice(0, 100),
		registeredAt: new Date(row.createdAt).toISOString(),
		lastAttemptAt: row.lastAttemptAt ? new Date(row.lastAttemptAt).toISOString() : null,
		lastAcceptedAt: row.lastAcceptedAt ? new Date(row.lastAcceptedAt).toISOString() : null,
		health: deviceHealth(row),
		consecutiveFailures: Math.max(0, Math.floor(row.consecutiveFailures)),
	}));
	const state = !input.configured
		? "not_configured"
		: devices.length === 0
			? "no_devices"
			: pendingCount > 0
				? "retrying"
				: devices.some((device) => device.health === "temporary_issue" || device.health === "reenable_required")
					? "degraded"
					: "healthy";
	return {
		state,
		pendingCount: input.configured ? pendingCount : 0,
		refreshedAt: input.now,
		devices,
	};
}
