import type { Env } from "../types.ts";
import { privacySafeErrorName } from "./privacy-safe-error.ts";
import { credentialRecoveryWorkflow } from "./credential-recovery-runtime.ts";
import {
  RecoveryDirectoryError,
  recoveryAddressFor,
} from "./recovery-directory.ts";
import { resolveBrand } from "../routes/brand.ts";
import {
  completeCredentialRecoveryRequest,
  decryptCredentialRecoveryRequest,
  enqueueCredentialRecoveryRequest,
  expireCredentialRecoveryRequestJobs,
  leaseCredentialRecoveryRequestJobs,
  retryCredentialRecoveryRequest,
  CREDENTIAL_RECOVERY_JOB_LIMITS,
} from "./credential-recovery-request-jobs.ts";
import { drainCredentialRecoveryDeliveries } from "./credential-recovery-delivery-outbox.ts";
import { isRetryableCredentialRecoveryCryptoError } from "./credential-recovery-crypto.ts";
import { pruneCredentialRecoveryHistory } from "./credential-recovery-retention.ts";
import { isCredentialRecoveryEnabled } from "./credential-recovery-control.ts";

export function recoveryRequestProcessor(env: Env) {
  return {
    enqueue: (input: { email: string; ip: string }) =>
      enqueueCredentialRecoveryRequest(env, input),
  };
}

export async function drainCredentialRecoveryRequests(
  env: Env,
  now = Date.now(),
): Promise<{
  issuedCount: number;
  retryCount: number;
  expiredCount: number;
  parkedCount: number;
  failedCount: number;
  hasMore: boolean;
}> {
  const expiredAtStart = await expireCredentialRecoveryRequestJobs(env, now);
  let expiredCount = expiredAtStart;
  const jobs = await leaseCredentialRecoveryRequestJobs(env, now);
  let issuedCount = 0;
  let retryCount = 0;
  let parkedCount = 0;
  let failedCount = 0;
  const retryJob = async (
    job: (typeof jobs)[number],
    errorCode: string,
  ): Promise<void> => {
    let outcome: Awaited<ReturnType<typeof retryCredentialRecoveryRequest>>;
    try {
      outcome = await retryCredentialRecoveryRequest(
        env,
        job,
        errorCode,
        now,
      );
    } catch {
      failedCount += 1;
      console.error("[credential-recovery] request transition failed", {
        operation: "credential_recovery_request",
        requestId: job.id,
        errorCode,
        outcome: "transition_failed",
      });
      return;
    }
    if (outcome === "retried") retryCount += 1;
    if (outcome === "expired") expiredCount += 1;
    if (outcome === "parked") {
      parkedCount += 1;
      failedCount += 1;
    }
    if (outcome === "lost") failedCount += 1;
    console.info("[credential-recovery] request transition", {
      operation: "credential_recovery_request",
      requestId: job.id,
      errorCode,
      outcome,
    });
  };
  for (const job of jobs) {
    let email: string;
    try {
      ({ email } = await decryptCredentialRecoveryRequest(env, job));
    } catch (error) {
      if (isRetryableCredentialRecoveryCryptoError(error)) {
        await retryJob(job, "PAYLOAD_KEY_UNAVAILABLE");
        continue;
      }
      let parked = false;
      try {
        parked = await completeCredentialRecoveryRequest(
          env,
          job,
          "parked",
          "PAYLOAD_DECRYPT_OR_VALIDATION_FAILED",
          now,
        );
      } catch {}
      if (parked) parkedCount += 1;
      failedCount += 1;
      console.error("[credential-recovery] request parked", {
        operation: "credential_recovery_request",
        requestId: job.id,
        errorCode: "PAYLOAD_DECRYPT_OR_VALIDATION_FAILED",
        status: parked ? "parked" : "park_failed",
      });
      continue;
    }
    try {
      const user = await env.DB.prepare(
        `SELECT id, email, ownership_confirmed_at, is_active
         FROM users WHERE email = ?`,
      )
        .bind(email)
        .first<{
          id: string;
          email: string;
          ownership_confirmed_at: number | null;
          is_active: number;
        }>();
      if (!user || user.ownership_confirmed_at === null || user.is_active !== 1) {
        if (
          !(await completeCredentialRecoveryRequest(
            env,
            job,
            "suppressed",
            null,
            now,
          ))
        ) {
          failedCount += 1;
        } else {
          console.info("[credential-recovery] request suppressed", {
            operation: "credential_recovery_request",
            requestId: job.id,
            reasonCode: "ACCOUNT_INELIGIBLE",
          });
        }
        continue;
      }
      let recoveryEmail: string;
      try {
        recoveryEmail = recoveryAddressFor(
          env.ACCOUNT_RECOVERY_DIRECTORY,
          user.email,
          env.DOMAINS,
        );
      } catch (error) {
        if (!(error instanceof RecoveryDirectoryError)) throw error;
        await retryJob(
          job,
          error.code === "UNMAPPED"
            ? "RECOVERY_DIRECTORY_UNMAPPED"
            : "RECOVERY_DIRECTORY_INVALID_CONFIG",
        );
        continue;
      }
      const issuance = await credentialRecoveryWorkflow(env, { now: () => now }).issue({
        purpose: "recovery",
        userId: user.id,
        loginEmail: user.email,
        recoveryEmail,
        issuedBy: undefined,
        origin: resolveBrand(env.BRAND).mailOrigin,
        requestLease: { jobId: job.id, leaseToken: job.leaseToken },
      });
      if (issuance.issuance === "issued") {
        issuedCount += 1;
        console.info("[credential-recovery] request issued", {
          operation: "credential_recovery_request",
          requestId: job.id,
          outcome: "issued",
        });
      } else if (issuance.issuance === "expired") {
        expiredCount += 1;
      } else if (issuance.issuance === "lost") {
        failedCount += 1;
      }
    } catch (error) {
      console.error("[credential-recovery] request remains pending", {
        operation: "credential_recovery_request",
        requestId: job.id,
        errorCode: "REQUEST_PROCESSING_FAILED",
        errorName: privacySafeErrorName(error),
        status: "retry_pending",
      });
      await retryJob(job, "REQUEST_PROCESSING_FAILED");
    }
  }
  const result = {
    issuedCount,
    retryCount,
    expiredCount,
    parkedCount,
    failedCount,
    hasMore:
      jobs.length === CREDENTIAL_RECOVERY_JOB_LIMITS.batchSize ||
      expiredAtStart >= CREDENTIAL_RECOVERY_JOB_LIMITS.expiryBatchSize,
  };
  console.info("[credential-recovery] request drain complete", {
    operation: "credential_recovery_request_drain",
    ...result,
  });
  return result;
}

export async function runCredentialRecoveryMaintenance(env: Env): Promise<void> {
  if (!(await isCredentialRecoveryEnabled(env))) return;
  const requestResult = await Promise.allSettled([
    drainCredentialRecoveryRequests(env),
  ]);
  // Run after request issuance so this same best-effort pass can see the newly
  // committed outbox row. It still runs if request processing failed.
  const deliveryResult = await Promise.allSettled([
    drainCredentialRecoveryDeliveries(env),
  ]);
  const retentionResult = await Promise.allSettled([
    pruneCredentialRecoveryHistory(env),
  ]);
  const results = [...requestResult, ...deliveryResult];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
      continue;
    }
    if (result.value.failedCount > 0 || result.value.hasMore) {
      failures.push(new Error("Credential recovery maintenance is incomplete"));
    }
  }
  for (const result of retentionResult) {
    if (result.status === "rejected") failures.push(result.reason);
    else if (result.value.hasMore) {
      failures.push(new Error("Credential recovery retention backlog remains"));
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Credential recovery maintenance failed");
  }
}
