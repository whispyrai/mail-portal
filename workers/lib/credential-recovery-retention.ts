import type { Env } from "../types.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_BATCH_SIZE = 100;

/**
 * Bound credential recovery payload and evidence retention without ever
 * deleting a live token or a provider event still protected by a foreign key.
 */
export async function pruneCredentialRecoveryHistory(
  env: Env,
  now = Date.now(),
): Promise<{ scrubbedCount: number; deletedCount: number; hasMore: boolean }> {
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE credential_recovery_request_jobs
       SET payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
           updated_at = ?
       WHERE id IN (
         SELECT id FROM credential_recovery_request_jobs
         WHERE state = 'parked' AND payload_ciphertext IS NOT NULL
           AND completed_at < ?
         ORDER BY completed_at ASC, id ASC LIMIT ?
       )`,
    ).bind(now, now - 7 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `UPDATE credential_recovery_delivery_outbox
       SET payload_key_version = NULL, payload_iv = NULL, payload_ciphertext = NULL,
           updated_at = ?
       WHERE id IN (
         SELECT id FROM credential_recovery_delivery_outbox
         WHERE state = 'parked' AND payload_ciphertext IS NOT NULL
           AND completed_at < ?
         ORDER BY completed_at ASC, id ASC LIMIT ?
       )`,
    ).bind(now, now - 7 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `DELETE FROM credential_recovery_request_jobs
       WHERE id IN (
         SELECT id FROM credential_recovery_request_jobs
         WHERE state IN ('completed', 'suppressed', 'expired', 'parked')
           AND completed_at < ?
         ORDER BY completed_at ASC, id ASC LIMIT ?
       )`,
    ).bind(now - 90 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `DELETE FROM credential_recovery_delivery_events
       WHERE event_id IN (
         SELECT event_id FROM credential_recovery_delivery_events
         WHERE recorded_at < ?
         ORDER BY recorded_at ASC, event_id ASC LIMIT ?
       )`,
    ).bind(now - 365 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `DELETE FROM credential_recovery_delivery_attempts
       WHERE attempt_id IN (
         SELECT a.attempt_id FROM credential_recovery_delivery_attempts a
         JOIN credential_recovery_delivery_outbox o ON o.id = a.outbox_id
         WHERE a.updated_at < ?
           AND o.state IN ('accepted', 'cancelled', 'expired', 'parked')
           AND NOT EXISTS (
             SELECT 1 FROM credential_recovery_delivery_events e
             WHERE e.attempt_id = a.attempt_id
           )
         ORDER BY a.updated_at ASC, a.attempt_id ASC LIMIT ?
       )`,
    ).bind(now - 365 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `DELETE FROM credential_recovery_delivery_outbox
       WHERE id IN (
         SELECT o.id FROM credential_recovery_delivery_outbox o
         WHERE (
           (o.state IN ('cancelled', 'expired', 'parked') AND o.completed_at < ?)
           OR (o.state = 'accepted' AND o.completed_at < ?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM credential_recovery_delivery_events e
           WHERE e.outbox_id = o.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM credential_recovery_delivery_attempts a
           WHERE a.outbox_id = o.id
         )
         ORDER BY o.completed_at ASC, o.id ASC LIMIT ?
       )`,
    ).bind(now - 90 * DAY_MS, now - 365 * DAY_MS, RETENTION_BATCH_SIZE),
    env.DB.prepare(
      `DELETE FROM credential_recovery_tokens
       WHERE id IN (
         SELECT t.id FROM credential_recovery_tokens t
         WHERE (t.consumed_at IS NOT NULL OR t.expires_at < ?)
           AND t.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM credential_recovery_delivery_outbox o
             WHERE o.token_id = t.id
           )
         ORDER BY t.created_at ASC, t.id ASC LIMIT ?
       )`,
    ).bind(now, now - 365 * DAY_MS, RETENTION_BATCH_SIZE),
  ]);
  const changes = results.map((result) => result.meta.changes ?? 0);
  const scrubbedCount = (changes[0] ?? 0) + (changes[1] ?? 0);
  const deletedCount = changes.slice(2).reduce((total, count) => total + count, 0);
  const hasMore = changes.some((count) => count >= RETENTION_BATCH_SIZE);
  console.info("[credential-recovery] retention complete", {
    operation: "credential_recovery_retention",
    scrubbedCount,
    deletedCount,
    hasMore,
  });
  return { scrubbedCount, deletedCount, hasMore };
}
