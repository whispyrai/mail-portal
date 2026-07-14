import type { Env } from "../types.ts";
import {
  AgentConnectionReconciliationError,
  drainAgentConnectionRevocations,
} from "./agent-connection-revocation-outbox.ts";

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
    drainAgentRevocations(
      env: Env,
    ): Promise<{ failedCount: number; hasMore: boolean }>;
    pruneAiCache(
      env: Env,
      now: number,
    ): Promise<{ deletedCount: number; hasMore: boolean }>;
  } = {
    drainAgentRevocations: (runtimeEnv) =>
      drainAgentConnectionRevocations(runtimeEnv),
    pruneAiCache: pruneExpiredAiResponseCache,
  },
): Promise<void> {
  if (event.cron === AGENT_RECONCILIATION_CRON) {
    const result = await dependencies.drainAgentRevocations(env);
    if (result.failedCount > 0 || result.hasMore) {
      throw new AgentConnectionReconciliationError(
        result.failedCount,
        result.hasMore,
      );
    }
    return;
  }
  if (event.cron === AI_CACHE_RETENTION_CRON) {
    const result = await dependencies.pruneAiCache(env, event.scheduledTime);
    if (result.hasMore) throw new AiCacheRetentionBacklogError();
  }
}
