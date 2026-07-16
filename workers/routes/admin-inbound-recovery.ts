import { Hono } from "hono";
import {
  inboundDerivedContentAnomalyKey,
  isInboundDerivedContentAnomaly,
  type InboundDerivedContentAnomaly,
} from "../lib/inbound-derived-content-anomaly.ts";
import {
  AuditedInboundRecoveryError,
  recoverInboundEmailWithAudit,
  type AuditedProjectionResult,
} from "../lib/import/audited-inbound-recovery.ts";
import { recoverStreamingInboundEmail } from "../lib/import/recover-inbound.ts";
import { liveInboundProjectionOptions } from "../lib/live-inbound-projection.ts";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "../lib/mail-address.ts";
import {
  DerivedEmailConsumerError,
  deriveStreamingEmail,
} from "../lib/streaming-email.ts";
import { inboundRawArchiveMatchesPointer } from "../lib/inbound-raw-integrity.ts";
import { isInboundArchivePointer } from "../inbound-queue.ts";
import type { InboundArchivePointer } from "../inbound-email.ts";
import {
  projectInboundDerivedContentManifest,
  type InboundDerivedContentRepairResult,
} from "../lib/inbound-projection-contract.ts";
import { resolveAmbiguousInboundRepair } from "../lib/ambiguous-inbound-repair.ts";
import {
  INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
  pendingRepairAttemptKey,
  persistPendingRepairAttempt,
  repairAttemptProof,
  inboundDerivedContentRepairCommandFingerprint,
  resolveRepairAttempt,
  type InboundDerivedContentRepairAttempt,
} from "../lib/inbound-derived-content-repair-attempt.ts";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import { mailTelemetryLogRef } from "../lib/mail-telemetry.ts";
import {
  inboundReconciliationAnomalyKey,
  isStoredPendingReconciliationAnomaly,
} from "../lib/inbound-reconciliation-anomaly.ts";

type AdminInboundRecoveryEnv = {
  Bindings: Env;
  Variables: { session?: SessionClaims };
};

const adminInboundRecoveryApp = new Hono<AdminInboundRecoveryEnv>();

function adminRecoveryResult(
  result: AuditedProjectionResult,
  auditId: string,
) {
  if (result.status === "recovered") {
    return {
      status: "recovered" as const,
      ambiguousCommit: result.ambiguousCommit,
      auditId,
    };
  }
  if (result.status === "skipped") {
    return { status: "skipped" as const, reason: result.reason, auditId };
  }
  if (result.status === "repaired") {
    return {
      status: "repaired" as const,
      generation: result.generation,
      ...(result.ambiguousCommit === undefined
        ? {}
        : { ambiguousCommit: result.ambiguousCommit }),
      auditId,
    };
  }
  if (
    result.status === "already_repaired" ||
    result.status === "cleanup_conflict" ||
    result.status === "stale_marker"
  ) {
    return {
      status: result.status,
      ...(result.generation === undefined
        ? {}
        : { generation: result.generation }),
      auditId,
    };
  }
  return { status: result.status, auditId };
}

async function finishRepairAttempt(
  env: Env,
  attempt: InboundDerivedContentRepairAttempt,
  resolution: "discarded" | "owned",
) {
  try {
    const resolved = await resolveRepairAttempt(
      env.RAW_MAIL_BUCKET,
      attempt,
      resolution,
    );
    if (!resolved) throw new Error("R2 rejected repair-attempt resolution");
    if (resolution === "owned") {
      await env.RAW_MAIL_BUCKET.delete(
        pendingRepairAttemptKey(attempt.ingressId, attempt.attemptId),
      );
    }
  } catch {
    const [attemptRef, ingressRef] = await Promise.all([
      mailTelemetryLogRef("attempt", attempt.attemptId),
      mailTelemetryLogRef("ingress", attempt.ingressId),
    ]);
    console.error("[mail-recovery] repair-attempt bookkeeping degraded", {
      attemptRef,
      errorCode: "INBOUND_REPAIR_ATTEMPT_BOOKKEEPING_FAILED",
      ingressRef,
      operation: "manual_inbound_recovery_audit",
      resolution,
      status: "degraded",
    });
  }
}

async function readPointer(env: Env, ingressId: string, mailboxId: string) {
  const receipt = await env.RAW_MAIL_BUCKET.get(`receipts/${ingressId}.json`);
  if (receipt) {
    try {
      const value: unknown = JSON.parse(await receipt.text());
      if (isInboundArchivePointer(value) && value.mailboxId === mailboxId) {
        return value;
      }
    } catch {
      // Reconciliation owns the only safe fallback for malformed receipts.
    }
  }

  const recoveryPointer = await env.RAW_MAIL_BUCKET.get(
    `system/inbound-recovery-pointers/${ingressId}.json`,
  );
  if (!recoveryPointer) {
    if (receipt) throw new Error("INBOUND_RECOVERY_POINTER_INVALID");
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(await recoveryPointer.text());
  } catch {
    throw new Error("INBOUND_RECOVERY_POINTER_MALFORMED");
  }
  if (!isInboundArchivePointer(value) || value.mailboxId !== mailboxId) {
    throw new Error("INBOUND_RECOVERY_POINTER_INVALID");
  }
  const anomalyObject = await env.RAW_MAIL_BUCKET.get(
    inboundReconciliationAnomalyKey(value.rawKey),
  );
  if (!anomalyObject) throw new Error("INBOUND_RECOVERY_POINTER_INVALID");
  let anomaly: unknown;
  try {
    anomaly = JSON.parse(await anomalyObject.text());
  } catch {
    throw new Error("INBOUND_RECOVERY_POINTER_INVALID");
  }
  if (
    !isStoredPendingReconciliationAnomaly(anomaly) ||
    anomaly.errorCode !== "ADMISSION_DECISION_MISSING" ||
    anomaly.ingressId !== value.ingressId ||
    anomaly.mailboxId !== value.mailboxId ||
    anomaly.rawKey !== value.rawKey
  ) {
    throw new Error("INBOUND_RECOVERY_POINTER_INVALID");
  }
  return value;
}

async function readVerifiedRaw(env: Env, pointer: InboundArchivePointer) {
  const raw = await env.RAW_MAIL_BUCKET.get(pointer.rawKey);
  if (!raw || !inboundRawArchiveMatchesPointer(raw, pointer)) {
    throw new Error("INBOUND_RAW_INTEGRITY_FAILED");
  }
  return raw;
}

adminInboundRecoveryApp.post("/recover-inbound/:mailboxId", async (c) => {
  const session = c.get("session");
  if (!session || session.role !== "ADMIN") {
    return c.json({ error: "Forbidden" }, 403);
  }
  let mailboxId: string | null = null;
  try {
    mailboxId = normalizeMailAddress(decodeURIComponent(c.req.param("mailboxId")));
  } catch {
    return c.json({ error: "Invalid recovery request" }, 400);
  }
  const ingressId = c.req.query("ingressId")?.trim();
  const allowed = (c.env.EMAIL_ADDRESSES as unknown as string[]).map(
    (address) => address.toLowerCase(),
  );
  if (
    !mailboxId ||
    !isAddressInConfiguredMailDomains(mailboxId, c.env.DOMAINS) ||
    (allowed.length > 0 && !allowed.includes(mailboxId)) ||
    !ingressId ||
    !/^[A-Za-z0-9_-]{1,300}$/.test(ingressId)
  ) {
    return c.json({ error: "Invalid recovery request" }, 400);
  }
  const [mailboxMarker, activeMailbox] = await Promise.all([
    c.env.BUCKET.head(`mailboxes/${mailboxId}.json`),
    c.env.DB.prepare(
      "SELECT id FROM mailboxes WHERE id = ?1 AND is_active = 1 LIMIT 1",
    )
      .bind(mailboxId)
      .first<{ id: string }>(),
  ]);
  if (!mailboxMarker || !activeMailbox) {
    return c.json({ error: "Active mailbox not found" }, 404);
  }

  let pointer: InboundArchivePointer | null;
  try {
    pointer = await readPointer(c.env, ingressId, mailboxId);
  } catch {
    return c.json({ error: "Inbound recovery pointer is invalid" }, 409);
  }
  if (!pointer) return c.json({ error: "Inbound recovery pointer not found" }, 404);

  const mailbox = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(mailboxId));
  if (!mailbox.getInboundDerivedContentManifest) {
    return c.json({ error: "Inbound recovery is unavailable" }, 503);
  }
  const manifest = projectInboundDerivedContentManifest(
    await mailbox.getInboundDerivedContentManifest(ingressId),
    ingressId,
  );
  if (!manifest) {
    return c.json({ error: "Inbound derived-content manifest is invalid" }, 409);
  }
  if (manifest.status === "deleted") {
    return c.json({ status: "deleted" }, 200);
  }
  if (manifest.status === "not_live_inbound") {
    return c.json({ error: "Only live inbound mail can be repaired" }, 409);
  }

  let marker:
    | {
        key: string;
        etag?: string;
        value: InboundDerivedContentAnomaly;
      }
    | undefined;
  if (manifest.status === "live_inbound") {
    const key = inboundDerivedContentAnomalyKey(
      ingressId,
      manifest.generation,
    );
    const markerObject = await c.env.RAW_MAIL_BUCKET.get(key);
    if (!markerObject) {
      return c.json(
        { error: "No current derived-content anomaly authorizes repair" },
        409,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await markerObject.text());
    } catch {
      return c.json({ error: "Derived-content anomaly marker is invalid" }, 409);
    }
    if (
      !isInboundDerivedContentAnomaly(value) ||
      value.status !== "pending" ||
      value.ingressId !== ingressId ||
      value.mailboxId !== mailboxId ||
      value.generation !== manifest.generation
    ) {
      return c.json({ error: "Derived-content anomaly marker is stale" }, 409);
    }
    marker = { key, etag: markerObject.etag, value };
  }

  let raw: Awaited<ReturnType<typeof readVerifiedRaw>>;
  try {
    raw = await readVerifiedRaw(c.env, pointer);
  } catch {
    return c.json({ error: "Archived inbound message failed verification" }, 409);
  }

  const startedAt = Date.now();
  let audited: Awaited<ReturnType<typeof recoverInboundEmailWithAudit>>;
  try {
    audited = await recoverInboundEmailWithAudit({
      auditBucket: c.env.RAW_MAIL_BUCKET,
      dependencies: { bucket: c.env.BUCKET, mailbox },
      pointer,
      operator: { id: session.sub, email: session.email },
      recover: marker
        ? () => {
            if (
              !mailbox.repairInboundDerivedContent ||
              !mailbox.finalizeInboundDerivedContentRepairAttempt
            ) {
              throw new Error("Inbound derived-content repair is unavailable");
            }
            return deriveStreamingEmail(
              { bucket: c.env.BUCKET, mailbox },
              raw.body,
              liveInboundProjectionOptions({
                brand: c.env.BRAND,
                mailboxId,
                messageId: ingressId,
                date: pointer.archivedAt,
                allowTerminalRecovery: true,
              }),
              async (derived) => {
                const attemptId = derived.projectionAttemptId;
                const commandWithoutFingerprint = {
                  attemptId,
                  emailId: ingressId,
                  expectedGeneration: marker!.value.generation,
                  markerId: marker!.value.markerId,
                  body: derived.parsed.html ?? derived.parsed.text ?? "",
                  attachments: derived.attachments,
                  bodyObjects: derived.bodyObjects,
                };
                const command = {
                  ...commandWithoutFingerprint,
                  commandFingerprint:
                    await inboundDerivedContentRepairCommandFingerprint(
                      commandWithoutFingerprint,
                    ),
                };
                const attempt: InboundDerivedContentRepairAttempt = {
                  schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
                  kind: "inbound_derived_content_repair_attempt",
                  status: "pending",
                  attemptId,
                  ingressId,
                  mailboxId,
                  expectedGeneration: marker!.value.generation,
                  markerId: marker!.value.markerId,
                  commandFingerprint: command.commandFingerprint,
                  createdAt: new Date().toISOString(),
                  proof: repairAttemptProof(command),
                };
                if (
                  !(await persistPendingRepairAttempt(
                    c.env.RAW_MAIL_BUCKET,
                    attempt,
                  ))
                ) {
                  throw new DerivedEmailConsumerError(
                    "not_committed",
                    new Error("Repair intent could not be durably recorded"),
                  );
                }
                await derived.activateCommand(command.commandFingerprint);
                let result: InboundDerivedContentRepairResult;
                try {
                  result = await mailbox.repairInboundDerivedContent!(command);
                } catch (repairError) {
                  try {
                    result = await resolveAmbiguousInboundRepair({
                      repairError,
                      finalizeAttempt: () =>
                        mailbox.finalizeInboundDerivedContentRepairAttempt!({
                          attemptId: attempt.attemptId,
                          emailId: attempt.ingressId,
                          expectedGeneration: attempt.expectedGeneration,
                          markerId: attempt.markerId,
                          commandFingerprint: attempt.commandFingerprint,
                          proof: attempt.proof,
                        }),
                    });
                  } catch (error) {
                    if (
                      error instanceof DerivedEmailConsumerError &&
                      error.commitState === "not_committed"
                    ) {
                      await finishRepairAttempt(c.env, attempt, "discarded");
                    }
                    throw error;
                  }
                }
                await finishRepairAttempt(
                  c.env,
                  attempt,
                  result.status === "repaired" ? "owned" : "discarded",
                );
                return {
                  repairResult: result,
                  keepDerivedObjects: result.status === "repaired",
                };
              },
              c.env.RAW_MAIL_BUCKET,
            ).then(({ result }) => result.repairResult);
          }
        : () =>
            recoverStreamingInboundEmail(
              { bucket: c.env.BUCKET, mailbox },
              raw.body,
              {
                ingressId,
                archivedAt: pointer.archivedAt,
                mailboxId,
                brand: c.env.BRAND,
              },
              c.env.RAW_MAIL_BUCKET,
            ),
    });
  } catch (error) {
    if (
      error instanceof AuditedInboundRecoveryError &&
      error.stage === "completion_audit" &&
      error.result
    ) {
      return c.json(
        {
          ...adminRecoveryResult(error.result, error.auditId),
          auditStatus: "incomplete",
          recoveryGuidance:
            "The mutation result committed. Do not rerun recovery until an operator verifies the current mailbox manifest and completion audit using this auditId.",
        },
        503,
      );
    }
    const stage =
      error instanceof AuditedInboundRecoveryError ? error.stage : "projection";
    const consumerError =
      error instanceof AuditedInboundRecoveryError &&
      error.cause instanceof DerivedEmailConsumerError
        ? error.cause
        : null;
    const recoveryAuditId =
      error instanceof AuditedInboundRecoveryError
        ? error.auditId
        : "unavailable";
    const [auditRef, ingressRef] = await Promise.all([
      mailTelemetryLogRef("audit", recoveryAuditId),
      mailTelemetryLogRef("ingress", ingressId),
    ]);
    console.error("[mail-recovery] inbound recovery failed", {
      auditRef,
      durationMs: Date.now() - startedAt,
      errorCode: "MANUAL_INBOUND_RECOVERY_FAILED",
      ingressRef,
      operation: "manual_inbound_recovery",
      stage,
      status: "failed",
    });
    if (consumerError?.commitState === "unverified") {
      return c.json(
        {
          error: "Repair outcome could not be verified",
          commitStatus: "unverified",
          auditId: recoveryAuditId,
          recoveryGuidance:
            "Do not retry blindly. Re-run integrity reconciliation and inspect the current generation and repair marker first.",
        },
        503,
      );
    }
    return c.json(
      { error: stage === "request_audit" ? "Recovery audit unavailable" : "Recovery failed" },
      stage === "request_audit" ? 503 : 500,
    );
  }

  if (marker && audited.result.status === "repaired") {
    try {
      await c.env.RAW_MAIL_BUCKET.put(
        marker.key,
        JSON.stringify({
          schemaVersion: marker.value.schemaVersion,
          kind: marker.value.kind,
          status: "resolved",
          markerId: marker.value.markerId,
          ingressId: marker.value.ingressId,
          mailboxId: marker.value.mailboxId,
          generation: marker.value.generation,
          detectedAt: marker.value.detectedAt,
          failures: marker.value.failures.map((failure) => ({
            objectType: failure.objectType,
            objectId: failure.objectId,
            expectedBytes: failure.expectedBytes,
            actualBytes: failure.actualBytes,
            reason: failure.reason,
          })),
          resolvedAt: audited.recoveredAt,
          repairAuditId: audited.auditId,
        }),
        {
          customMetadata: {
            generation: String(marker.value.generation),
            ingressId,
            mailboxId,
            status: "resolved",
          },
          ...(marker.etag ? { onlyIf: { etagMatches: marker.etag } } : {}),
        },
      );
    } catch {
      const [auditRef, ingressRef] = await Promise.all([
        mailTelemetryLogRef("audit", audited.auditId),
        mailTelemetryLogRef("ingress", ingressId),
      ]);
      console.error("[mail-recovery] anomaly marker resolution degraded", {
        auditRef,
        errorCode: "DERIVED_CONTENT_MARKER_RESOLUTION_FAILED",
        ingressRef,
        operation: "manual_inbound_recovery_audit",
        status: "degraded",
      });
    }
  }

  return c.json(adminRecoveryResult(audited.result, audited.auditId), 200);
});

export { adminInboundRecoveryApp };
