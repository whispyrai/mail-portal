// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import { isSha256Hex } from "./lib/checksum.ts";

const RAW_PREFIX = "raw/";
const SWEEP_CURSOR_KEY = "system/reconciliation-cursor.json";
const FAILURE_LEDGER_PREFIX = "system/reconciliation-failures/";
const ANOMALY_LEDGER_PREFIX = "system/reconciliation-anomalies/";
const LIST_PAGE_SIZE = 100;
const STALE_HANDOFF_MS = 15 * 60 * 1000;

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
  ): Promise<unknown | null>;
  delete(key: string): Promise<unknown>;
};

type ReconciliationEnvironment = {
  RAW_MAIL_BUCKET: ReconciliationBucket;
  INBOUND_QUEUE: Pick<Queue<InboundArchivePointer>, "send">;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): {
      getEmail(ingressId: string): Promise<unknown | null>;
      hasEmail?(ingressId: string): Promise<boolean>;
      isEmailDeleted?(ingressId: string): Promise<boolean>;
      getInboundTerminalFailure?(ingressId: string): Promise<{
        queueMessageId: string;
        attempts: number;
        errorCode: string;
        recordedAt: string;
      } | null>;
    };
  };
};

type ReconciliationRuntime = {
  now(): Date;
};

type Receipt = {
  etag?: string;
  state?: unknown;
  updatedAt?: unknown;
};

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationMs(runtime: ReconciliationRuntime, startedAt: number): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

function isReceipt(value: unknown): value is Receipt {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function failureLedgerKey(rawKey: string): string {
  return `${FAILURE_LEDGER_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

function anomalyLedgerKey(rawKey: string): string {
  return `${ANOMALY_LEDGER_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

async function persistAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  errorCode: string,
  details: Record<string, unknown>,
  runtime: ReconciliationRuntime,
): Promise<void> {
  await bucket.put(
    anomalyLedgerKey(rawKey),
    JSON.stringify({
      ...details,
      detectedAt: runtime.now().toISOString(),
      errorCode,
      rawKey,
      status: "pending_operator_review",
    }),
    {
      customMetadata: { errorCode, status: "pending_operator_review" },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
}

async function resolveAnomaly(
  bucket: ReconciliationBucket,
  rawKey: string,
  resolution: string,
  runtime: ReconciliationRuntime,
): Promise<void> {
  const key = anomalyLedgerKey(rawKey);
  const object = await bucket.get(key);
  if (!object) return;
  const value: unknown = JSON.parse(await object.text());
  if (!isRecord(value) || value.status !== "pending_operator_review") return;
  const resolved = await bucket.put(
    key,
    JSON.stringify({
      ...value,
      resolution,
      resolvedAt: runtime.now().toISOString(),
      status: "resolved",
    }),
    {
      customMetadata: {
        errorCode:
          typeof value.errorCode === "string" ? value.errorCode : "UNKNOWN",
        status: "resolved",
      },
      ...(object.etag ? { onlyIf: { etagMatches: object.etag } } : {}),
    },
  );
  if (!resolved) {
    console.log("[mail-reconciliation] anomaly resolution superseded", {
      operation: "reconciliation_anomaly_resolve",
      rawKey,
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
  const archive = await env.RAW_MAIL_BUCKET.head(rawKey);
  const pointer = archive ? pointerFromArchive(archive) : null;
  if (!pointer) {
    await persistAnomaly(
      env.RAW_MAIL_BUCKET,
      rawKey,
      "RAW_ARCHIVE_METADATA_INVALID",
      {},
      runtime,
    );
    console.error("[mail-reconciliation] archive metadata invalid", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "RAW_ARCHIVE_METADATA_INVALID",
      operation: "archive_reconcile",
      rawKey,
      status: "invalid",
    });
    return "invalid";
  }

  const now = runtime.now();
  const receipt = await readReceipt(env.RAW_MAIL_BUCKET, pointer.ingressId);
  if (!receipt) {
    await env.RAW_MAIL_BUCKET.put(
      `system/inbound-recovery-pointers/${pointer.ingressId}.json`,
      JSON.stringify(pointer),
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
      "ADMISSION_DECISION_MISSING",
      { ingressId: pointer.ingressId, mailboxId: pointer.mailboxId },
      runtime,
    );
    console.error("[mail-reconciliation] admission decision missing", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "ADMISSION_DECISION_MISSING",
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "archive_reconcile",
      rawKey,
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
      "RECEIPT_STATE_UNKNOWN",
      {
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        receiptState: receipt.state,
      },
      runtime,
    );
    console.error("[mail-reconciliation] receipt state unknown", {
      errorCode: "RECEIPT_STATE_UNKNOWN",
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "archive_reconcile",
      rawKey,
      status: "pending_operator_review",
    });
    return "pendingReview";
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
        ...pointer,
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "deleted_projection_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "deleted_projection_terminalize",
      rawKey: pointer.rawKey,
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
          ...pointer,
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
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "stored_projection_recover",
          status: "superseded",
        });
        return "skipped";
      }
      console.log("[mail-reconciliation] stored projection recovered", {
        durationMs: durationMs(runtime, startedAt),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "stored_projection_recover",
        rawKey: pointer.rawKey,
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
  const terminalFailure =
    (staleHandoff || receipt.state === "dead_lettered") &&
    mailbox.getInboundTerminalFailure
      ? await mailbox.getInboundTerminalFailure(pointer.ingressId)
      : null;
  if (terminalFailure) {
    const errorCode = "DLQ_TERMINAL_LEDGER_RECOVERED";
    const terminalReceipt = await env.RAW_MAIL_BUCKET.put(
      `receipts/${pointer.ingressId}.json`,
      JSON.stringify({
        ...pointer,
        state: "dead_lettered",
        updatedAt: now.toISOString(),
        reconciled: true,
        errorCode,
        ...(terminalFailure ? { terminalFailure } : {}),
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "dead_letter_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.error("[mail-reconciliation] stale dead-letter terminalized", {
      durationMs: durationMs(runtime, startedAt),
      errorCode,
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "dead_letter_terminalize",
      rawKey: pointer.rawKey,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "dead_letter_terminalize",
      rawKey: pointer.rawKey,
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
      "DLQ_TERMINAL_LEDGER_MISSING",
      { ingressId: pointer.ingressId, mailboxId: pointer.mailboxId },
      runtime,
    );
    console.error("[mail-reconciliation] terminal ledger missing", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "dead_letter_terminalize",
      rawKey: pointer.rawKey,
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
        ...pointer,
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "deleted_projection_terminalize",
        status: "superseded",
      });
      return "skipped";
    }
    console.log("[mail-reconciliation] deleted projection terminalized", {
      durationMs: durationMs(runtime, startedAt),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "deleted_projection_terminalize",
      rawKey: pointer.rawKey,
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
        "STORED_PROJECTION_MISSING",
        { ingressId: pointer.ingressId, mailboxId: pointer.mailboxId },
        runtime,
      );
      console.error("[mail-reconciliation] stored projection is missing", {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "STORED_PROJECTION_MISSING",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "archive_reconcile",
        rawKey: pointer.rawKey,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "archive_reconcile",
      receiptState: receipt?.state,
      status: "skipped",
    });
    return "skipped";
  }

  const enqueueStartedAt = runtime.now().getTime();
  await env.INBOUND_QUEUE.send(pointer);
  const receiptWrite = await env.RAW_MAIL_BUCKET.put(
    `receipts/${pointer.ingressId}.json`,
    JSON.stringify({
      ...pointer,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "receipt_write",
      status: "superseded",
    });
  }
  console.log("[mail-reconciliation] archive re-enqueued", {
    durationMs: durationMs(runtime, enqueueStartedAt),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
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
    try {
      const outcome = await reconcileArchive(object.key, env, runtime);
      result[outcome] += 1;
      try {
        await env.RAW_MAIL_BUCKET.delete(failureLedgerKey(object.key));
      } catch (error) {
        console.error("[mail-reconciliation] failure ledger cleanup degraded", {
          errorCode: "RECONCILIATION_LEDGER_CLEANUP_FAILED",
          errorMessage: errorMessage(error),
          operation: "reconciliation_failure_ledger_delete",
          rawKey: object.key,
          status: "degraded",
        });
      }
    } catch (error) {
      result.failed += 1;
      console.error("[mail-reconciliation] archive reconciliation failed", {
        errorCode: "ARCHIVE_RECONCILIATION_FAILED",
        errorMessage: errorMessage(error),
        operation: "archive_reconcile",
        rawKey: object.key,
        status: "failed",
      });
      try {
        const ledgered = await env.RAW_MAIL_BUCKET.put(
          failureLedgerKey(object.key),
          JSON.stringify({
            rawKey: object.key,
            failedAt: runtime.now().toISOString(),
            errorMessage: errorMessage(error),
          }),
          { customMetadata: { status: "pending" } },
        );
        if (!ledgered) throw new Error("R2 rejected failure ledger write");
        result.failureLedgered += 1;
        console.error("[mail-reconciliation] failure durably ledgered", {
          errorCode: "ARCHIVE_RECONCILIATION_LEDGERED",
          operation: "reconciliation_failure_ledger_write",
          rawKey: object.key,
          status: "pending",
        });
      } catch (ledgerError) {
        console.error("[mail-reconciliation] failure ledger write failed", {
          errorCode: "RECONCILIATION_LEDGER_WRITE_FAILED",
          errorMessage: errorMessage(ledgerError),
          operation: "reconciliation_failure_ledger_write",
          rawKey: object.key,
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
    return result;
  }
  console.log("[mail-reconciliation] sweep cursor persisted", {
    durationMs: durationMs(runtime, cursorWriteStartedAt),
    operation: "reconciliation_cursor_write",
    status: "succeeded",
    target: "r2",
    truncated: page.truncated,
  });

  return result;
}
