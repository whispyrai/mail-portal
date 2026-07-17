import type { Env } from "../types.ts";

export const CREDENTIAL_RECOVERY_MONITORING_SLAS = {
  pendingRequestMs: 5 * 60_000,
  pendingDeliveryMs: 5 * 60_000,
  persistentErrorPolls: 3,
  cleanPollsToResolve: 2,
  pollIntervalMs: 60_000,
  repeatedHttpRejections: 2,
} as const;

const REQUEST_STATES = [
  "pending",
  "leased",
  "completed",
  "suppressed",
  "expired",
  "parked",
] as const;
const DELIVERY_STATES = [
  "pending",
  "leased",
  "dispatching",
  "accepted",
  "cancelled",
  "expired",
  "parked",
] as const;

type CountRow = { state: string; count: number };

function exactStateCounts<const States extends readonly string[]>(
  states: States,
  rows: CountRow[],
): Record<States[number], number> {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<
    States[number],
    number
  >;
  for (const row of rows) {
    if ((states as readonly string[]).includes(row.state)) {
      counts[row.state as States[number]] = row.count;
    }
  }
  return counts;
}

/**
 * Read-only aggregate evidence for operators. No account, destination, token,
 * ciphertext, provider message ID, delivery ID, or attempt ID is selected.
 */
export async function readCredentialRecoveryOperationalSnapshot(
  env: Env,
  now = Date.now(),
) {
  const [requests, deliveries, attemptEvidence, providerEvents, oldest] =
    await Promise.all([
      env.DB.prepare(
        `SELECT state, COUNT(*) AS count
         FROM credential_recovery_request_jobs GROUP BY state`,
      ).all<CountRow>(),
      env.DB.prepare(
        `SELECT state, COUNT(*) AS count
         FROM credential_recovery_delivery_outbox GROUP BY state`,
      ).all<CountRow>(),
      env.DB.prepare(
        `SELECT
           SUM(CASE WHEN state = 'dispatching' THEN 1 ELSE 0 END) AS dispatching_count,
           SUM(CASE WHEN state = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous_count,
           SUM(CASE WHEN state = 'http_rejected' THEN 1 ELSE 0 END) AS http_rejected_count
         FROM credential_recovery_delivery_attempts`,
      ).first<{
        dispatching_count: number | null;
        ambiguous_count: number | null;
        http_rejected_count: number | null;
      }>(),
      env.DB.prepare(
        `SELECT event_type AS state, COUNT(*) AS count
         FROM credential_recovery_delivery_events
         WHERE recorded_at >= ? GROUP BY event_type`,
      )
        .bind(now - 24 * 60 * 60 * 1_000)
        .all<CountRow>(),
      env.DB.prepare(
        `SELECT
           (SELECT MIN(created_at) FROM credential_recovery_request_jobs
            WHERE state IN ('pending', 'leased')) AS oldest_request_at,
           (SELECT MIN(created_at) FROM credential_recovery_delivery_outbox
            WHERE state IN ('pending', 'leased', 'dispatching')) AS oldest_delivery_at,
           (SELECT COUNT(*) FROM credential_recovery_request_jobs
            WHERE state IN ('pending', 'leased') AND created_at <= ?)
              AS pending_requests_over_sla,
           (SELECT COUNT(*) FROM credential_recovery_delivery_outbox
            WHERE state IN ('pending', 'leased', 'dispatching') AND created_at <= ?)
              AS pending_deliveries_over_sla,
           (SELECT COUNT(*) FROM credential_recovery_request_jobs
            WHERE state IN ('pending', 'leased')
              AND last_error_code IS NOT NULL
              AND last_error_code NOT IN
                ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE'))
              AS active_request_non_ambiguous_errors,
           (SELECT COUNT(*) FROM credential_recovery_delivery_outbox
            WHERE state IN ('pending', 'leased', 'dispatching')
              AND last_error_code IS NOT NULL
              AND last_error_code NOT IN
                ('SES_TRANSPORT_AMBIGUOUS', 'SES_INVALID_SUCCESS_RESPONSE'))
              AS active_delivery_non_ambiguous_errors,
           (SELECT COUNT(*) FROM (
              SELECT attempts.outbox_id
              FROM credential_recovery_delivery_attempts attempts
              JOIN credential_recovery_delivery_outbox outbox
                ON outbox.id = attempts.outbox_id
              WHERE attempts.state = 'http_rejected'
                AND outbox.state IN ('pending', 'leased', 'dispatching')
              GROUP BY attempts.outbox_id
              HAVING COUNT(*) >= 2
            )) AS active_deliveries_with_repeated_http_rejections,
           (SELECT COUNT(*) FROM credential_recovery_request_jobs
            WHERE state = 'parked' AND payload_ciphertext IS NOT NULL) AS retained_request_payloads,
           (SELECT COUNT(*) FROM credential_recovery_delivery_outbox
            WHERE state = 'parked' AND payload_ciphertext IS NOT NULL) AS retained_delivery_payloads`,
      )
        .bind(
          now - CREDENTIAL_RECOVERY_MONITORING_SLAS.pendingRequestMs,
          now - CREDENTIAL_RECOVERY_MONITORING_SLAS.pendingDeliveryMs,
        )
        .first<{
        oldest_request_at: number | null;
        oldest_delivery_at: number | null;
        pending_requests_over_sla: number;
        pending_deliveries_over_sla: number;
        active_request_non_ambiguous_errors: number;
        active_delivery_non_ambiguous_errors: number;
        active_deliveries_with_repeated_http_rejections: number;
        retained_request_payloads: number;
        retained_delivery_payloads: number;
      }>(),
    ]);
  const age = (timestamp: number | null | undefined) =>
    timestamp === null || timestamp === undefined ? null : Math.max(0, now - timestamp);
  return {
    requestStates: exactStateCounts(REQUEST_STATES, requests.results),
    deliveryStates: exactStateCounts(DELIVERY_STATES, deliveries.results),
    attempts: {
      dispatching: attemptEvidence?.dispatching_count ?? 0,
      ambiguous: attemptEvidence?.ambiguous_count ?? 0,
      httpRejected: attemptEvidence?.http_rejected_count ?? 0,
    },
    providerEventsLast24Hours: exactStateCounts(
      ["delivery", "bounce", "complaint"] as const,
      providerEvents.results,
    ),
    oldestPendingRequestAgeMs: age(oldest?.oldest_request_at),
    oldestActiveDeliveryAgeMs: age(oldest?.oldest_delivery_at),
    monitoringConditions: {
      pendingRequestsOverFiveMinutes: oldest?.pending_requests_over_sla ?? 0,
      pendingDeliveriesOverFiveMinutes:
        oldest?.pending_deliveries_over_sla ?? 0,
      activeRequestNonAmbiguousErrors:
        oldest?.active_request_non_ambiguous_errors ?? 0,
      activeDeliveryNonAmbiguousErrors:
        oldest?.active_delivery_non_ambiguous_errors ?? 0,
      activeDeliveriesWithRepeatedHttpRejections:
        oldest?.active_deliveries_with_repeated_http_rejections ?? 0,
    },
    retainedParkedPayloads: {
      requests: oldest?.retained_request_payloads ?? 0,
      deliveries: oldest?.retained_delivery_payloads ?? 0,
    },
  };
}
