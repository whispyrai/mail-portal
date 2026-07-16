// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  projectInboundArchivePointer,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import { isSha256Hex } from "./lib/checksum.ts";
import {
  INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION,
  inboundDerivedContentAnomalyKey,
} from "./lib/inbound-derived-content-anomaly.ts";
import {
  projectInboundDerivedContentManifest,
  type InboundDerivedContentManifest,
  type InboundDerivedContentRepairAttemptIdentity,
  type InboundDerivedContentRepairAttemptTerminal,
} from "./lib/inbound-projection-contract.ts";
import { reconcilePendingInboundRepairAttempts } from "./lib/inbound-derived-content-repair-attempt.ts";
import { reconcileInboundCleanupIntents } from "./lib/inbound-derived-content-cleanup-intent.ts";
import type { InboundDerivedContentCleanupInput } from "./lib/inbound-derived-content-cleanup.ts";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "./lib/mail-address.ts";
import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
import { safeErrorCode } from "./lib/safe-error-code.ts";
import { INBOUND_ARCHIVE_RECONCILIATION_BATCH_SIZE } from "./lib/inbound-reconciliation-budget.ts";
import {
  inboundReconciliationAnomalyKey,
  isStoredPendingReconciliationAnomaly,
  type PendingReconciliationAnomaly,
  type StoredPendingReconciliationAnomaly,
} from "./lib/inbound-reconciliation-anomaly.ts";
import { MAX_EMAIL_SIZE } from "./lib/store-email.ts";

const RAW_PREFIX = "raw/";
const SWEEP_CURSOR_KEY = "system/reconciliation-cursor.json";
const FAILURE_LEDGER_PREFIX = "system/reconciliation-failures/";
const LIST_PAGE_SIZE = INBOUND_ARCHIVE_RECONCILIATION_BATCH_SIZE;
const STALE_HANDOFF_MS = 15 * 60 * 1000;
const MAX_DERIVED_OBJECTS_PER_PROJECTION = 512;
const DERIVED_HEAD_CONCURRENCY = 16;

type ArchiveMetadata = {
  key: string;
  size: number;
  etag: string;
  version: string;
  customMetadata?: Record<string, string>;
};

type ReceiptObject = {
  etag?: string;
  text(): Promise<string>;
};

type ReconciliationBucket = {
  list(options: { prefix: string; limit: number; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
  head(key: string): Promise<ArchiveMetadata | null>;
  get(key: string): Promise<ReceiptObject | null>;
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<{ etag?: string } | null>;
  delete(key: string): Promise<unknown>;
};

type ReconciliationEnvironment = {
  DOMAINS: string;
  EMAIL_ADDRESSES?: string[];
  DB: Pick<D1Database, "prepare">;
  BUCKET: Pick<R2Bucket, "head" | "list">;
  RAW_MAIL_BUCKET: ReconciliationBucket;
  INBOUND_QUEUE: Pick<Queue<InboundArchivePointer>, "send">;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): {
      getEmail(ingressId: string): Promise<unknown | null>;
      hasEmail?(ingressId: string): Promise<boolean>;
      isEmailDeleted?(ingressId: string): Promise<boolean>;
      getInboundTerminalFailure?(ingressId: string): Promise<{
        queueRef: string;
        attempts: number;
        errorCode: "QUEUE_RETRY_EXHAUSTED";
        recordedAt: string;
      } | null>;
      getInboundDerivedContentManifest?(
        ingressId: string,
      ): Promise<unknown>;
      finalizeInboundDerivedContentRepairAttempt?(
        identity: InboundDerivedContentRepairAttemptIdentity,
      ): Promise<InboundDerivedContentRepairAttemptTerminal>;
      enqueueUnownedInboundDerivedContentCleanup?(
        input: InboundDerivedContentCleanupInput,
      ): Promise<{ queued: number; retained: number; absent: number }>;
    };
  };
};

type ReconciliationRuntime = {
  now(): Date;
};

type Receipt = {
  etag?: string;
  errorCode?: unknown;
  state?: unknown;
  updatedAt?: unknown;
};

type InboundTerminalFailure = {
  queueRef: string;
  attempts: number;
  errorCode: "QUEUE_RETRY_EXHAUSTED";
  recordedAt: string;
};

type ReconciliationAnomalyResolution =
  | "admission_rejected"
  | "mailbox_projection_deleted"
  | "mailbox_projection_stored"
  | "terminal_failure_ledger_recovered"
  | "terminal_receipt_persisted";

type ArchivedAdmissionErrorCode =
  | "RECIPIENT_NOT_ALLOWED"
  | "MAILBOX_UNAVAILABLE"
  | "MAILBOX_INACTIVE"
  | "RAW_SIZE_INVALID";

type ReconciliationSubSweepStatus = "succeeded" | "degraded";
type ReconciliationSweepStatus = "succeeded" | "partial" | "failed";

export type ReconciliationResult = {
  scanned: number;
  reenqueued: number;
  skipped: number;
  invalid: number;
  failed: number;
  projectionMissing: number;
  pendingReview: number;
  terminalized: number;
  failureLedgered: number;
};

const defaultRuntime: ReconciliationRuntime = {
  now: () => new Date(),
};

function durationMs(runtime: ReconciliationRuntime, startedAt: number): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

function isReceipt(value: unknown): value is Receipt {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function projectInboundTerminalFailure(
  value: unknown,
): InboundTerminalFailure | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.queueRef !== "string" ||
    !/^[a-f0-9]{16}$/.test(value.queueRef) ||
    !Number.isSafeInteger(value.attempts) ||
    (value.attempts as number) < 0 ||
    value.errorCode !== "QUEUE_RETRY_EXHAUSTED" ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    new Date(value.recordedAt).toISOString() !== value.recordedAt
  ) {
    return null;
  }
  return {
    queueRef: value.queueRef,
    attempts: value.attempts as number,
    errorCode: value.errorCode,
    recordedAt: value.recordedAt,
  };
}

function failureLedgerKey(rawKey: string): string {
  return `${FAILURE_LEDGER_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

async function persistAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  anomaly: PendingReconciliationAnomaly,
  runtime: ReconciliationRuntime,
): Promise<void> {
  const record: StoredPendingReconciliationAnomaly = {
    detectedAt: runtime.now().toISOString(),
    errorCode: anomaly.errorCode,
    ...(anomaly.errorCode === "RAW_ARCHIVE_METADATA_INVALID"
      ? {}
      : { ingressId: anomaly.ingressId, mailboxId: anomaly.mailboxId }),
    rawKey,
    status: "pending_operator_review",
  };
  await bucket.put(
    inboundReconciliationAnomalyKey(rawKey),
    JSON.stringify(record),
    {
      customMetadata: {
        errorCode: anomaly.errorCode,
        status: "pending_operator_review",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
}

async function resolveAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  resolution: ReconciliationAnomalyResolution,
  runtime: ReconciliationRuntime,
): Promise<void> {
  const key = inboundReconciliationAnomalyKey(rawKey);
  const object = await bucket.get(key);
  if (!object) return;
  const value: unknown = JSON.parse(await object.text());
  if (
    !isStoredPendingReconciliationAnomaly(value) ||
    value.rawKey !== rawKey
  ) {
    return;
  }
  const resolved = await bucket.put(
    key,
    JSON.stringify({
      detectedAt: value.detectedAt,
      errorCode: value.errorCode,
      ...(value.ingressId === undefined
        ? {}
        : { ingressId: value.ingressId, mailboxId: value.mailboxId }),
      rawKey: value.rawKey,
      resolution,
      resolvedAt: runtime.now().toISOString(),
      status: "resolved",
    }),
    {
      customMetadata: {
        errorCode: value.errorCode,
        status: "resolved",
      },
      ...(object.etag ? { onlyIf: { etagMatches: object.etag } } : {}),
    },
  );
  if (!resolved) {
    const objectRef = await mailTelemetryLogRef("object", rawKey);
    console.log("[mail-reconciliation] anomaly resolution superseded", {
      objectRef,
      operation: "reconciliation_anomaly_resolve",
      status: "superseded",
    });
  }
}

function isStale(updatedAt: unknown, now: Date): boolean {
  if (typeof updatedAt !== "string") return true;
  const timestamp = Date.parse(updatedAt);
  return (
    !Number.isFinite(timestamp) || now.getTime() - timestamp >= STALE_HANDOFF_MS
  );
}

async function readSweepCursor(
  bucket: ReconciliationBucket,
): Promise<{ cursor?: string; etag?: string }> {
  const object = await bucket.get(SWEEP_CURSOR_KEY);
  if (!object) return {};
  try {
    const value: unknown = JSON.parse(await object.text());
    return {
      ...(isRecord(value) && typeof value.cursor === "string"
        ? { cursor: value.cursor }
        : {}),
      ...(object.etag ? { etag: object.etag } : {}),
    };
  } catch {
    return { ...(object.etag ? { etag: object.etag } : {}) };
  }
}

function pointerFromArchive(
  archive: ArchiveMetadata,
): InboundArchivePointer | null {
  const metadata = archive.customMetadata;
  if (!metadata) return null;
  const {
    archivedAt,
    ingressId,
    mailboxId,
    rawSize,
    rawSha256,
    schemaVersion,
  } = metadata;
  const parsedSize = Number(rawSize);
  if (
    schemaVersion !== String(INBOUND_RECEIPT_SCHEMA_VERSION) ||
    !ingressId ||
    !mailboxId ||
    !archivedAt ||
    !Number.isFinite(Date.parse(archivedAt)) ||
    !Number.isSafeInteger(parsedSize) ||
    parsedSize <= 0 ||
    parsedSize > MAX_EMAIL_SIZE ||
    parsedSize !== archive.size ||
    (rawSha256 !== undefined && !isSha256Hex(rawSha256)) ||
    !archive.key.endsWith(`/${ingressId}.eml`) ||
    !archive.etag ||
    !archive.version
  ) {
    return null;
  }

  return {
    schemaVersion: INBOUND_RECEIPT_SCHEMA_VERSION,
    ingressId,
    rawKey: archive.key,
    mailboxId,
    rawSize: parsedSize,
    ...(rawSha256 ? { rawSha256 } : {}),
    archivedAt,
    etag: archive.etag,
    version: archive.version,
  };
}

async function readReceipt(
  bucket: ReconciliationBucket,
  ingressId: string,
): Promise<Receipt | null> {
  const object = await bucket.get(`receipts/${ingressId}.json`);
  if (!object) return null;
  try {
    const value: unknown = JSON.parse(await object.text());
    return isReceipt(value) ? { ...value, etag: object.etag } : null;
  } catch {
    return null;
  }
}

function shouldEnqueue(receipt: Receipt | null, now: Date): boolean {
  if (!receipt) return false;
  if (
    receipt.state === "stored" ||
    receipt.state === "deleted" ||
    receipt.state === "quarantined" ||
    receipt.state === "rejected" ||
    receipt.state === "dead_lettered"
  ) {
    return false;
  }
  if (receipt.state === "archived" || receipt.state === "admitted") return true;
  if (receipt.state === "dead_letter_pending") return false;
  if (receipt.state !== "enqueued" && receipt.state !== "retrying") {
    return false;
  }
  return isStale(receipt.updatedAt, now);
}

async function archivedAdmission(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  archive: ArchiveMetadata,
): Promise<
  { admitted: true } | { admitted: false; errorCode: ArchivedAdmissionErrorCode }
> {
  const declaredRawSize = archive.customMetadata?.declaredRawSize;
  if (declaredRawSize !== undefined) {
    const parsedDeclaredRawSize = Number(declaredRawSize);
    if (
      !Number.isSafeInteger(parsedDeclaredRawSize) ||
      parsedDeclaredRawSize <= 0 ||
      parsedDeclaredRawSize > MAX_EMAIL_SIZE ||
      parsedDeclaredRawSize !== pointer.rawSize
    ) {
      return { admitted: false, errorCode: "RAW_SIZE_INVALID" };
    }
  }
  const mailboxId = normalizeMailAddress(pointer.mailboxId);
  const allowed = (env.EMAIL_ADDRESSES ?? []).map((address) => address.toLowerCase());
  if (
    !mailboxId ||
    !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS) ||
    (allowed.length > 0 && !allowed.includes(mailboxId))
  ) {
    return { admitted: false, errorCode: "RECIPIENT_NOT_ALLOWED" };
  }
  if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
    return { admitted: false, errorCode: "MAILBOX_UNAVAILABLE" };
  }
  const active = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE id = ?1 AND is_active = 1 LIMIT 1",
  )
    .bind(mailboxId)
    .first<{ id: string }>();
  return active
    ? { admitted: true }
    : { admitted: false, errorCode: "MAILBOX_INACTIVE" };
}

async function inspectStoredDerivedContent(
  env: ReconciliationEnvironment,
  pointer: InboundArchivePointer,
  mailbox: ReturnType<ReconciliationEnvironment["MAILBOX"]["get"]>,
  runtime: ReconciliationRuntime,
): Promise<boolean> {
  if (!mailbox.getInboundDerivedContentManifest) return false;
  const manifestValue = await mailbox.getInboundDerivedContentManifest(
    pointer.ingressId,
  );
  const manifest = projectInboundDerivedContentManifest(
    manifestValue,
    pointer.ingressId,
  );
  if (!manifest) {
    throw new Error("Mailbox derived-content manifest is invalid");
  }
  if (manifest.status !== "live_inbound") return false;
  const objects = [
    ...manifest.attachments.map((attachment) => ({
      objectType: "attachment" as const,
      objectId: attachment.id,
      r2Key: attachment.r2Key,
      expectedBytes: attachment.byteLength,
    })),
    ...manifest.bodyObjects.map((bodyObject) => ({
      objectType: "body" as const,
      objectId: bodyObject.id,
      r2Key: bodyObject.r2Key,
      expectedBytes: bodyObject.byteLength,
    })),
  ];
  if (objects.length > MAX_DERIVED_OBJECTS_PER_PROJECTION) {
    throw new Error("Inbound derived-content manifest exceeds the bounded scan limit");
  }
  const failures: Array<{
    objectType: "attachment" | "body";
    objectId: string;
    expectedBytes: number;
    actualBytes: number | null;
    reason: "missing" | "size_mismatch";
  }> = [];
  for (let offset = 0; offset < objects.length; offset += DERIVED_HEAD_CONCURRENCY) {
    const batch = objects.slice(offset, offset + DERIVED_HEAD_CONCURRENCY);
    const heads = await Promise.all(
      batch.map((object) => env.BUCKET.head(object.r2Key)),
    );
    for (const [index, object] of batch.entries()) {
      const head = heads[index];
      if (!head) {
        failures.push({
          objectType: object.objectType,
          objectId: object.objectId,
          expectedBytes: object.expectedBytes,
          actualBytes: null,
          reason: "missing",
        });
      } else if (head.size !== object.expectedBytes) {
        failures.push({
          objectType: object.objectType,
          objectId: object.objectId,
          expectedBytes: object.expectedBytes,
          actualBytes: head.size,
          reason: "size_mismatch",
        });
      }
    }
  }
  if (failures.length === 0) return false;
  const markerId = crypto.randomUUID();
  const detectedAt = runtime.now().toISOString();
  const marker = await env.RAW_MAIL_BUCKET.put(
    inboundDerivedContentAnomalyKey(pointer.ingressId, manifest.generation),
    JSON.stringify({
      schemaVersion: INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION,
      kind: "inbound_derived_content_anomaly",
      status: "pending",
      markerId,
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      generation: manifest.generation,
      detectedAt,
      failures,
    }),
    {
      customMetadata: {
        generation: String(manifest.generation),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        status: "pending",
      },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
  const ingressRef = await mailTelemetryLogRef("ingress", pointer.ingressId);
  console.error("[mail-reconciliation] derived content anomaly detected", {
    anomalyCount: failures.length,
    errorCode: "INBOUND_DERIVED_CONTENT_ANOMALY",
    generation: manifest.generation,
    ingressRef,
    operation: "derived_content_integrity_scan",
    status: marker ? "pending" : "already_pending",
  });
  return true;
}

async function reconcileArchive(
  rawKey: string,
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime,
): Promise<
  | "reenqueued"
  | "skipped"
  | "invalid"
  | "projectionMissing"
  | "pendingReview"
  | "terminalized"
> {
  const startedAt = runtime.now().getTime();
  const objectRef = await mailTelemetryLogRef("object", rawKey);
  const archive = await env.RAW_MAIL_BUCKET.head(rawKey);
  const pointer = archive ? pointerFromArchive(archive) : null;
  if (!archive || !pointer) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      { errorCode: "RAW_ARCHIVE_METADATA_INVALID" },
      runtime,
    );
    console.error("[mail-reconciliation] archive metadata invalid", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "RAW_ARCHIVE_METADATA_INVALID",
      objectRef,
      operation: "archive_reconcile",
      status: "invalid",
    });
    return "invalid";
  }

  const ingressRef = await mailTelemetryLogRef("ingress", pointer.ingressId);

  const now = runtime.now();
  let receipt = await readReceipt(env.RAW_MAIL_BUCKET, pointer.ingressId);
  if (!receipt) {
    await env.RAW_MAIL_BUCKET.put(
      `system/inbound-recovery-pointers/${pointer.ingressId}.json`,
      JSON.stringify(projectInboundArchivePointer(pointer)),
      {
        customMetadata: {
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          status: "pending_operator_review",
        },
        onlyIf: { etagDoesNotMatch: "*" },
      },
    );
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      {
        errorCode: "ADMISSION_DECISION_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    console.error("[mail-reconciliation] admission decision missing", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "ADMISSION_DECISION_MISSING",
      ingressRef,
      objectRef,
      operation: "archive_reconcile",
      recoveryAction: "operator_review",
      status: "preserved",
    });
    return "pendingReview";
  }
  const knownReceiptStates = new Set([
    "admitted",
    "archived",
    "dead_letter_pending",
    "dead_lettered",
    "deleted",
    "enqueued",
    "quarantined",
    "rejected",
    "retrying",
    "stored",
  ]);
  if (
    typeof receipt.state !== "string" ||
    !knownReceiptStates.has(receipt.state)
  ) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      {
        errorCode: "RECEIPT_STATE_UNKNOWN",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    console.error("[mail-reconciliation] receipt state unknown", {
      errorCode: "RECEIPT_STATE_UNKNOWN",
      ingressRef,
      objectRef,
      operation: "archive_reconcile",
      status: "pending_operator_review",
    });
    return "pendingReview";
  }
  if (receipt.state === "archived" || receipt.state === "admitted") {
    const admission = await archivedAdmission(env, pointer, archive);
    if (!admission.admitted) {
      const rejected = await env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "rejected",
          updatedAt: now.toISOString(),
          reconciled: true,
          errorCode: admission.errorCode,
        }),
        {
          customMetadata: { state: "rejected" },
          onlyIf: receipt.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      );
      if (rejected) {
        await resolveAnomaly(
          env.RAW_MAIL_BUCKET,
          pointer.rawKey,
          "admission_rejected",
          runtime,
        );
        console.log("[mail-reconciliation] archived admission rejected", {
          durationMs: durationMs(runtime, startedAt),
          errorCode: admission.errorCode,
          ingressRef,
          objectRef,
          operation: "archive_admission",
          status: "rejected",
        });
        return "terminalized";
      }
      return "skipped";
    }
    if (receipt.state === "archived") {
      const admitted = await env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "admitted",
          updatedAt: now.toISOString(),
          reconciled: true,
        }),
        {
          customMetadata: { state: "admitted" },
          onlyIf: receipt.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      );
      if (!admitted) return "skipped";
      const refreshed = await readReceipt(
        env.RAW_MAIL_BUCKET,
        pointer.ingressId,
      );
      if (refreshed?.state !== "admitted") return "skipped";
      receipt = refreshed;
    }
  }
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const receiptNeedsMailboxTruthRepair =
    receipt.state === "quarantined" ||
    receipt.state === "rejected" ||
    receipt.state === "dead_letter_pending" ||
    receipt.state === "dead_lettered";
  if (
    receiptNeedsMailboxTruthRepair &&
    mailbox.isEmailDeleted &&
    (await mailbox.isEmailDeleted(pointer.ingressId))
  ) {
    const deletedReceipt = await env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state: "deleted",
        updatedAt: now.toISOString(),
        reconciled: true,
        errorCode: "MAILBOX_PROJECTION_DELETED",
      }),
      {
        customMetadata: { state: "deleted" },
        onlyIf: receipt.etag
          ? { etagMatches: receipt.etag }
          : { etagDoesNotMatch: "*" },
      },
    );
    if (!deletedReceipt) {
      console.log("[mail-reconciliation] deletion state superseded", {
        ingressRef,
        objectRef,
        operation: "deleted_projection_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "deleted_projection_terminalize",
      status: "deleted",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
    return "terminalized";
  }
  if (receiptNeedsMailboxTruthRepair) {
    const projectionExists = mailbox.hasEmail
      ? await mailbox.hasEmail(pointer.ingressId)
      : Boolean(await mailbox.getEmail(pointer.ingressId));
    if (projectionExists) {
      const storedReceipt = await env.RAW_MAIL_BUCKET.put(
        `receipts/${pointer.ingressId}.json`,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state: "stored",
          updatedAt: now.toISOString(),
          reconciled: true,
          errorCode: "MAILBOX_PROJECTION_RECOVERED",
        }),
        {
          customMetadata: { state: "stored" },
          onlyIf: receipt.etag
            ? { etagMatches: receipt.etag }
            : { etagDoesNotMatch: "*" },
        },
      );
      if (!storedReceipt) {
        console.log("[mail-reconciliation] stored state superseded", {
          ingressRef,
          objectRef,
          operation: "stored_projection_recover",
          status: "superseded",
        });
        return "skipped";
      }
      console.log("[mail-reconciliation] stored projection recovered", {
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "stored_projection_recover",
        status: "stored",
      });
      await resolveAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        "mailbox_projection_stored",
        runtime,
      );
      return "terminalized";
    }
  }
  const staleHandoff =
    receipt.state === "archived" ||
    receipt.state === "admitted" ||
    ((receipt.state === "enqueued" ||
      receipt.state === "retrying" ||
      receipt.state === "dead_letter_pending") &&
      isStale(receipt.updatedAt, now));
  const terminalFailureValue =
    (staleHandoff || receipt.state === "dead_lettered") &&
    mailbox.getInboundTerminalFailure
      ? await mailbox.getInboundTerminalFailure(pointer.ingressId)
      : null;
  const terminalFailure = projectInboundTerminalFailure(terminalFailureValue);
  if (terminalFailureValue && !terminalFailure) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      {
        errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    return "pendingReview";
  }
  if (terminalFailure) {
    const errorCode = "DLQ_TERMINAL_LEDGER_RECOVERED";
    const terminalReceipt = await env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state: "dead_lettered",
        updatedAt: now.toISOString(),
        reconciled: true,
        errorCode,
        terminalFailure: {
          queueRef: terminalFailure.queueRef,
          attempts: terminalFailure.attempts,
          errorCode: terminalFailure.errorCode,
          recordedAt: terminalFailure.recordedAt,
        },
      }),
      {
        customMetadata: { state: "dead_lettered" },
        onlyIf: receipt?.etag
          ? { etagMatches: receipt.etag }
          : { etagDoesNotMatch: "*" },
      },
    );
    if (!terminalReceipt) {
      console.log("[mail-reconciliation] dead-letter state superseded", {
        ingressRef,
        objectRef,
        operation: "dead_letter_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.error("[mail-reconciliation] stale dead-letter terminalized", {
      durationMs: durationMs(runtime, startedAt),
      errorCode,
      ingressRef,
      objectRef,
      operation: "dead_letter_terminalize",
      status: "dead_lettered",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "terminal_failure_ledger_recovered",
      runtime,
    );
    return "terminalized";
  }
  if (receipt.state === "dead_lettered") {
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "terminal_receipt_persisted",
      runtime,
    );
    console.log("[mail-reconciliation] terminal receipt confirmed", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "dead_letter_terminalize",
      status: "dead_lettered",
      target: "r2",
    });
    return "terminalized";
  }
  if (
    receipt.state === "dead_letter_pending" &&
    isStale(receipt.updatedAt, now)
  ) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      {
        errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
      },
      runtime,
    );
    console.error("[mail-reconciliation] stale dead-letter remains pending", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
      ingressRef,
      objectRef,
      operation: "dead_letter_reconcile",
      status: "pending_operator_review",
    });
    return "pendingReview";
  }
  if (
    (receipt?.state === "stored" || shouldEnqueue(receipt, now)) &&
    mailbox.isEmailDeleted &&
    (await mailbox.isEmailDeleted(pointer.ingressId))
  ) {
    const deletedReceipt = await env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state: "deleted",
        updatedAt: now.toISOString(),
        reconciled: true,
        errorCode: "MAILBOX_PROJECTION_DELETED",
      }),
      {
        customMetadata: { state: "deleted" },
        onlyIf: receipt?.etag
          ? { etagMatches: receipt.etag }
          : { etagDoesNotMatch: "*" },
      },
    );
    if (!deletedReceipt) {
      console.log("[mail-reconciliation] deletion state superseded", {
        ingressRef,
        objectRef,
        operation: "deleted_projection_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "deleted_projection_terminalize",
      status: "deleted",
    });
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
    return "terminalized";
  }
  if (receipt?.state === "stored") {
    const projectionExists = mailbox.hasEmail
      ? await mailbox.hasEmail(pointer.ingressId)
      : Boolean(await mailbox.getEmail(pointer.ingressId));
    if (!projectionExists) {
      await persistAnomaly(
        env.RAW_MAIL_BUCKET,
        pointer.rawKey,
        {
          errorCode: "STORED_PROJECTION_MISSING",
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
        },
        runtime,
      );
      console.error("[mail-reconciliation] stored projection is missing", {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "STORED_PROJECTION_MISSING",
        ingressRef,
        objectRef,
        operation: "archive_reconcile",
        status: "projection_missing",
      });
      return "projectionMissing";
    }
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_stored",
      runtime,
    );
    if (await inspectStoredDerivedContent(env, pointer, mailbox, runtime)) {
      return "pendingReview";
    }
  }
  if (
    receipt?.state === "deleted" &&
    mailbox.isEmailDeleted &&
    (await mailbox.isEmailDeleted(pointer.ingressId))
  ) {
    await resolveAnomaly(
      env.RAW_MAIL_BUCKET,
      pointer.rawKey,
      "mailbox_projection_deleted",
      runtime,
    );
  }
  if (!shouldEnqueue(receipt, now)) {
    console.log("[mail-reconciliation] archive skipped", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      objectRef,
      operation: "archive_reconcile",
      status: "skipped",
    });
    return "skipped";
  }

  const enqueueStartedAt = runtime.now().getTime();
  await env.INBOUND_QUEUE.send(projectInboundArchivePointer(pointer));
  const receiptWrite = await env.RAW_MAIL_BUCKET.put(
    `receipts/${pointer.ingressId}.json`,
    JSON.stringify({
      ...projectInboundArchivePointer(pointer),
      state: "enqueued",
      updatedAt: now.toISOString(),
      reconciled: true,
    }),
    {
      customMetadata: { state: "enqueued" },
      onlyIf: receipt?.etag
        ? { etagMatches: receipt.etag }
        : { etagDoesNotMatch: "*" },
    },
  );
  if (!receiptWrite) {
    console.log("[mail-reconciliation] receipt state superseded", {
      ingressRef,
      objectRef,
      operation: "receipt_write",
      status: "superseded",
    });
  }
  console.log("[mail-reconciliation] archive re-enqueued", {
    durationMs: durationMs(runtime, enqueueStartedAt),
    ingressRef,
    objectRef,
    operation: "archive_reconcile",
    status: "reenqueued",
    target: "cloudflare_queue",
  });
  return "reenqueued";
}

export async function reconcileInboundArchives(
  env: ReconciliationEnvironment,
  runtime: ReconciliationRuntime = defaultRuntime,
): Promise<ReconciliationResult> {
  const sweepStartedAt = runtime.now().getTime();
  const result: ReconciliationResult = {
    scanned: 0,
    reenqueued: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    pendingReview: 0,
    terminalized: 0,
    failureLedgered: 0,
  };
  let repairScanned = 0;
  let repairResolved = 0;
  let repairSweepStatus: ReconciliationSubSweepStatus = "succeeded";
  let cleanupScanned = 0;
  let cleanupAccepted = 0;
  let cleanupSweepStatus: ReconciliationSubSweepStatus = "succeeded";
  let terminalSummaryEmitted = false;
  const emitTerminalSummary = (status: ReconciliationSweepStatus): void => {
    if (terminalSummaryEmitted) return;
    terminalSummaryEmitted = true;
    if (status === "failed") {
      console.error("[mail-reconciliation] sweep completed", {
        cleanupAccepted,
        cleanupScanned,
        cleanupSweepStatus,
        durationMs: durationMs(runtime, sweepStartedAt),
        errorCode: "RECONCILIATION_SWEEP_FAILED",
        failed: result.failed,
        failureLedgered: result.failureLedgered,
        invalid: result.invalid,
        operation: "archive_reconcile_sweep",
        pendingReview: result.pendingReview,
        projectionMissing: result.projectionMissing,
        reenqueued: result.reenqueued,
        repairResolved,
        repairScanned,
        repairSweepStatus,
        scanned: result.scanned,
        skipped: result.skipped,
        status,
        terminalized: result.terminalized,
      });
      return;
    }
    console.log("[mail-reconciliation] sweep completed", {
      cleanupAccepted,
      cleanupScanned,
      cleanupSweepStatus,
      durationMs: durationMs(runtime, sweepStartedAt),
      failed: result.failed,
      failureLedgered: result.failureLedgered,
      invalid: result.invalid,
      operation: "archive_reconcile_sweep",
      pendingReview: result.pendingReview,
      projectionMissing: result.projectionMissing,
      reenqueued: result.reenqueued,
      repairResolved,
      repairScanned,
      repairSweepStatus,
      scanned: result.scanned,
      skipped: result.skipped,
      status,
      terminalized: result.terminalized,
    });
  };

  console.log("[mail-reconciliation] sweep started", {
    operation: "archive_reconcile_sweep",
    status: "started",
  });

  try {
    try {
      const repairResult = await reconcilePendingInboundRepairAttempts(
        {
          RAW_MAIL_BUCKET: env.RAW_MAIL_BUCKET,
          MAILBOX: env.MAILBOX,
        },
        runtime,
      );
      repairScanned = repairResult.scanned;
      repairResolved = repairResult.resolved;
    } catch {
      repairSweepStatus = "degraded";
      console.error("[mail-reconciliation] repair-attempt sweep degraded", {
        errorCode: "INBOUND_REPAIR_ATTEMPT_SWEEP_FAILED",
        operation: "repair_attempt_reconcile",
        status: "degraded",
      });
    }
    try {
      const cleanupResult = await reconcileInboundCleanupIntents(
        {
          RAW_MAIL_BUCKET: env.RAW_MAIL_BUCKET,
          BUCKET: env.BUCKET,
          MAILBOX: env.MAILBOX,
        },
        runtime.now(),
      );
      cleanupScanned = cleanupResult.scanned;
      cleanupAccepted = cleanupResult.accepted;
    } catch {
      cleanupSweepStatus = "degraded";
      console.error("[mail-reconciliation] cleanup-intent sweep degraded", {
        errorCode: "INBOUND_CLEANUP_INTENT_SWEEP_FAILED",
        operation: "cleanup_intent_reconcile",
        status: "degraded",
      });
    }
    const cursorState = await readSweepCursor(env.RAW_MAIL_BUCKET);
    const listStartedAt = runtime.now().getTime();
    const page = await env.RAW_MAIL_BUCKET.list({
      prefix: RAW_PREFIX,
      limit: LIST_PAGE_SIZE,
      ...(cursorState.cursor ? { cursor: cursorState.cursor } : {}),
    });
    console.log("[mail-reconciliation] archive page listed", {
      count: page.objects.length,
      durationMs: durationMs(runtime, listStartedAt),
      operation: "archive_list",
      status: "succeeded",
      target: "r2",
      truncated: page.truncated,
    });
    for (const object of page.objects) {
      result.scanned += 1;
      const objectRef = await mailTelemetryLogRef("object", object.key);
      try {
        const outcome = await reconcileArchive(object.key, env, runtime);
        result[outcome] += 1;
        try {
          await env.RAW_MAIL_BUCKET.delete(failureLedgerKey(object.key));
        } catch (error) {
          console.error(
            "[mail-reconciliation] failure ledger cleanup degraded",
            {
              errorCode: safeErrorCode(
                error,
                "RECONCILIATION_LEDGER_CLEANUP_FAILED",
              ),
              objectRef,
              operation: "reconciliation_failure_ledger_delete",
              status: "degraded",
            },
          );
        }
      } catch (error) {
        result.failed += 1;
        const failureCode = safeErrorCode(
          error,
          "ARCHIVE_RECONCILIATION_FAILED",
        );
        console.error("[mail-reconciliation] archive reconciliation failed", {
          errorCode: failureCode,
          objectRef,
          operation: "archive_reconcile",
          status: "failed",
        });
        try {
          const ledgered = await env.RAW_MAIL_BUCKET.put(
            failureLedgerKey(object.key),
            JSON.stringify({
              rawKey: object.key,
              failedAt: runtime.now().toISOString(),
              errorCode: failureCode,
            }),
            { customMetadata: { status: "pending" } },
          );
          if (!ledgered) throw new Error("R2 rejected failure ledger write");
          result.failureLedgered += 1;
          console.error("[mail-reconciliation] failure durably ledgered", {
            errorCode: "ARCHIVE_RECONCILIATION_LEDGERED",
            objectRef,
            operation: "reconciliation_failure_ledger_write",
            status: "pending",
          });
        } catch (ledgerError) {
          console.error("[mail-reconciliation] failure ledger write failed", {
            errorCode: safeErrorCode(
              ledgerError,
              "RECONCILIATION_LEDGER_WRITE_FAILED",
            ),
            objectRef,
            operation: "reconciliation_failure_ledger_write",
            status: "failed",
          });
        }
      }
    }
    if (page.truncated && !page.cursor) {
      throw new Error(
        "R2 returned a truncated archive page without a continuation cursor",
      );
    }
    if (result.failed > result.failureLedgered) {
      console.error("[mail-reconciliation] sweep cursor held for retry", {
        errorCode: "RECONCILIATION_PAGE_INCOMPLETE",
        failed: result.failed - result.failureLedgered,
        operation: "reconciliation_cursor_write",
        status: "deferred",
      });
      emitTerminalSummary("partial");
      return result;
    }

    const cursorWriteStartedAt = runtime.now().getTime();
    const cursorWritten = await env.RAW_MAIL_BUCKET.put(
      SWEEP_CURSOR_KEY,
      JSON.stringify({
        cursor: page.truncated ? page.cursor : null,
        updatedAt: runtime.now().toISOString(),
      }),
      {
        onlyIf: cursorState.etag
          ? { etagMatches: cursorState.etag }
          : { etagDoesNotMatch: "*" },
      },
    );
    if (!cursorWritten) {
      console.log("[mail-reconciliation] sweep cursor update superseded", {
        operation: "reconciliation_cursor_write",
        status: "superseded",
      });
      emitTerminalSummary("partial");
      return result;
    }
    console.log("[mail-reconciliation] sweep cursor persisted", {
      durationMs: durationMs(runtime, cursorWriteStartedAt),
      operation: "reconciliation_cursor_write",
      status: "succeeded",
      target: "r2",
      truncated: page.truncated,
    });

    const status: ReconciliationSweepStatus =
      repairSweepStatus === "degraded" ||
      cleanupSweepStatus === "degraded" ||
      result.failed > 0
        ? "partial"
        : "succeeded";
    emitTerminalSummary(status);
    return result;
  } catch (error) {
    emitTerminalSummary("failed");
    throw error;
  }
}
