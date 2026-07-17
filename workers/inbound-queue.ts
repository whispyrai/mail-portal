// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  projectInboundArchivePointer,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import { liveInboundProjectionOptions } from "./lib/live-inbound-projection.ts";
import {
  MAX_EMAIL_SIZE,
  emailExists,
  isEmailDeletedDuringProjection,
  isEmailTerminalDuringProjection,
  storeParsedEmail,
  type EmailStorageDependencies,
} from "./lib/store-email.ts";
import {
  isPermanentMimeProjectionError,
  permanentMimeProjectionErrorCode,
  storeStreamingEmail,
} from "./lib/streaming-email.ts";
import { isSha256Hex } from "./lib/checksum.ts";
import { inboundRawArchiveMatchesPointer } from "./lib/inbound-raw-integrity.ts";
import {
  mailTelemetryLogRef,
  mailTelemetryRef,
} from "./lib/mail-telemetry.ts";
import { clearInboundActiveMarker } from "./lib/inbound-active-index.ts";
import { isInboundRawKeyForIngress } from "./lib/inbound-raw-key.ts";
import {
  beginEmergencyForward,
  type EmergencyForwardEnvelope,
  type EmergencyForwardReason,
} from "./lib/emergency-forward.ts";
import { hasExactInboundSmtpRejectionAuthority } from "./lib/inbound-smtp-rejection.ts";
import { inboundTerminalAuthorityRequirement } from "./lib/inbound-terminal-authority.ts";
import {
  createQueueDisposition,
  runInboundWorkWithDeadline,
  type InboundDeadlineScheduler,
  type InboundQueueDisposition,
} from "./lib/inbound-work-deadline.ts";

export const INBOUND_MAX_RETRIES = 10;
export const INBOUND_QUEUE_ITEM_TIMEOUT_MS = 60_000;
export const INBOUND_DLQ_ITEM_TIMEOUT_MS = 15_000;
export const INBOUND_BINDING_TIMEOUT_MS = 5_000;
export const INBOUND_EMERGENCY_HANDOFF_TIMEOUT_MS = 10_000;
export const INBOUND_RECOVERY_RETRY_SECONDS = 30;
export const INBOUND_ISOLATED_RETRY_SECONDS = 300;

type ArchivedEmailObject = {
  key: string;
  version: string;
  size: number;
  etag: string;
  body: ReadableStream;
  text(): Promise<string>;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
};

type InboundReceiptBucket = {
  delete?(key: string): Promise<unknown>;
  get(key: string): Promise<ArchivedEmailObject | null>;
  head?(key: string): Promise<{
    etag: string;
    customMetadata?: Record<string, string>;
  } | null>;
  put(
    key: string,
    value: string,
    options?: {
      customMetadata?: Record<string, string>;
      httpMetadata?: { contentType?: string };
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<unknown | null>;
};

async function bestEffortMailTelemetryLogRef(
  kind: "ingress" | "object" | "queue",
  value: string,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mailTelemetryLogRef(kind, value),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => resolve("unavailable"), 25);
      }),
    ]);
  } catch {
    return "unavailable";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function clearTerminalActiveMarkerBestEffort(
  bucket: InboundReceiptBucket,
  pointer: InboundArchivePointer,
  runtime: InboundProjectionRuntime,
): Promise<void> {
  if (!bucket.delete) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      clearInboundActiveMarker(
        { delete: bucket.delete.bind(bucket) },
        pointer.rawKey,
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, runtime.infrastructureTimeoutMs ?? 100);
      }),
    ]);
  } catch {
    const [ingressRef, objectRef] = await Promise.all([
      bestEffortMailTelemetryLogRef("ingress", pointer.ingressId),
      bestEffortMailTelemetryLogRef("object", pointer.rawKey),
    ]);
    console.error("[mail-projection] terminal active marker cleanup degraded", {
      errorCode: "ACTIVE_RECOVERY_INDEX_DELETE_FAILED",
      ingressRef,
      objectRef,
      operation: "active_recovery_index_delete",
      recoveryAction: "scheduled_reconciliation",
      status: "degraded",
    });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

type InboundMailboxNamespace = {
  idFromName(mailboxId: string): unknown;
  get(id: unknown): EmailStorageDependencies["mailbox"];
};

type InboundProjectionEnvironment = {
  BRAND?: string;
  DB: Pick<D1Database, "prepare">;
  RAW_MAIL_BUCKET: InboundReceiptBucket;
  BUCKET: EmailStorageDependencies["bucket"] & {
    head(key: string): Promise<unknown | null>;
  };
  MAILBOX: InboundMailboxNamespace;
  EMERGENCY_FORWARD_QUEUE: Pick<Queue<EmergencyForwardEnvelope>, "send">;
};

type QueueMessage = Pick<
  Message<InboundArchivePointer>,
  "id" | "timestamp" | "body" | "attempts" | "ack" | "retry"
>;

type UntrustedQueueMessage = Pick<
  Message<unknown>,
  "id" | "timestamp" | "body" | "attempts" | "ack" | "retry"
>;

type InboundProjectionRuntime = {
  parse?(raw: ReadableStream): Promise<Email>;
  now(): Date;
  infrastructureTimeoutMs?: number;
  itemTimeoutMs?: number;
  deadLetterItemTimeoutMs?: number;
  emergencyHandoffTimeoutMs?: number;
  deadlineScheduler?: InboundDeadlineScheduler;
  projectionExpiresAt?: number;
};

const INBOUND_RETRY_ERROR_CODES = [
  "IDEMPOTENCY_CHECK_FAILED",
  "MAILBOX_ACTIVE_CHECK_FAILED",
  "MAILBOX_ACTIVE_RECHECK_FAILED",
  "MAILBOX_MARKER_READ_FAILED",
  "MAILBOX_PROJECTION_FAILED",
  "RAW_ARCHIVE_READ_FAILED",
] as const;

type InboundRetryErrorCode = (typeof INBOUND_RETRY_ERROR_CODES)[number];

const INBOUND_RECEIPT_ERROR_CODES = new Set<string>([
  ...INBOUND_RETRY_ERROR_CODES,
  "EMAXLEN",
  "MAILBOX_INACTIVE",
  "MAILBOX_PROJECTION_DELETED",
  "MAILBOX_PROJECTION_STORED",
  "MAILBOX_UNAVAILABLE",
  "MIME_CHARSET_UNSUPPORTED",
  "MIME_HEADER_SIZE_EXCEEDED",
  "MIME_MULTIPART_BOUNDARY_INVALID",
  "MIME_MULTIPART_BOUNDARY_MISSING",
  "MIME_PARSE_FAILED",
  "MIME_ROOT_HEADER_MISSING",
  "QUEUE_RETRY_EXHAUSTED",
  "RAW_ARCHIVE_INTEGRITY_MISMATCH",
]);

type InboundReceiptDetails = {
  attempt?: number;
  delaySeconds?: number;
  errorCode?: string;
  providerAccepted?: true;
  rejectionOrigin?: "smtp_ingress";
  queueRef?: string;
};

const defaultRuntime: InboundProjectionRuntime = {
  now: () => new Date(),
};

function receiptKey(ingressId: string): string {
  return `receipts/${ingressId}.json`;
}

function invalidPointerKey(queueRef: string): string {
  return `invalid-queue-pointers/${queueRef}.json`;
}

function queueBodyKind(
  body: unknown,
):
  | "array"
  | "bigint"
  | "boolean"
  | "function"
  | "null"
  | "number"
  | "object"
  | "string"
  | "symbol"
  | "undefined" {
  if (body === null) return "null";
  if (Array.isArray(body)) return "array";
  return typeof body;
}

async function persistInvalidPointer(
  bucket: InboundReceiptBucket,
  message: UntrustedQueueMessage,
  queueRef: string,
  errorCode: "INVALID_QUEUE_POINTER" | "INVALID_DLQ_POINTER",
  runtime: InboundProjectionRuntime,
): Promise<void> {
  await bucket.put(
    invalidPointerKey(queueRef),
    JSON.stringify({
      attempts: message.attempts,
      bodyKind: queueBodyKind(message.body),
      errorCode,
      queueRef,
      recordedAt: runtime.now().toISOString(),
    }),
    {
      customMetadata: { errorCode },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
}

function durationMs(
  runtime: InboundProjectionRuntime,
  startedAt: number,
): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

async function projectionTelemetryRefs(
  pointer: InboundArchivePointer,
  queueMessageId: string,
) {
  const [ingressRef, objectRef, queueRef] = await Promise.all([
    bestEffortMailTelemetryLogRef("ingress", pointer.ingressId),
    bestEffortMailTelemetryLogRef("object", pointer.rawKey),
    bestEffortMailTelemetryLogRef("queue", queueMessageId),
  ]);
  return { ingressRef, objectRef, queueRef };
}

async function isActiveMailbox(
  env: Pick<InboundProjectionEnvironment, "DB">,
  mailboxId: string,
): Promise<boolean> {
  const active = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE id = ?1 AND is_active = 1 LIMIT 1",
  )
    .bind(mailboxId)
    .first<{ id: string }>();
  return Boolean(active);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isTerminalReceiptState(state: string | undefined): boolean {
  return (
    state === "stored" ||
    state === "deleted" ||
    state === "rejected" ||
    state === "forwarded"
  );
}

async function handOffToEmergencyForward(
  message: QueueMessage,
  pointer: InboundArchivePointer,
  env: Pick<
    InboundProjectionEnvironment,
    "RAW_MAIL_BUCKET" | "MAILBOX" | "EMERGENCY_FORWARD_QUEUE"
  >,
  runtime: InboundProjectionRuntime,
  reason: EmergencyForwardReason,
): Promise<boolean> {
  const authorityDurable = await establishEmergencyForwardAuthority(
    env,
    pointer,
    reason,
    runtime,
  );
  if (!authorityDurable) {
    await bestEffortDeadLetterTerminalLedger(message, pointer, env, runtime);
  }
  // The normal Queue delivery remains a recovery authority until the
  // emergency consumer durably records provider acceptance (or another exact
  // terminal proof wins). Returning without retry would auto-ack on
  // Cloudflare Queues and could strand a merely pending forward.
  message.retry({
    delaySeconds: authorityDurable
      ? INBOUND_ISOLATED_RETRY_SECONDS
      : INBOUND_RECOVERY_RETRY_SECONDS,
  });
  return authorityDurable;
}

function projectInboundReceiptDetails(
  details: InboundReceiptDetails,
): InboundReceiptDetails {
  if (
    details.attempt !== undefined &&
    (!Number.isSafeInteger(details.attempt) || details.attempt < 0)
  ) {
    throw new Error("Inbound receipt attempt is invalid");
  }
  if (
    details.delaySeconds !== undefined &&
    (!Number.isSafeInteger(details.delaySeconds) || details.delaySeconds < 0)
  ) {
    throw new Error("Inbound receipt delay is invalid");
  }
  if (
    details.errorCode !== undefined &&
    !INBOUND_RECEIPT_ERROR_CODES.has(details.errorCode)
  ) {
    throw new Error("Inbound receipt error code is invalid");
  }
  if (
    details.queueRef !== undefined &&
    !/^[a-f0-9]{16}$/.test(details.queueRef)
  ) {
    throw new Error("Inbound receipt Queue reference is invalid");
  }
  return {
    ...(details.attempt === undefined ? {} : { attempt: details.attempt }),
    ...(details.delaySeconds === undefined
      ? {}
      : { delaySeconds: details.delaySeconds }),
    ...(details.errorCode === undefined
      ? {}
      : { errorCode: details.errorCode }),
    ...(details.queueRef === undefined ? {} : { queueRef: details.queueRef }),
  };
}

export function isInboundArchivePointer(
  value: unknown,
): value is InboundArchivePointer {
  if (!isRecord(value)) return false;
  const {
    schemaVersion,
    ingressId,
    rawKey,
    mailboxId,
    rawSize,
    rawSha256,
    archivedAt,
    etag,
    version,
  } = value;
  return (
    schemaVersion === INBOUND_RECEIPT_SCHEMA_VERSION &&
    typeof ingressId === "string" &&
    /^[A-Za-z0-9_-]+$/.test(ingressId) &&
    typeof rawKey === "string" &&
    isInboundRawKeyForIngress(rawKey, ingressId) &&
    typeof mailboxId === "string" &&
    mailboxId.length > 2 &&
    mailboxId.includes("@") &&
    typeof rawSize === "number" &&
    Number.isSafeInteger(rawSize) &&
    rawSize > 0 &&
    rawSize <= MAX_EMAIL_SIZE &&
    (rawSha256 === undefined || isSha256Hex(rawSha256)) &&
    typeof archivedAt === "string" &&
    Number.isFinite(Date.parse(archivedAt)) &&
    typeof etag === "string" &&
    etag.length > 0 &&
    typeof version === "string" &&
    version.length > 0
  );
}

type ExactInboundReceipt = {
  state:
    | "admitted"
    | "archived"
    | "dead_letter_pending"
    | "dead_lettered"
    | "deleted"
    | "enqueued"
    | "forward_pending"
    | "forwarded"
    | "quarantined"
    | "rejected"
    | "retrying"
    | "stored";
  errorCode?: string;
};

type ExactInboundReceiptRead =
  | { status: "absent" }
  | { status: "invalid"; object?: ArchivedEmailObject }
  | {
      status: "valid";
      object: ArchivedEmailObject;
      receipt: ExactInboundReceipt;
    };

async function boundedInfrastructureWork<T>(
  work: () => Promise<T>,
  runtime: InboundProjectionRuntime,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Inbound infrastructure read timed out")),
          runtime.infrastructureTimeoutMs ?? INBOUND_BINDING_TIMEOUT_MS,
        );
      }),
    ]);
    return { ok: true, value };
  } catch {
    return { ok: false };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requireBoundedInfrastructureWork<T>(
  work: () => Promise<T>,
  runtime: InboundProjectionRuntime,
): Promise<T> {
  const result = await boundedInfrastructureWork(work, runtime);
  if (!result.ok) throw new Error("Inbound infrastructure work failed");
  return result.value;
}

async function establishEmergencyForwardAuthority(
  env: Pick<
    InboundProjectionEnvironment,
    "RAW_MAIL_BUCKET" | "EMERGENCY_FORWARD_QUEUE"
  >,
  pointer: InboundArchivePointer,
  reason: EmergencyForwardReason,
  runtime: InboundProjectionRuntime,
): Promise<boolean> {
  const result = await runInboundWorkWithDeadline(
    async () => beginEmergencyForward(env, pointer, reason, runtime),
    {
      now: () => runtime.now().getTime(),
      scheduler: runtime.deadlineScheduler,
      timeoutMs:
        runtime.emergencyHandoffTimeoutMs ??
        INBOUND_EMERGENCY_HANDOFF_TIMEOUT_MS,
    },
  );
  return result.status === "completed";
}

function exactReceiptPointerMatches(
  value: Record<string, unknown>,
  pointer: InboundArchivePointer,
): boolean {
  return (
    value.schemaVersion === pointer.schemaVersion &&
    value.ingressId === pointer.ingressId &&
    value.rawKey === pointer.rawKey &&
    value.mailboxId === pointer.mailboxId &&
    value.rawSize === pointer.rawSize &&
    value.rawSha256 === pointer.rawSha256 &&
    value.archivedAt === pointer.archivedAt &&
    value.etag === pointer.etag &&
    value.version === pointer.version
  );
}

const EXACT_RECEIPT_POINTER_FIELDS = [
  "schemaVersion",
  "ingressId",
  "rawKey",
  "mailboxId",
  "rawSize",
  "rawSha256",
  "archivedAt",
  "etag",
  "version",
] as const;

function exactReceiptHasOnly(
  value: Record<string, unknown>,
  details: readonly string[] = [],
): boolean {
  const allowed = new Set([
    ...EXACT_RECEIPT_POINTER_FIELDS,
    "state",
    "updatedAt",
    ...details,
  ]);
  return Object.keys(value).every((key) => allowed.has(key));
}

function exactReceiptTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function exactReceiptNonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function exactTerminalFailureIsValid(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) =>
      ["queueRef", "attempts", "errorCode", "recordedAt"].includes(key),
    ) &&
    typeof value.queueRef === "string" &&
    /^[a-f0-9]{16}$/.test(value.queueRef) &&
    exactReceiptNonNegativeInteger(value.attempts) &&
    value.errorCode === "QUEUE_RETRY_EXHAUSTED" &&
    exactReceiptTimestamp(value.recordedAt)
  );
}

function exactReceiptDetailsAreValid(value: Record<string, unknown>): boolean {
  switch (value.state) {
    case "archived":
      return exactReceiptHasOnly(value);
    case "admitted":
    case "enqueued":
      return (
        exactReceiptHasOnly(value, ["reconciled"]) &&
        (value.reconciled === undefined || value.reconciled === true)
      );
    case "retrying":
    case "dead_letter_pending":
      return (
        exactReceiptHasOnly(value, ["attempt", "delaySeconds", "errorCode"]) &&
        exactReceiptNonNegativeInteger(value.attempt) &&
        exactReceiptNonNegativeInteger(value.delaySeconds) &&
        typeof value.errorCode === "string" &&
        INBOUND_RECEIPT_ERROR_CODES.has(value.errorCode)
      );
    case "dead_lettered":
      if (
        !exactReceiptHasOnly(value, [
          "attempt",
          "errorCode",
          "queueRef",
          "reconciled",
          "terminalFailure",
        ])
      ) {
        return false;
      }
      if (value.reconciled === true) {
        return (
          value.attempt === undefined &&
          value.queueRef === undefined &&
          value.errorCode === "DLQ_TERMINAL_LEDGER_RECOVERED" &&
          exactTerminalFailureIsValid(value.terminalFailure)
        );
      }
      if (
        value.reconciled !== undefined ||
        value.terminalFailure !== undefined ||
        value.errorCode !== "QUEUE_RETRY_EXHAUSTED"
      ) {
        return false;
      }
      if (value.attempt === undefined && value.queueRef === undefined) {
        return true;
      }
      return (
        exactReceiptNonNegativeInteger(value.attempt) &&
        typeof value.queueRef === "string" &&
        /^[a-f0-9]{16}$/.test(value.queueRef)
      );
    case "forward_pending":
      return (
        exactReceiptHasOnly(value, ["errorCode"]) &&
        typeof value.errorCode === "string" &&
        (value.errorCode === "QUEUE_RETRY_EXHAUSTED" ||
          INBOUND_RECEIPT_ERROR_CODES.has(value.errorCode)) &&
        value.errorCode !== "MAILBOX_UNAVAILABLE" &&
        value.errorCode !== "RAW_ARCHIVE_INTEGRITY_MISMATCH"
      );
    case "forwarded":
      return (
        exactReceiptHasOnly(value, ["providerAccepted", "providerRef"]) &&
        value.providerAccepted === true &&
        (value.providerRef === undefined ||
          (typeof value.providerRef === "string" &&
            /^[a-f0-9]{16}$/.test(value.providerRef)))
      );
    case "stored":
      return (
        exactReceiptHasOnly(value, ["errorCode", "reconciled"]) &&
        ((value.reconciled === undefined &&
          (value.errorCode === undefined ||
            value.errorCode === "MAILBOX_PROJECTION_STORED")) ||
          (value.reconciled === true &&
            value.errorCode === "MAILBOX_PROJECTION_RECOVERED"))
      );
    case "deleted":
      return (
        exactReceiptHasOnly(value, ["errorCode", "reconciled"]) &&
        value.errorCode === "MAILBOX_PROJECTION_DELETED" &&
        (value.reconciled === undefined || value.reconciled === true)
      );
    case "rejected":
      return (
        exactReceiptHasOnly(value, ["errorCode", "rejectionOrigin"]) &&
        hasExactInboundSmtpRejectionAuthority(value)
      );
    case "quarantined":
      return (
        exactReceiptHasOnly(value, ["errorCode"]) &&
        typeof value.errorCode === "string" &&
        INBOUND_RECEIPT_ERROR_CODES.has(value.errorCode)
      );
    default:
      return false;
  }
}

async function readExactInboundReceipt(
  bucket: Pick<InboundReceiptBucket, "get">,
  pointer: InboundArchivePointer,
  runtime: InboundProjectionRuntime,
): Promise<ExactInboundReceiptRead> {
  const key = receiptKey(pointer.ingressId);
  const objectRead = await boundedInfrastructureWork(() => bucket.get(key), runtime);
  if (!objectRead.ok) return { status: "invalid" };
  const object = objectRead.value;
  if (!object) return { status: "absent" };
  if (typeof object.etag !== "string" || object.etag.trim().length === 0) {
    return { status: "invalid", object };
  }
  let value: unknown;
  const textRead = await boundedInfrastructureWork(() => object.text(), runtime);
  if (!textRead.ok) return { status: "invalid", object };
  try { value = JSON.parse(textRead.value); } catch { return { status: "invalid", object }; }
  if (
    !isRecord(value) ||
    (object.key !== undefined && object.key !== key) ||
    (object.customMetadata?.state !== undefined &&
      object.customMetadata.state !== value.state) ||
    !exactReceiptPointerMatches(value, pointer) ||
    !exactReceiptTimestamp(value.updatedAt) ||
    !exactReceiptDetailsAreValid(value)
  ) {
    return { status: "invalid", object };
  }
  return {
    status: "valid",
    object,
    receipt: {
      state: value.state as ExactInboundReceipt["state"],
      ...(typeof value.errorCode === "string"
        ? { errorCode: value.errorCode }
        : {}),
      ...(value.providerAccepted === true
        ? { providerAccepted: true as const }
        : {}),
      ...(value.rejectionOrigin === "smtp_ingress"
        ? { rejectionOrigin: "smtp_ingress" as const }
        : {}),
    },
  };
}

function exactReceiptIsSuppression(receipt: ExactInboundReceipt): boolean {
  const requirement = inboundTerminalAuthorityRequirement(
    receipt as Record<string, unknown>,
  );
  return (
    requirement === "smtp_rejected" ||
    requirement === "raw_integrity_mismatch"
  );
}

function emergencyReasonForReceipt(
  receipt: ExactInboundReceipt,
): EmergencyForwardReason {
  switch (receipt.errorCode) {
    case "EMAXLEN":
    case "MIME_CHARSET_UNSUPPORTED":
    case "MIME_HEADER_SIZE_EXCEEDED":
    case "MIME_MULTIPART_BOUNDARY_INVALID":
    case "MIME_MULTIPART_BOUNDARY_MISSING":
    case "MIME_PARSE_FAILED":
    case "MIME_ROOT_HEADER_MISSING":
      return receipt.errorCode;
    default:
      return "QUEUE_RETRY_EXHAUSTED";
  }
}

async function exactTerminalReceiptIsAuthoritative(
  receipt: ExactInboundReceipt,
  env: Pick<InboundProjectionEnvironment, "MAILBOX" | "RAW_MAIL_BUCKET">,
  pointer: InboundArchivePointer,
  runtime: InboundProjectionRuntime,
): Promise<boolean> {
  const requirement = inboundTerminalAuthorityRequirement(
    receipt as Record<string, unknown>,
  );
  if (
    requirement === "provider_accepted" ||
    requirement === "smtp_rejected"
  ) {
    return true;
  }
  if (requirement === "raw_integrity_mismatch") {
    const raw = await boundedInfrastructureWork(
      () => env.RAW_MAIL_BUCKET.get(pointer.rawKey),
      runtime,
    );
    return Boolean(
      raw.ok &&
        raw.value &&
        !inboundRawArchiveMatchesPointer(raw.value, pointer),
    );
  }
  if (
    requirement !== "stored_projection" &&
    requirement !== "deleted_projection"
  ) {
    return false;
  }
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const archiveAuthority =
    pointer.rawSha256 === undefined
      ? null
      : {
          ...projectInboundArchivePointer(pointer),
          rawSha256: pointer.rawSha256,
        };
  const deletedRead =
    archiveAuthority && mailbox.getInboundDeletionAuthority
    ? await boundedInfrastructureWork(
        () => mailbox.getInboundDeletionAuthority!(archiveAuthority),
        runtime,
      )
    : { ok: true as const, value: null };
  if (!deletedRead.ok) return false;
  const deleted = Boolean(deletedRead.value);
  if (requirement === "deleted_projection") return deleted;
  if (deleted) return false;
  const projectionRead =
    archiveAuthority && mailbox.getInboundProjectionAuthority
      ? await boundedInfrastructureWork(
          () => mailbox.getInboundProjectionAuthority!(archiveAuthority),
          runtime,
        )
      : { ok: true as const, value: null };
  if (
    !projectionRead.ok ||
    !projectionRead.value ||
    projectionRead.value.generation !== 1
  ) {
    return false;
  }
  const stored = await boundedInfrastructureWork(
    () => emailExists(mailbox, pointer.ingressId),
    runtime,
  );
  return stored.ok && Boolean(stored.value);
}

async function exactMailboxProjectionTruth(
  mailbox: EmailStorageDependencies["mailbox"],
  pointer: InboundArchivePointer,
  runtime: InboundProjectionRuntime,
): Promise<"deleted" | "stored" | null> {
  if (pointer.rawSha256 === undefined) return null;
  const authority = {
    ...projectInboundArchivePointer(pointer),
    rawSha256: pointer.rawSha256,
  };
  if (mailbox.getInboundDeletionAuthority) {
    const deleted = await requireBoundedInfrastructureWork(
      () => mailbox.getInboundDeletionAuthority!(authority),
      runtime,
    );
    if (deleted) return "deleted";
  }
  if (!mailbox.getInboundProjectionAuthority) return null;
  const projected = await requireBoundedInfrastructureWork(
    () => mailbox.getInboundProjectionAuthority!(authority),
    runtime,
  );
  return projected?.generation === 1 ? "stored" : null;
}

async function writeReceipt(
  bucket: InboundReceiptBucket,
  pointer: InboundArchivePointer,
  state:
    | "stored"
    | "deleted"
    | "retrying"
    | "dead_letter_pending"
    | "dead_lettered"
    | "quarantined"
    | "rejected",
  runtime: InboundProjectionRuntime,
  details: InboundReceiptDetails = {},
): Promise<ExactInboundReceiptRead> {
  const key = receiptKey(pointer.ingressId);
  const current = await readExactInboundReceipt(bucket, pointer, runtime);
  const currentState =
    current.status === "valid" ? current.receipt.state : undefined;
  if (
    currentState &&
    currentState !== state &&
    ((isTerminalReceiptState(currentState) &&
      !(currentState === "stored" && state === "deleted")) ||
      (currentState === "dead_letter_pending" && state === "retrying"))
  ) {
    return current;
  }

  const currentObject = current.status === "absent" ? undefined : current.object;
  if (
    currentObject &&
    (typeof currentObject.etag !== "string" ||
      currentObject.etag.trim().length === 0)
  ) {
    return current;
  }

  await requireBoundedInfrastructureWork(
    () =>
      bucket.put(
        key,
        JSON.stringify({
          ...projectInboundArchivePointer(pointer),
          state,
          updatedAt: runtime.now().toISOString(),
          ...projectInboundReceiptDetails(details),
        }),
        {
          customMetadata: { state },
          httpMetadata: { contentType: "application/json" },
          onlyIf: currentObject
            ? { etagMatches: currentObject.etag }
            : { etagDoesNotMatch: "*" },
        },
      ),
    runtime,
  );
  return readExactInboundReceipt(bucket, pointer, runtime);
}

async function writeReceiptBestEffort(
  bucket: InboundReceiptBucket,
  pointer: InboundArchivePointer,
  state: "stored",
  runtime: InboundProjectionRuntime,
  message: QueueMessage,
): Promise<void> {
  const startedAt = runtime.now().getTime();
  const { ingressRef, queueRef } = await projectionTelemetryRefs(
    pointer,
    message.id,
  );
  try {
    const result = await writeReceipt(bucket, pointer, state, runtime);
    const written =
      result.status === "valid" && result.receipt.state === state;
    console.log(
      "[mail-projection] receipt state write completed",
      {
        attempt: message.attempts,
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        operation: "receipt_write",
        queueRef,
        status: written ? "succeeded" : "superseded",
        target: "r2",
      },
    );
  } catch {
    console.error("[mail-projection] receipt write degraded", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, startedAt),
      errorCode: "RECEIPT_WRITE_FAILED",
      ingressRef,
      operation: "receipt_write",
      queueRef,
      status: "degraded",
    });
  }
}

async function finalizeExactTerminalReceipt(
  message: QueueMessage,
  pointer: InboundArchivePointer,
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime,
  state: "deleted" | "quarantined" | "rejected" | "stored",
  details: InboundReceiptDetails = {},
): Promise<boolean> {
  try {
    const winner = await writeReceipt(
      env.RAW_MAIL_BUCKET,
      pointer,
      state,
      runtime,
      details,
    );
    if (
      winner.status === "valid" &&
      (winner.receipt.state === "stored" ||
        winner.receipt.state === "deleted" ||
        winner.receipt.state === "forwarded" ||
        exactReceiptIsSuppression(winner.receipt)) &&
      (await exactTerminalReceiptIsAuthoritative(
          winner.receipt,
          env,
          pointer,
          runtime,
        ))
    ) {
      await clearTerminalActiveMarkerBestEffort(
        env.RAW_MAIL_BUCKET,
        pointer,
        runtime,
      );
      message.ack();
      return true;
    }
  } catch {
    // The Queue delivery remains the authority until an exact terminal receipt wins.
  }
  await handOffToEmergencyForward(
    message,
    pointer,
    env,
    runtime,
    "QUEUE_RETRY_EXHAUSTED",
  );
  return false;
}

function retryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.max(1, attempt));
}

async function scheduleRetry(
  message: QueueMessage,
  pointer: InboundArchivePointer,
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime,
  errorCode: InboundRetryErrorCode,
  operation:
    | "mailbox_idempotency_check"
    | "mailbox_projection"
    | "mailbox_projection_admission"
    | "mailbox_resolution"
    | "raw_archive_read",
  startedAt: number,
): Promise<void> {
  // Recovery authority must precede telemetry and non-authoritative evidence.
  // A retrying receipt write could hang before the emergency handoff or
  // overwrite its forward_pending state, so scheduled retries never mutate
  // receipt authority outside beginEmergencyForward.
  const authorityDurable = await handOffToEmergencyForward(
    message,
    pointer,
    env,
    runtime,
    "QUEUE_RETRY_EXHAUSTED",
  );
  const { ingressRef, objectRef, queueRef } =
    await projectionTelemetryRefs(pointer, message.id);
  const delaySeconds = authorityDurable
    ? INBOUND_ISOLATED_RETRY_SECONDS
    : INBOUND_RECOVERY_RETRY_SECONDS;
  console.error(
    "[mail-projection] retry disposition scheduled",
    {
      attempt: message.attempts,
      delaySeconds,
      durationMs: durationMs(runtime, startedAt),
      errorCode,
      ingressRef,
      objectRef,
      operation,
      queueRef,
      status: authorityDurable ? "forward_pending" : "retrying",
    },
  );
}

export async function processInboundMessage(
  message: QueueMessage,
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  const pointer = message.body;
  const projectionStartedAt = runtime.now().getTime();
  const { ingressRef, objectRef, queueRef } =
    await projectionTelemetryRefs(pointer, message.id);
  try {
    const current = await readExactInboundReceipt(
      env.RAW_MAIL_BUCKET,
      pointer,
      runtime,
    );
    if (current.status !== "valid") {
      console.error("[mail-projection] receipt authority unavailable", {
        attempt: message.attempts,
        errorCode:
          current.status === "absent"
            ? "RECEIPT_STATE_UNAVAILABLE"
            : "RECEIPT_STATE_UNKNOWN",
        ingressRef,
        operation: "queue_terminal_check",
        queueRef,
        status: "verifying_mailbox_truth",
      });
      await handOffToEmergencyForward(
        message,
        pointer,
        env,
        runtime,
        "QUEUE_RETRY_EXHAUSTED",
      );
      return;
    } else {
      const currentState = current.receipt.state;
      if (
        currentState === "stored" ||
        currentState === "deleted" ||
        currentState === "forwarded" ||
        exactReceiptIsSuppression(current.receipt)
      ) {
        if (
          !(await exactTerminalReceiptIsAuthoritative(
            current.receipt,
            env,
            pointer,
            runtime,
          ))
        ) {
          console.error("[mail-projection] terminal receipt lacks authority", {
            attempt: message.attempts,
            errorCode: "TERMINAL_RECEIPT_TRUTH_MISMATCH",
            ingressRef,
            operation: "queue_terminal_check",
            queueRef,
            status: "retrying",
          });
          // A stale sidecar cannot terminate the Queue delivery. Continue to
          // live Mailbox checks and either repair projection truth or forward.
        } else {
          await clearTerminalActiveMarkerBestEffort(
            env.RAW_MAIL_BUCKET,
            pointer,
            runtime,
          );
          console.log("[mail-projection] terminal delivery acknowledged", {
            attempt: message.attempts,
            durationMs: durationMs(runtime, projectionStartedAt),
            ingressRef,
            operation: "queue_terminal_check",
            queueRef,
            status: "terminal",
          });
          message.ack();
          return;
        }
      } else if (currentState === "forward_pending") {
        await handOffToEmergencyForward(
          message,
          pointer,
          env,
          runtime,
          emergencyReasonForReceipt(current.receipt),
        );
        return;
      } else if (
        currentState === "dead_lettered" ||
        (currentState === "quarantined" &&
          !exactReceiptIsSuppression(current.receipt))
      ) {
        await handOffToEmergencyForward(
          message,
          pointer,
          env,
          runtime,
          currentState === "dead_lettered"
            ? "QUEUE_RETRY_EXHAUSTED"
            : (current.receipt.errorCode as EmergencyForwardReason),
        );
        return;
      } else if (currentState === "dead_letter_pending") {
        await handOffToEmergencyForward(
          message,
          pointer,
          env,
          runtime,
          "QUEUE_RETRY_EXHAUSTED",
        );
        return;
      }
    }
  } catch (error) {
    console.error("[mail-projection] terminal receipt check degraded", {
      attempt: message.attempts,
      errorCode: "TERMINAL_RECEIPT_CHECK_FAILED",
      ingressRef,
      operation: "queue_terminal_check",
      queueRef,
      status: "degraded",
    });
    throw error;
  }
  const mailboxLookupStartedAt = runtime.now().getTime();
  let mailboxMarker: unknown | null;
  try {
    mailboxMarker = await requireBoundedInfrastructureWork(
      () =>
        env.BUCKET.head(
          `mailboxes/${pointer.mailboxId}.json`,
        ),
      runtime,
    );
  } catch {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "MAILBOX_MARKER_READ_FAILED",
      "mailbox_resolution",
      mailboxLookupStartedAt,
    );
    return;
  }
  console.log("[mail-projection] mailbox marker read completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, mailboxLookupStartedAt),
    found: Boolean(mailboxMarker),
    ingressRef,
    operation: "mailbox_resolution",
    queueRef,
    status: mailboxMarker ? "hit" : "miss",
    target: "r2",
  });
  if (!mailboxMarker) {
    await handOffToEmergencyForward(
      message,
      pointer,
      env,
      runtime,
      "QUEUE_RETRY_EXHAUSTED",
    );
    return;
  }

  let mailboxActive: boolean;
  try {
    mailboxActive = await requireBoundedInfrastructureWork(
      () => isActiveMailbox(env, pointer.mailboxId),
      runtime,
    );
  } catch {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "MAILBOX_ACTIVE_CHECK_FAILED",
      "mailbox_resolution",
      mailboxLookupStartedAt,
    );
    return;
  }
  if (!mailboxActive) {
    await handOffToEmergencyForward(
      message,
      pointer,
      env,
      runtime,
      "QUEUE_RETRY_EXHAUSTED",
    );
    console.log("[mail-projection] inactive mailbox delivery forwarded", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, mailboxLookupStartedAt),
      errorCode: "MAILBOX_INACTIVE",
      ingressRef,
      operation: "mailbox_resolution",
      queueRef,
      status: "forward_pending",
    });
    return;
  }

  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const idempotencyStartedAt = runtime.now().getTime();
  let existingEmail: unknown | null;
  let mailboxTruth: "deleted" | "stored" | null;
  try {
    mailboxTruth = await exactMailboxProjectionTruth(mailbox, pointer, runtime);
    existingEmail = await requireBoundedInfrastructureWork(
      () => emailExists(mailbox, pointer.ingressId),
      runtime,
    );
  } catch {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "IDEMPOTENCY_CHECK_FAILED",
      "mailbox_idempotency_check",
      idempotencyStartedAt,
    );
    return;
  }
  console.log("[mail-projection] idempotency check completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, idempotencyStartedAt),
    found: Boolean(existingEmail),
    ingressRef,
    operation: "mailbox_idempotency_check",
    queueRef,
    status: existingEmail ? "hit" : "miss",
    target: "durable_object",
  });
  if (mailboxTruth === "deleted") {
    const receiptStartedAt = runtime.now().getTime();
    const finalized = await finalizeExactTerminalReceipt(
      message,
      pointer,
      env,
      runtime,
      "deleted",
      { errorCode: "MAILBOX_PROJECTION_DELETED" },
    );
    console.log("[mail-projection] deleted projection remains suppressed", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, projectionStartedAt),
      ingressRef,
      operation: "mailbox_projection",
      queueRef,
      status: "deleted",
    });
    if (!finalized) return;
    return;
  }
  if (existingEmail) {
    if (mailboxTruth !== "stored") {
      await handOffToEmergencyForward(
        message,
        pointer,
        env,
        runtime,
        "QUEUE_RETRY_EXHAUSTED",
      );
      console.error("[mail-projection] unrelated existing identity forwarded", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, idempotencyStartedAt),
        errorCode: "MAILBOX_IDENTITY_CONFLICT",
        ingressRef,
        operation: "mailbox_idempotency_check",
        queueRef,
        status: "forward_pending",
      });
      return;
    }
    const finalized = await finalizeExactTerminalReceipt(
      message,
      pointer,
      env,
      runtime,
      "stored",
      {},
    );
    console.log("[mail-projection] duplicate acknowledged", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, projectionStartedAt),
      ingressRef,
      operation: "mailbox_projection",
      queueRef,
      status: "duplicate",
    });
    if (!finalized) return;
    return;
  }

  let raw: ArchivedEmailObject | null;
  const rawReadStartedAt = runtime.now().getTime();
  try {
    raw = await requireBoundedInfrastructureWork(
      () => env.RAW_MAIL_BUCKET.get(pointer.rawKey),
      runtime,
    );
    if (!raw) throw new Error("Archived email object was not found");
  } catch {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "RAW_ARCHIVE_READ_FAILED",
      "raw_archive_read",
      rawReadStartedAt,
    );
    return;
  }
  console.log("[mail-projection] raw archive read completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, rawReadStartedAt),
    ingressRef,
    objectRef,
    operation: "raw_archive_read",
    queueRef,
    status: "succeeded",
    target: "r2",
  });
  if (!inboundRawArchiveMatchesPointer(raw, pointer)) {
    const receiptStartedAt = runtime.now().getTime();
    const finalized = await finalizeExactTerminalReceipt(
      message,
      pointer,
      env,
      runtime,
      "quarantined",
      { errorCode: "RAW_ARCHIVE_INTEGRITY_MISMATCH" },
    );
    console.error("[mail-projection] quarantined", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, receiptStartedAt),
      errorCode: "RAW_ARCHIVE_INTEGRITY_MISMATCH",
      ingressRef,
      objectRef,
      operation: "raw_archive_verify",
      queueRef,
      status: "quarantined",
    });
    if (!finalized) return;
    return;
  }

  try {
    mailboxActive = await requireBoundedInfrastructureWork(
      () => isActiveMailbox(env, pointer.mailboxId),
      runtime,
    );
  } catch {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "MAILBOX_ACTIVE_RECHECK_FAILED",
      "mailbox_projection_admission",
      rawReadStartedAt,
    );
    return;
  }
  if (!mailboxActive) {
    await handOffToEmergencyForward(
      message,
      pointer,
      env,
      runtime,
      "QUEUE_RETRY_EXHAUSTED",
    );
    console.log("[mail-projection] deactivated mailbox delivery forwarded", {
      attempt: message.attempts,
      errorCode: "MAILBOX_INACTIVE",
      ingressRef,
      operation: "mailbox_projection_admission",
      queueRef,
      status: "forward_pending",
    });
    return;
  }

  let parsed: Email | undefined;
  const parseStartedAt = runtime.now().getTime();
  const mailboxProjectionStartedAt = runtime.now().getTime();
  try {
    // Test seam only. Production omits parse so normal delivery uses the streamed path.
    if (runtime.parse) {
      try {
        parsed = await runtime.parse(raw.body);
      } catch {
        await handOffToEmergencyForward(
          message,
          pointer,
          env,
          runtime,
          "MIME_PARSE_FAILED",
        );
        console.error("[mail-projection] emergency forward pending", {
          attempt: message.attempts,
          durationMs: durationMs(runtime, parseStartedAt),
          errorCode: "MIME_PARSE_FAILED",
          ingressRef,
          objectRef,
          operation: "mime_parse",
          queueRef,
          status: "forward_pending",
        });
        return;
      }
      await storeParsedEmail(
        { bucket: env.BUCKET, mailbox },
        parsed,
        liveInboundProjectionOptions({
          brand: env.BRAND,
          mailboxId: pointer.mailboxId,
          messageId: pointer.ingressId,
          date: pointer.archivedAt,
          projectionExpiresAt: runtime.projectionExpiresAt,
          ...(pointer.rawSha256 === undefined
            ? {}
            : {
                archiveAuthority: {
                  ...projectInboundArchivePointer(pointer),
                  rawSha256: pointer.rawSha256,
                },
              }),
        }),
      );
    } else {
      parsed = await storeStreamingEmail(
        { bucket: env.BUCKET, mailbox },
        raw.body,
        liveInboundProjectionOptions({
          brand: env.BRAND,
          mailboxId: pointer.mailboxId,
          messageId: pointer.ingressId,
          date: pointer.archivedAt,
          projectionExpiresAt: runtime.projectionExpiresAt,
          ...(pointer.rawSha256 === undefined
            ? {}
            : {
                archiveAuthority: {
                  ...projectInboundArchivePointer(pointer),
                  rawSha256: pointer.rawSha256,
                },
              }),
        }),
        env.RAW_MAIL_BUCKET,
      );
    }
  } catch (error) {
    if (isEmailTerminalDuringProjection(error)) {
      await handOffToEmergencyForward(
        message,
        pointer,
        env,
        runtime,
        "QUEUE_RETRY_EXHAUSTED",
      );
      console.log("[mail-projection] terminal ledger won projection race", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, mailboxProjectionStartedAt),
        ingressRef,
        operation: "mailbox_projection",
        queueRef,
        status: "forward_pending",
      });
      return;
    }
    if (isEmailDeletedDuringProjection(error)) {
      const deletionAuthority =
        pointer.rawSha256 !== undefined &&
        mailbox.getInboundDeletionAuthority
          ? await boundedInfrastructureWork(
              () =>
                mailbox.getInboundDeletionAuthority!({
                  ...projectInboundArchivePointer(pointer),
                  rawSha256: pointer.rawSha256!,
                }),
              runtime,
            )
          : { ok: true as const, value: null };
      if (!deletionAuthority.ok || !deletionAuthority.value) {
        await handOffToEmergencyForward(
          message,
          pointer,
          env,
          runtime,
          "QUEUE_RETRY_EXHAUSTED",
        );
        return;
      }
      const finalized = await finalizeExactTerminalReceipt(
        message,
        pointer,
        env,
        runtime,
        "deleted",
        { errorCode: "MAILBOX_PROJECTION_DELETED" },
      );
      console.log("[mail-projection] concurrent deletion remained terminal", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, mailboxProjectionStartedAt),
        ingressRef,
        operation: "mailbox_projection",
        queueRef,
        status: "deleted",
      });
      if (!finalized) return;
      return;
    }
    if (isPermanentMimeProjectionError(error)) {
      const permanentErrorCode =
        permanentMimeProjectionErrorCode(error) ?? "MIME_PARSE_FAILED";
      await handOffToEmergencyForward(
        message,
        pointer,
        env,
        runtime,
        permanentErrorCode as EmergencyForwardReason,
      );
      console.error("[mail-projection] emergency forward pending", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, parseStartedAt),
        errorCode: permanentErrorCode,
        ingressRef,
        objectRef,
        operation: "mime_parse",
        queueRef,
        status: "forward_pending",
      });
      return;
    }
    let ambiguousTruth: "deleted" | "stored" | null = null;
    try {
      ambiguousTruth = await exactMailboxProjectionTruth(
        mailbox,
        pointer,
        runtime,
      );
    } catch {
      // An unavailable exact authority read cannot prove a commit.
    }
    if (ambiguousTruth === "deleted") {
      const finalized = await finalizeExactTerminalReceipt(
        message,
        pointer,
        env,
        runtime,
        "deleted",
        { errorCode: "MAILBOX_PROJECTION_DELETED" },
      );
      if (!finalized) return;
      console.log("[mail-projection] ambiguous deletion recovered", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, mailboxProjectionStartedAt),
        ingressRef,
        operation: "mailbox_projection",
        queueRef,
        status: "deleted",
      });
      return;
    }
    if (ambiguousTruth !== "stored") {
      await scheduleRetry(
        message,
        pointer,
        env,
        runtime,
        "MAILBOX_PROJECTION_FAILED",
        "mailbox_projection",
        mailboxProjectionStartedAt,
      );
      return;
    }
    console.log("[mail-projection] ambiguous commit recovered", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, mailboxProjectionStartedAt),
      ingressRef,
      operation: "mailbox_projection",
      queueRef,
      status: "recovered",
    });
  }
  console.log("[mail-projection] MIME parse completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, parseStartedAt),
    ingressRef,
    operation: "mime_parse",
    queueRef,
    status: "succeeded",
  });
  console.log("[mail-projection] Mailbox projection completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, mailboxProjectionStartedAt),
    ingressRef,
    operation: "mailbox_projection",
    queueRef,
    status: "succeeded",
    target: "durable_object",
  });

  const finalized = await finalizeExactTerminalReceipt(
    message,
    pointer,
    env,
    runtime,
    "stored",
    {},
  );
  if (!finalized) return;
  console.log("[mail-projection] message acknowledged", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, projectionStartedAt),
    ingressRef,
    operation: "mailbox_projection",
    queueRef,
    status: "succeeded",
  });
}

async function processInboundQueueItem(
  message: UntrustedQueueMessage,
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime,
): Promise<void> {
  const queueRef = await bestEffortMailTelemetryLogRef("queue", message.id);
  console.log("[mail-projection] Queue message received", {
    attempt: message.attempts,
    operation: "queue_consume",
    queueRef,
    status: "started",
  });
  if (!isInboundArchivePointer(message.body)) {
    const durableQueueRef = await mailTelemetryRef("queue", message.id);
    await persistInvalidPointer(
      env.RAW_MAIL_BUCKET,
      message,
      durableQueueRef,
      "INVALID_QUEUE_POINTER",
      runtime,
    );
    console.error("[mail-projection] invalid Queue pointer", {
      attempt: message.attempts,
      errorCode: "INVALID_QUEUE_POINTER",
      operation: "queue_pointer_validate",
      queueRef,
      status: "quarantined",
    });
    message.ack();
    return;
  }

  await processInboundMessage(
    {
      id: message.id,
      timestamp: message.timestamp,
      body: message.body,
      attempts: message.attempts,
      ack: () => message.ack(),
      retry: (options) => message.retry(options),
    },
    env,
    runtime,
  );
}

async function recoverNormalQueueDelivery(
  message: UntrustedQueueMessage,
  pointer: InboundArchivePointer,
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime,
  disposition: InboundQueueDisposition,
): Promise<void> {
  const authorityDurable = await establishEmergencyForwardAuthority(
    env,
    pointer,
    "QUEUE_RETRY_EXHAUSTED",
    runtime,
  );
  if (!authorityDurable) {
    await bestEffortDeadLetterTerminalLedger(message, pointer, env, runtime);
  }
  disposition.retry({
    delaySeconds: authorityDurable
      ? INBOUND_ISOLATED_RETRY_SECONDS
      : INBOUND_RECOVERY_RETRY_SECONDS,
  });
}

export async function processInboundBatch(
  batch: { messages: readonly UntrustedQueueMessage[] },
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const disposition = createQueueDisposition(message);
      const attempt = disposition.createScope();
      const scopedMessage: UntrustedQueueMessage = {
        ...message,
        ack: () => {
          attempt.ack();
        },
        retry: (options) => {
          attempt.retry(options);
        },
      };
      const result = await runInboundWorkWithDeadline(
        async ({ expiresAt }) =>
          processInboundQueueItem(scopedMessage, env, {
            ...runtime,
            projectionExpiresAt: expiresAt,
          }),
        {
          now: () => runtime.now().getTime(),
          onExpire: () => attempt.close(),
          scheduler: runtime.deadlineScheduler,
          timeoutMs: runtime.itemTimeoutMs ?? INBOUND_QUEUE_ITEM_TIMEOUT_MS,
        },
      );
      attempt.close();
      if (disposition.isSettled()) return;

      if (!isInboundArchivePointer(message.body)) {
        console.error("[mail-projection] invalid pointer ledger failed", {
          attempt: message.attempts,
          delaySeconds: INBOUND_RECOVERY_RETRY_SECONDS,
          errorCode: "INVALID_POINTER_LEDGER_FAILED",
          operation: "queue_pointer_validate",
          status: "retrying",
        });
        disposition.retry({
          delaySeconds: INBOUND_RECOVERY_RETRY_SECONDS,
        });
        return;
      }

      const { ingressRef, objectRef, queueRef } =
        await projectionTelemetryRefs(message.body, message.id);
      console.error("[mail-projection] bounded projection recovery started", {
        attempt: message.attempts,
        errorCode:
          result.status === "timed_out"
            ? "PROJECTION_DEADLINE_EXCEEDED"
            : "UNEXPECTED_PROJECTION_FAILURE",
        ingressRef,
        objectRef,
        operation: "mailbox_projection",
        queueRef,
        status: "recovering",
      });
      await recoverNormalQueueDelivery(
        message,
        message.body,
        env,
        runtime,
        disposition,
      );
    }),
  );
}

async function bestEffortDeadLetterTerminalLedger(
  message: UntrustedQueueMessage,
  pointer: InboundArchivePointer,
  env: Pick<InboundProjectionEnvironment, "MAILBOX">,
  runtime: InboundProjectionRuntime,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const bounded = async <T>(work: () => Promise<T>): Promise<T | null> => {
    try {
      return await Promise.race([
        Promise.resolve().then(work),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("DLQ terminal ledger timed out")),
            runtime.infrastructureTimeoutMs ?? 100,
          );
        }),
      ]);
    } catch {
      return null;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const durableQueueRef = await bounded(() =>
    mailTelemetryRef("queue", message.id),
  );
  if (!durableQueueRef || pointer.rawSha256 === undefined) return;
  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const recordTerminalFailure = mailbox.recordInboundTerminalFailure?.bind(mailbox);
  if (!recordTerminalFailure) return;
  await bounded(() =>
    recordTerminalFailure({
      id: pointer.ingressId,
      archiveAuthority: {
        ...projectInboundArchivePointer(pointer),
        rawSha256: pointer.rawSha256!,
      },
      queueRef: durableQueueRef,
      attempts: message.attempts,
      errorCode: "QUEUE_RETRY_EXHAUSTED",
    }),
  );
}

async function processInboundDeadLetterItem(
  message: UntrustedQueueMessage,
  env: Pick<
    InboundProjectionEnvironment,
    "RAW_MAIL_BUCKET" | "MAILBOX" | "EMERGENCY_FORWARD_QUEUE"
  >,
  runtime: InboundProjectionRuntime,
): Promise<void> {
  const queueRef = await bestEffortMailTelemetryLogRef("queue", message.id);
  if (!isInboundArchivePointer(message.body)) {
    const durableQueueRef = await mailTelemetryRef("queue", message.id);
    await persistInvalidPointer(
      env.RAW_MAIL_BUCKET,
      message,
      durableQueueRef,
      "INVALID_DLQ_POINTER",
      runtime,
    );
    console.error("[mail-projection] invalid dead-letter pointer", {
      attempt: message.attempts,
      errorCode: "INVALID_DLQ_POINTER",
      operation: "dead_letter_consume",
      queueRef,
      status: "quarantined",
    });
    message.ack();
    return;
  }

  const pointer = message.body;
  const { ingressRef, objectRef } = await projectionTelemetryRefs(
    pointer,
    message.id,
  );
  await beginEmergencyForward(
    env,
    pointer,
    "QUEUE_RETRY_EXHAUSTED",
    runtime,
  );
  message.ack();
  await bestEffortDeadLetterTerminalLedger(
    message,
    pointer,
    env,
    runtime,
  );
  console.error("[mail-projection] emergency forward handoff completed", {
    attempt: message.attempts,
    ingressRef,
    objectRef,
    operation: "dead_letter_consume",
    queueRef,
    status: "forward_pending",
  });
}

export async function processInboundDeadLetterBatch(
  batch: { messages: readonly UntrustedQueueMessage[] },
  env: Pick<
    InboundProjectionEnvironment,
    "RAW_MAIL_BUCKET" | "MAILBOX" | "EMERGENCY_FORWARD_QUEUE"
  >,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      const disposition = createQueueDisposition(message);
      const attempt = disposition.createScope();
      const scopedMessage: UntrustedQueueMessage = {
        ...message,
        ack: () => {
          attempt.ack();
        },
        retry: (options) => {
          attempt.retry(options);
        },
      };
      await runInboundWorkWithDeadline(
        async () => processInboundDeadLetterItem(scopedMessage, env, runtime),
        {
          now: () => runtime.now().getTime(),
          onExpire: () => attempt.close(),
          scheduler: runtime.deadlineScheduler,
          timeoutMs:
            runtime.deadLetterItemTimeoutMs ?? INBOUND_DLQ_ITEM_TIMEOUT_MS,
        },
      );
      attempt.close();
      if (disposition.isSettled()) return;

      if (!isInboundArchivePointer(message.body)) {
        console.error("[mail-projection] invalid DLQ pointer ledger failed", {
          attempt: message.attempts,
          errorCode: "INVALID_DLQ_POINTER_LEDGER_FAILED",
          operation: "dead_letter_consume",
          status: "retrying",
        });
        disposition.retry({
          delaySeconds: INBOUND_RECOVERY_RETRY_SECONDS,
        });
        return;
      }

      const authorityDurable = await establishEmergencyForwardAuthority(
        env,
        message.body,
        "QUEUE_RETRY_EXHAUSTED",
        runtime,
      );
      await bestEffortDeadLetterTerminalLedger(
        message,
        message.body,
        env,
        runtime,
      );
      if (authorityDurable) {
        disposition.ack();
      } else {
        disposition.retry({
          delaySeconds: INBOUND_RECOVERY_RETRY_SECONDS,
        });
      }
    }),
  );
}
