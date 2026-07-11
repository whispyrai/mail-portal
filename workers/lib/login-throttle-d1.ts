import type { Env } from "../types.ts";
import {
	createLoginThrottle,
	type LoginThrottleStore,
} from "./login-throttle.ts";

export function d1LoginThrottleStore(env: Env): LoginThrottleStore {
	return {
		async admit(input) {
			if (input.buckets.length !== 2) {
				throw new Error("Login admission requires account and IP buckets");
			}
			const [account, ip] = input.buckets;
			const expiresAt = input.now + input.leaseMs;
			const windowCutoff = input.now - input.windowMs;
			const results = await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM login_attempt_leases WHERE expires_at <= ?",
				).bind(input.now),
				env.DB.prepare(
					`WITH requested(throttle_key, max_failures) AS (
					   VALUES (?, ?), (?, ?)
					 )
					 INSERT INTO login_attempt_leases
					   (attempt_id, throttle_key, max_failures, acquired_at, expires_at)
					 SELECT ?, requested.throttle_key, requested.max_failures, ?, ?
					 FROM requested
					 WHERE NOT EXISTS (
					   SELECT 1
					   FROM requested AS candidate
					   LEFT JOIN login_throttles AS throttle
					     ON throttle.throttle_key = candidate.throttle_key
					   WHERE COALESCE(throttle.locked_until, 0) > ?
					      OR (
					        CASE
					          WHEN COALESCE(throttle.window_started_at, 0) <= ? THEN 0
					          ELSE COALESCE(throttle.failure_count, 0)
					        END
					        + (
					          SELECT COUNT(*) FROM login_attempt_leases AS active
					          WHERE active.throttle_key = candidate.throttle_key
					            AND active.expires_at > ?
					        )
					      ) >= candidate.max_failures
					 )`,
				).bind(
					account.key,
					account.maxFailures,
					ip.key,
					ip.maxFailures,
					input.attemptId,
					input.now,
					expiresAt,
					input.now,
					windowCutoff,
					input.now,
				),
			]);
			if (changes(results[1]) === input.buckets.length) {
				return { allowed: true, retryAfterMs: 0 };
			}

			const retry = await env.DB.prepare(
				`SELECT
				   MAX(COALESCE(throttle.locked_until, 0)) AS locked_until,
				   MIN(lease.expires_at) AS lease_expires_at
				 FROM (
				   SELECT ? AS throttle_key UNION ALL SELECT ?
				 ) AS requested
				 LEFT JOIN login_throttles AS throttle
				   ON throttle.throttle_key = requested.throttle_key
				 LEFT JOIN login_attempt_leases AS lease
				   ON lease.throttle_key = requested.throttle_key AND lease.expires_at > ?`,
			)
				.bind(account.key, ip.key, input.now)
				.first<{ locked_until: number | null; lease_expires_at: number | null }>();
			const retryAt = Math.max(
				retry?.locked_until ?? 0,
				retry?.lease_expires_at ?? 0,
				input.now + 1_000,
			);
			return { allowed: false, retryAfterMs: retryAt - input.now };
		},

		async finish(input) {
			if (input.outcome === "success") {
				await env.DB.prepare(
					"DELETE FROM login_attempt_leases WHERE attempt_id = ?",
				)
					.bind(input.attemptId)
					.run();
				return;
			}
			const windowCutoff = input.now - input.windowMs;
			await env.DB.batch([
				env.DB.prepare(
					`INSERT INTO login_throttles (
					   throttle_key, failure_count, window_started_at, locked_until,
					   updated_at, max_failures
					 )
					 SELECT throttle_key, 1, ?,
					        CASE WHEN 1 >= max_failures THEN ? ELSE 0 END,
					        ?, max_failures
					 FROM login_attempt_leases
					 WHERE attempt_id = ?
					 ON CONFLICT(throttle_key) DO UPDATE SET
					   failure_count = CASE
					     WHEN login_throttles.window_started_at <= ? THEN 1
					     ELSE login_throttles.failure_count + 1
					   END,
					   window_started_at = CASE
					     WHEN login_throttles.window_started_at <= ? THEN ?
					     ELSE login_throttles.window_started_at
					   END,
					   locked_until = CASE
					     WHEN login_throttles.locked_until > ? THEN login_throttles.locked_until
					     WHEN (CASE
					       WHEN login_throttles.window_started_at <= ? THEN 1
					       ELSE login_throttles.failure_count + 1
					     END) >= excluded.max_failures THEN ?
					     ELSE 0
					   END,
					   updated_at = excluded.updated_at,
					   max_failures = excluded.max_failures`,
				).bind(
					input.now,
					input.now + input.lockMs,
					input.now,
					input.attemptId,
					windowCutoff,
					windowCutoff,
					input.now,
					input.now,
					windowCutoff,
					input.now + input.lockMs,
				),
				env.DB.prepare(
					"DELETE FROM login_attempt_leases WHERE attempt_id = ?",
				).bind(input.attemptId),
			]);
		},

		async prune(olderThan) {
			await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM login_attempt_leases WHERE expires_at < ?",
				).bind(olderThan + 24 * 60 * 60 * 1000),
				env.DB.prepare(
					`DELETE FROM login_throttles
					 WHERE throttle_key IN (
					   SELECT throttle_key FROM login_throttles
					   WHERE updated_at < ? ORDER BY updated_at LIMIT 100
					 )`,
				).bind(olderThan),
			]);
		},
	};
}

function changes(result: D1Result<unknown>): number {
	return Number(result.meta?.changes ?? 0);
}

export function loginThrottle(env: Env) {
	return createLoginThrottle(d1LoginThrottleStore(env));
}
