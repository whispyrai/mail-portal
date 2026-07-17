import type { Env } from "../types.ts";
import {
  AgentConnectionReconciliationError,
  drainAgentConnectionRevocations,
} from "./agent-connection-revocation-outbox.ts";
import {
  drainCredentialRecoveryRequests,
} from "./recovery-request-runtime.ts";
import { drainCredentialRecoveryDeliveries } from "./credential-recovery-delivery-outbox.ts";
import { pruneCredentialRecoveryHistory } from "./credential-recovery-retention.ts";
import { isCredentialRecoveryEnabled } from "./credential-recovery-control.ts";
import { privacySafeErrorName } from "./privacy-safe-error.ts";

export const AGENT_RECONCILIATION_CRON = "* * * * *";
export const AI_CACHE_RETENTION_CRON = "17 * * * *";

export const AI_CACHE_RETENTION_LIMITS = {
  batchSize: 500,
  maxBatches: 10,
} as const;

export class AiCacheRetentionBacklogError extends Error {
  constructor() {
    super("Expired AI response cache cleanup reached its bounded hourly limit");
    this.name = "AiCacheRetentionBacklogError";
  }
}

function maintenanceSummary(value: unknown): Record<string, number | boolean> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const summary: Record<string, number | boolean> = {};
  for (const field of [
    "issuedCount",
    "retryCount",
    "expiredCount",
    "parkedCount",
    "acceptedCount",
    "scrubbedCount",
    "deletedCount",
    "failedCount",
    "hasMore",
  ]) {
    const fieldValue = record[field];
    if (typeof fieldValue === "number" || typeof fieldValue === "boolean") {
      summary[field] = fieldValue;
    }
  }
  return summary;
}

export async function pruneExpiredAiResponseCache(
  env: Env,
  now: number,
): Promise<{ deletedCount: number; hasMore: boolean }> {
  let deletedCount = 0;
  let reachedLimit = false;
  for (
    let batch = 0;
    batch < AI_CACHE_RETENTION_LIMITS.maxBatches;
    batch += 1
  ) {
    const result = await env.DB.prepare(
      `DELETE FROM ai_response_cache
       WHERE rowid IN (
         SELECT rowid
         FROM ai_response_cache
         WHERE expires_at <= ?
         ORDER BY expires_at ASC, rowid ASC
         LIMIT ?
       )`,
    )
      .bind(now, AI_CACHE_RETENTION_LIMITS.batchSize)
      .run();
    const deleted = result.meta.changes ?? 0;
    deletedCount += deleted;
    if (deleted < AI_CACHE_RETENTION_LIMITS.batchSize) break;
    reachedLimit = batch === AI_CACHE_RETENTION_LIMITS.maxBatches - 1;
  }
  const hasMore = reachedLimit && Boolean(
    await env.DB.prepare(
      "SELECT 1 AS found FROM ai_response_cache WHERE expires_at <= ? LIMIT 1",
    )
      .bind(now)
      .first(),
  );
  return { deletedCount, hasMore };
}

export async function runScheduledMaintenance(
  env: Env,
  event: { cron: string; scheduledTime: number },
  dependencies: {
    isRecoveryEnabled(env: Env): Promise<boolean>;
    drainAgentRevocations(
      env: Env,
    ): Promise<{ failedCount: number; hasMore: boolean }>;
    drainRecoveryRequests(
      env: Env,
    ): Promise<{ failedCount: number; hasMore: boolean }>;
    drainRecoveryDeliveries(
      env: Env,
    ): Promise<{ failedCount: number; hasMore: boolean }>;
    pruneRecoveryHistory?(
      env: Env,
      now: number,
    ): Promise<{ scrubbedCount: number; deletedCount: number; hasMore: boolean }>;
    pruneAiCache(
      env: Env,
      now: number,
    ): Promise<{ deletedCount: number; hasMore: boolean }>;
  } = {
    isRecoveryEnabled: isCredentialRecoveryEnabled,
    drainAgentRevocations: (runtimeEnv) =>
      drainAgentConnectionRevocations(runtimeEnv),
    drainRecoveryRequests: (runtimeEnv) =>
      drainCredentialRecoveryRequests(runtimeEnv),
    drainRecoveryDeliveries: (runtimeEnv) =>
      drainCredentialRecoveryDeliveries(runtimeEnv),
    pruneRecoveryHistory: pruneCredentialRecoveryHistory,
    pruneAiCache: pruneExpiredAiResponseCache,
  },
): Promise<void> {
  if (event.cron === AGENT_RECONCILIATION_CRON) {
    const [agentResult, recoveryControlResult] = await Promise.allSettled([
      dependencies.drainAgentRevocations(env),
      dependencies.isRecoveryEnabled(env),
    ]);
    const recoveryEnabled =
      recoveryControlResult.status === "fulfilled" &&
      recoveryControlResult.value === true;
    if (!recoveryEnabled) {
      console.warn("[security-maintenance] recovery lanes disabled", {
        operation: "security_maintenance_recovery_control",
        outcome: "disabled",
        controlRead:
          recoveryControlResult.status === "fulfilled" ? "complete" : "failed",
        ...(recoveryControlResult.status === "rejected"
          ? { errorName: privacySafeErrorName(recoveryControlResult.reason) }
          : {}),
      });
    }
    const firstResults = recoveryEnabled
      ? await Promise.allSettled([
          dependencies.drainRecoveryRequests(env),
          ...(dependencies.pruneRecoveryHistory
            ? [dependencies.pruneRecoveryHistory(env, event.scheduledTime)]
            : []),
        ])
      : [];
    // The delivery lane always runs, including after either first-stage failure,
    // but waits for request issuance so it can pick up new outbox rows now.
    const deliveryResults = recoveryEnabled
      ? await Promise.allSettled([dependencies.drainRecoveryDeliveries(env)])
      : [];
    const lanes: Array<{
      lane: string;
      kind: "agent" | "recovery" | "retention";
      result: PromiseSettledResult<unknown>;
    }> = [
      {
        lane: "agent_connection_revocations",
        kind: "agent",
        result: agentResult,
      },
      ...(recoveryEnabled
        ? [
            {
              lane: "credential_recovery_requests",
              kind: "recovery" as const,
              result: firstResults[0]!,
            },
            ...(dependencies.pruneRecoveryHistory
              ? [
                  {
                    lane: "credential_recovery_retention",
                    kind: "retention" as const,
                    result: firstResults[1]!,
                  },
                ]
              : []),
            {
              lane: "credential_recovery_deliveries",
              kind: "recovery" as const,
              result: deliveryResults[0]!,
            },
          ]
        : []),
    ];
    const failures: unknown[] = [];
    for (const { lane, kind, result } of lanes) {
      if (result.status === "rejected") {
        console.error("[security-maintenance] lane failed", {
          operation: "security_maintenance_lane",
          lane,
          outcome: "failed",
          errorName: privacySafeErrorName(result.reason),
        });
        failures.push(result.reason);
        continue;
      }
      const summary = maintenanceSummary(result.value);
      console.info("[security-maintenance] lane complete", {
        operation: "security_maintenance_lane",
        lane,
        outcome: "complete",
        ...summary,
      });
      const failedCount =
        typeof summary.failedCount === "number" ? summary.failedCount : 0;
      const hasMore = summary.hasMore === true;
      if (kind !== "retention" && (failedCount > 0 || hasMore)) {
        console.warn("[security-maintenance] lane backlog", {
          operation: "security_maintenance_lane",
          lane,
          outcome: "backlog",
          failedCount,
          hasMore,
        });
        failures.push(
          kind === "agent"
            ? new AgentConnectionReconciliationError(
                failedCount,
                hasMore,
              )
            : new Error("Credential recovery maintenance is incomplete"),
        );
      }
      if (kind === "retention" && hasMore) {
        console.warn("[credential-recovery] retention backlog", {
          operation: "security_maintenance_lane",
          lane,
          outcome: "backlog",
          hasMore,
        });
        failures.push(new Error("Credential recovery retention backlog remains"));
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Security maintenance failed");
    }
    return;
  }
  if (event.cron === AI_CACHE_RETENTION_CRON) {
    const result = await dependencies.pruneAiCache(env, event.scheduledTime);
    if (result.hasMore) throw new AiCacheRetentionBacklogError();
  }
}
