import type { Env } from "../types.ts";
import { agentConnectionRevoker } from "./agent-connection-revocation.ts";

export const AGENT_CONNECTION_REVOCATION_LIMITS = {
  batchSize: 25,
  maxBatches: 4,
  leaseMs: 60_000,
  retryBaseMs: 60_000,
  retryMaxMs: 60 * 60_000,
} as const;

type AgentConnectionRevocationRow = {
  id: string;
  scope: "ACTOR" | "MAILBOX";
  mailbox_id: string;
  user_id: string | null;
  attempt_count: number;
};

export type AgentConnectionRevocationTarget = {
  mailboxId?: string;
  userId?: string;
  scope?: "ACTOR" | "MAILBOX";
};

export type AgentConnectionRevocationOutboxDependencies = {
  now(): number;
  createToken(): string;
  revoker: Pick<
    ReturnType<typeof agentConnectionRevoker>,
    "reconcileActor" | "reconcileMailbox"
  >;
};

export class AgentConnectionReconciliationError extends Error {
  readonly failedCount: number;
  readonly hasMore: boolean;

  constructor(failedCount: number, hasMore: boolean) {
    super("Live Agent connections could not be fully reconciled");
    this.name = "AgentConnectionReconciliationError";
    this.failedCount = failedCount;
    this.hasMore = hasMore;
  }
}

class AgentConnectionLeaseLostError extends Error {}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    AGENT_CONNECTION_REVOCATION_LIMITS.retryBaseMs *
      2 ** Math.max(0, attemptCount - 1),
    AGENT_CONNECTION_REVOCATION_LIMITS.retryMaxMs,
  );
}

function targetSql(
  target: AgentConnectionRevocationTarget,
  values: Array<string | number>,
): string {
  const clauses: string[] = [];
  const bind = (value: string) => {
    values.push(value);
    return `?${values.length}`;
  };
  if (target.mailboxId) {
    clauses.push(`mailbox_id = ${bind(target.mailboxId.toLowerCase())}`);
  }
  if (target.userId) clauses.push(`user_id = ${bind(target.userId)}`);
  if (target.scope) clauses.push(`scope = ${bind(target.scope)}`);
  return clauses.length > 0 ? ` AND ${clauses.join(" AND ")}` : "";
}

async function claimBatch(
  env: Env,
  target: AgentConnectionRevocationTarget,
  now: number,
  leaseToken: string,
): Promise<AgentConnectionRevocationRow[]> {
  const values: Array<string | number> = [
    leaseToken,
    now + AGENT_CONNECTION_REVOCATION_LIMITS.leaseMs,
    now,
    now,
    now,
  ];
  const filters = targetSql(target, values);
  values.push(AGENT_CONNECTION_REVOCATION_LIMITS.batchSize);
  const limit = `?${values.length}`;
  const result = await env.DB.prepare(
    `UPDATE agent_connection_revocations
     SET lease_token = ?1, lease_expires_at = ?2,
         attempt_count = attempt_count + 1, updated_at = ?3
     WHERE id IN (
       SELECT id
       FROM agent_connection_revocations
       WHERE next_attempt_at <= ?4
         AND (lease_token IS NULL OR lease_expires_at <= ?5)
         ${filters}
       ORDER BY next_attempt_at ASC, created_at ASC, id ASC
       LIMIT ${limit}
     )
       AND (lease_token IS NULL OR lease_expires_at <= ?5)
     RETURNING id, scope, mailbox_id, user_id, attempt_count`,
  )
    .bind(...values)
    .run<AgentConnectionRevocationRow>();
  return result.results;
}

async function reconcile(
  row: AgentConnectionRevocationRow,
  dependencies: AgentConnectionRevocationOutboxDependencies,
): Promise<void> {
  if (row.scope === "ACTOR") {
    if (!row.user_id) throw new Error("Actor reconciliation target is invalid");
    await dependencies.revoker.reconcileActor(row.mailbox_id, row.user_id);
    return;
  }
  await dependencies.revoker.reconcileMailbox(row.mailbox_id);
}

async function complete(
  env: Env,
  row: AgentConnectionRevocationRow,
  leaseToken: string,
): Promise<void> {
  const result = await env.DB.prepare(
    "DELETE FROM agent_connection_revocations WHERE id = ? AND lease_token = ?",
  )
    .bind(row.id, leaseToken)
    .run();
  if (result.meta.changes !== 1) throw new AgentConnectionLeaseLostError();
}

async function renewLease(
  env: Env,
  row: AgentConnectionRevocationRow,
  leaseToken: string,
  now: number,
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE agent_connection_revocations
     SET lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND lease_token = ? AND lease_expires_at > ?`,
  )
    .bind(
      now + AGENT_CONNECTION_REVOCATION_LIMITS.leaseMs,
      now,
      row.id,
      leaseToken,
      now,
    )
    .run();
  if (result.meta.changes !== 1) throw new AgentConnectionLeaseLostError();
}

async function retry(
  env: Env,
  row: AgentConnectionRevocationRow,
  leaseToken: string,
  now: number,
  errorCode: "agent_rpc_failed" | "completion_failed",
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_connection_revocations
     SET next_attempt_at = ?, lease_token = NULL, lease_expires_at = NULL,
         last_error_code = ?, updated_at = ?
     WHERE id = ? AND lease_token = ?`,
  )
    .bind(
      now + retryDelayMs(row.attempt_count),
      errorCode,
      now,
      row.id,
      leaseToken,
    )
    .run();
}

async function hasDueWork(
  env: Env,
  target: AgentConnectionRevocationTarget,
  now: number,
): Promise<boolean> {
  const values: Array<string | number> = [now, now];
  const filters = targetSql(target, values);
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 AS found
       FROM agent_connection_revocations
       WHERE next_attempt_at <= ?1
         AND (lease_token IS NULL OR lease_expires_at <= ?2)
         ${filters}
       LIMIT 1`,
    )
      .bind(...values)
      .first(),
  );
}

async function hasOutstandingWork(
  env: Env,
  target: AgentConnectionRevocationTarget,
): Promise<boolean> {
  const values: Array<string | number> = [];
  const filters = targetSql(target, values);
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 AS found
       FROM agent_connection_revocations
       WHERE 1 = 1
         ${filters}
       LIMIT 1`,
    )
      .bind(...values)
      .first(),
  );
}

export async function drainAgentConnectionRevocations(
  env: Env,
  options: AgentConnectionRevocationTarget & { maxBatches?: number } = {},
  dependencies: AgentConnectionRevocationOutboxDependencies = {
    now: Date.now,
    createToken: () => crypto.randomUUID(),
    revoker: agentConnectionRevoker(env),
  },
): Promise<{
  claimedCount: number;
  deliveredCount: number;
  failedCount: number;
  hasMore: boolean;
}> {
  const maxBatches = Math.max(
    1,
    Math.min(
      options.maxBatches ?? AGENT_CONNECTION_REVOCATION_LIMITS.maxBatches,
      AGENT_CONNECTION_REVOCATION_LIMITS.maxBatches,
    ),
  );
  let claimedCount = 0;
  let deliveredCount = 0;
  let failedCount = 0;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const claimNow = dependencies.now();
    const leaseToken = dependencies.createToken();
    const rows = await claimBatch(env, options, claimNow, leaseToken);
    claimedCount += rows.length;
    for (const row of rows) {
      let stage: "agent_rpc_failed" | "completion_failed" = "agent_rpc_failed";
      try {
        await renewLease(env, row, leaseToken, dependencies.now());
        stage = "agent_rpc_failed";
        await reconcile(row, dependencies);
        stage = "completion_failed";
        await complete(env, row, leaseToken);
        deliveredCount += 1;
      } catch (error) {
        failedCount += 1;
        if (!(error instanceof AgentConnectionLeaseLostError)) {
          await retry(env, row, leaseToken, dependencies.now(), stage);
        }
      }
    }
    if (rows.length < AGENT_CONNECTION_REVOCATION_LIMITS.batchSize) break;
  }

  return {
    claimedCount,
    deliveredCount,
    failedCount,
    hasMore: await hasDueWork(env, options, dependencies.now()),
  };
}

export async function requireAgentConnectionReconciliation(
  env: Env,
  target: AgentConnectionRevocationTarget,
  dependencies?: AgentConnectionRevocationOutboxDependencies,
): Promise<void> {
  const result = await drainAgentConnectionRevocations(env, target, dependencies);
  const outstanding = await hasOutstandingWork(env, target);
  if (result.failedCount > 0 || result.hasMore || outstanding) {
    throw new AgentConnectionReconciliationError(
      result.failedCount,
      result.hasMore || outstanding,
    );
  }
}
