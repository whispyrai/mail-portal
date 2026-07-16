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
import { arrayBufferToHex, isSha256Hex } from "./lib/checksum.ts";
import {
  mailTelemetryLogRef,
  mailTelemetryRef,
} from "./lib/mail-telemetry.ts";

export const INBOUND_MAX_RETRIES = 10;

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
    mailTelemetryLogRef("ingress", pointer.ingressId),
    mailTelemetryLogRef("object", pointer.rawKey),
    mailTelemetryLogRef("queue", queueMessageId),
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
    state === "quarantined" ||
    state === "rejected" ||
    state === "dead_lettered"
  );
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
    new RegExp(`^raw/\\d{4}/\\d{2}/\\d{2}/${ingressId}\\.eml$`).test(rawKey) &&
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
): Promise<boolean> {
  const key = receiptKey(pointer.ingressId);
  const current = bucket.head ? await bucket.head(key) : null;
  const currentState = current?.customMetadata?.state;
  if (
    currentState &&
    currentState !== state &&
    ((isTerminalReceiptState(currentState) &&
      !(currentState === "stored" && state === "deleted")) ||
      (currentState === "dead_letter_pending" && state === "retrying"))
  ) {
    return false;
  }

  const written = await bucket.put(
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
      onlyIf: current
        ? { etagMatches: current.etag }
        : { etagDoesNotMatch: "*" },
    },
  );
  return written !== null;
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
    const written = await writeReceipt(bucket, pointer, state, runtime);
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
  const { ingressRef, objectRef, queueRef } =
    await projectionTelemetryRefs(pointer, message.id);
  const delaySeconds = retryDelaySeconds(message.attempts);
  const isFinalAttempt = message.attempts >= INBOUND_MAX_RETRIES + 1;
  const state = isFinalAttempt ? "dead_letter_pending" : "retrying";
  await writeReceipt(env.RAW_MAIL_BUCKET, pointer, state, runtime, {
    attempt: message.attempts,
    delaySeconds,
    errorCode,
  });
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
      status: state,
    },
  );
  message.retry({ delaySeconds });
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
  if (env.RAW_MAIL_BUCKET.head) {
    try {
      const currentReceipt = await env.RAW_MAIL_BUCKET.head(
        receiptKey(pointer.ingressId),
      );
      const currentState = currentReceipt?.customMetadata?.state;
      if (!currentState) {
        const delaySeconds = retryDelaySeconds(message.attempts);
        console.error("[mail-projection] receipt unavailable", {
          attempt: message.attempts,
          delaySeconds,
          errorCode: "RECEIPT_STATE_UNAVAILABLE",
          ingressRef,
          operation: "queue_terminal_check",
          queueRef,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        return;
      }
      if (isTerminalReceiptState(currentState)) {
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
      if (currentState === "dead_letter_pending") {
        console.log("[mail-projection] pending DLQ delivery acknowledged", {
          attempt: message.attempts,
          ingressRef,
          operation: "queue_terminal_check",
          queueRef,
          status: "terminalizing",
        });
        message.ack();
        return;
      }
      if (
        currentState !== "admitted" &&
        currentState !== "enqueued" &&
        currentState !== "retrying" &&
        currentState !== "archived"
      ) {
        const delaySeconds = retryDelaySeconds(message.attempts);
        console.error("[mail-projection] unknown receipt state", {
          attempt: message.attempts,
          delaySeconds,
          errorCode: "RECEIPT_STATE_UNKNOWN",
          ingressRef,
          operation: "queue_terminal_check",
          queueRef,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        return;
      }
    } catch {
      console.error("[mail-projection] terminal receipt check degraded", {
        attempt: message.attempts,
        errorCode: "TERMINAL_RECEIPT_CHECK_FAILED",
        ingressRef,
        operation: "queue_terminal_check",
        queueRef,
        status: "degraded",
      });
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      return;
    }
  }
  const mailboxLookupStartedAt = runtime.now().getTime();
  let mailboxMarker: unknown | null;
  try {
    mailboxMarker = await env.BUCKET.head(
      `mailboxes/${pointer.mailboxId}.json`,
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
    const receiptStartedAt = runtime.now().getTime();
    await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "quarantined", runtime, {
      errorCode: "MAILBOX_UNAVAILABLE",
    });
    console.error("[mail-projection] quarantined", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, receiptStartedAt),
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressRef,
      objectRef,
      operation: "mailbox_resolution",
      queueRef,
      status: "quarantined",
    });
    message.ack();
    return;
  }

  let mailboxActive: boolean;
  try {
    mailboxActive = await isActiveMailbox(env, pointer.mailboxId);
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
    await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "rejected", runtime, {
      errorCode: "MAILBOX_INACTIVE",
    });
    console.log("[mail-projection] inactive mailbox delivery rejected", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, mailboxLookupStartedAt),
      errorCode: "MAILBOX_INACTIVE",
      ingressRef,
      operation: "mailbox_resolution",
      queueRef,
      status: "rejected",
    });
    message.ack();
    return;
  }

  const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(pointer.mailboxId));
  const idempotencyStartedAt = runtime.now().getTime();
  let existingEmail: unknown | null;
  let wasDeleted = false;
  try {
    wasDeleted = mailbox.isEmailDeleted
      ? await mailbox.isEmailDeleted(pointer.ingressId)
      : false;
    existingEmail = await emailExists(mailbox, pointer.ingressId);
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
  if (wasDeleted) {
    const receiptStartedAt = runtime.now().getTime();
    try {
      const written = await writeReceipt(
        env.RAW_MAIL_BUCKET,
        pointer,
        "deleted",
        runtime,
        { errorCode: "MAILBOX_PROJECTION_DELETED" },
      );
      console.log("[mail-projection] deletion receipt finalized", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, receiptStartedAt),
        ingressRef,
        operation: "receipt_write",
        queueRef,
        status: written ? "succeeded" : "superseded",
        target: "r2",
      });
    } catch {
      console.error("[mail-projection] deletion receipt write degraded", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, receiptStartedAt),
        errorCode: "DELETION_RECEIPT_WRITE_FAILED",
        ingressRef,
        operation: "receipt_write",
        queueRef,
        status: "degraded",
      });
    }
    console.log("[mail-projection] deleted projection remains suppressed", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, projectionStartedAt),
      ingressRef,
      operation: "mailbox_projection",
      queueRef,
      status: "deleted",
    });
    message.ack();
    return;
  }
  if (existingEmail) {
    await writeReceiptBestEffort(
      env.RAW_MAIL_BUCKET,
      pointer,
      "stored",
      runtime,
      message,
    );
    console.log("[mail-projection] duplicate acknowledged", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, projectionStartedAt),
      ingressRef,
      operation: "mailbox_projection",
      queueRef,
      status: "duplicate",
    });
    message.ack();
    return;
  }

  let raw: ArchivedEmailObject | null;
  const rawReadStartedAt = runtime.now().getTime();
  try {
    raw = await env.RAW_MAIL_BUCKET.get(pointer.rawKey);
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
  if (
    raw.key !== pointer.rawKey ||
    raw.size !== pointer.rawSize ||
    raw.etag !== pointer.etag ||
    raw.version !== pointer.version ||
    raw.customMetadata?.schemaVersion !== String(pointer.schemaVersion) ||
    raw.customMetadata?.ingressId !== pointer.ingressId ||
    raw.customMetadata?.mailboxId !== pointer.mailboxId ||
    raw.customMetadata?.rawSize !== String(pointer.rawSize) ||
    raw.customMetadata?.archivedAt !== pointer.archivedAt ||
    (pointer.rawSha256 !== undefined &&
      (raw.customMetadata?.rawSha256 !== pointer.rawSha256 ||
        !raw.checksums?.sha256 ||
        arrayBufferToHex(raw.checksums.sha256) !== pointer.rawSha256))
  ) {
    const receiptStartedAt = runtime.now().getTime();
    await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "quarantined", runtime, {
      errorCode: "RAW_ARCHIVE_INTEGRITY_MISMATCH",
    });
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
    message.ack();
    return;
  }

  try {
    mailboxActive = await isActiveMailbox(env, pointer.mailboxId);
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
    await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "rejected", runtime, {
      errorCode: "MAILBOX_INACTIVE",
    });
    console.log("[mail-projection] deactivated mailbox projection suppressed", {
      attempt: message.attempts,
      errorCode: "MAILBOX_INACTIVE",
      ingressRef,
      operation: "mailbox_projection_admission",
      queueRef,
      status: "rejected",
    });
    message.ack();
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
        await writeReceipt(
          env.RAW_MAIL_BUCKET,
          pointer,
          "quarantined",
          runtime,
          {
            errorCode: "MIME_PARSE_FAILED",
          },
        );
        console.error("[mail-projection] quarantined", {
          attempt: message.attempts,
          durationMs: durationMs(runtime, parseStartedAt),
          errorCode: "MIME_PARSE_FAILED",
          ingressRef,
          objectRef,
          operation: "mime_parse",
          queueRef,
          status: "quarantined",
        });
        message.ack();
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
        }),
        env.RAW_MAIL_BUCKET,
      );
    }
  } catch (error) {
    if (isEmailTerminalDuringProjection(error)) {
      await writeReceipt(
        env.RAW_MAIL_BUCKET,
        pointer,
        "dead_lettered",
        runtime,
        {
          errorCode: "QUEUE_RETRY_EXHAUSTED",
        },
      );
      console.log("[mail-projection] terminal ledger won projection race", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, mailboxProjectionStartedAt),
        ingressRef,
        operation: "mailbox_projection",
        queueRef,
        status: "dead_lettered",
      });
      message.ack();
      return;
    }
    if (isEmailDeletedDuringProjection(error)) {
      await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "deleted", runtime, {
        errorCode: "MAILBOX_PROJECTION_DELETED",
      });
      console.log("[mail-projection] concurrent deletion remained terminal", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, mailboxProjectionStartedAt),
        ingressRef,
        operation: "mailbox_projection",
        queueRef,
        status: "deleted",
      });
      message.ack();
      return;
    }
    if (isPermanentMimeProjectionError(error)) {
      const permanentErrorCode =
        permanentMimeProjectionErrorCode(error) ?? "MIME_PARSE_FAILED";
      await writeReceipt(env.RAW_MAIL_BUCKET, pointer, "quarantined", runtime, {
        errorCode: permanentErrorCode,
      });
      console.error("[mail-projection] quarantined", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, parseStartedAt),
        errorCode: permanentErrorCode,
        ingressRef,
        objectRef,
        operation: "mime_parse",
        queueRef,
        status: "quarantined",
      });
      message.ack();
      return;
    }
    let wasCommitted = false;
    try {
      wasCommitted = Boolean(await mailbox.getEmail(pointer.ingressId));
    } catch {
      // An unavailable verification read cannot prove a commit. A retry is safe
      // because ingressId is the stable projection identity.
    }
    if (!wasCommitted) {
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

  await writeReceiptBestEffort(
    env.RAW_MAIL_BUCKET,
    pointer,
    "stored",
    runtime,
    message,
  );
  message.ack();
  console.log("[mail-projection] message acknowledged", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, projectionStartedAt),
    ingressRef,
    operation: "mailbox_projection",
    queueRef,
    status: "succeeded",
  });
}

export async function processInboundBatch(
  batch: { messages: readonly UntrustedQueueMessage[] },
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  for (const message of batch.messages) {
    const queueRef = await mailTelemetryLogRef("queue", message.id);
    console.log("[mail-projection] Queue message received", {
      attempt: message.attempts,
      operation: "queue_consume",
      queueRef,
      status: "started",
    });
    if (!isInboundArchivePointer(message.body)) {
      try {
        const durableQueueRef = await mailTelemetryRef("queue", message.id);
        await persistInvalidPointer(
          env.RAW_MAIL_BUCKET,
          message,
          durableQueueRef,
          "INVALID_QUEUE_POINTER",
          runtime,
        );
      } catch {
        const delaySeconds = retryDelaySeconds(message.attempts);
        console.error("[mail-projection] invalid pointer ledger failed", {
          attempt: message.attempts,
          delaySeconds,
          errorCode: "INVALID_POINTER_LEDGER_FAILED",
          operation: "queue_pointer_validate",
          queueRef,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        continue;
      }
      console.error("[mail-projection] invalid Queue pointer", {
        attempt: message.attempts,
        errorCode: "INVALID_QUEUE_POINTER",
        operation: "queue_pointer_validate",
        queueRef,
        status: "quarantined",
      });
      message.ack();
      continue;
    }

    const { ingressRef, objectRef } = await projectionTelemetryRefs(
      message.body,
      message.id,
    );
    try {
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
    } catch {
      const delaySeconds = retryDelaySeconds(message.attempts);
      console.error("[mail-projection] unexpected failure", {
        attempt: message.attempts,
        delaySeconds,
        errorCode: "UNEXPECTED_PROJECTION_FAILURE",
        ingressRef,
        objectRef,
        operation: "mailbox_projection",
        queueRef,
        status: "retrying",
      });
      message.retry({ delaySeconds });
    }
  }
}

export async function processInboundDeadLetterBatch(
  batch: { messages: readonly UntrustedQueueMessage[] },
  env: Pick<InboundProjectionEnvironment, "RAW_MAIL_BUCKET" | "MAILBOX">,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  for (const message of batch.messages) {
    const queueRef = await mailTelemetryLogRef("queue", message.id);
    if (!isInboundArchivePointer(message.body)) {
      try {
        const durableQueueRef = await mailTelemetryRef("queue", message.id);
        await persistInvalidPointer(
          env.RAW_MAIL_BUCKET,
          message,
          durableQueueRef,
          "INVALID_DLQ_POINTER",
          runtime,
        );
      } catch (error) {
        console.error("[mail-projection] invalid DLQ pointer ledger failed", {
          attempt: message.attempts,
          errorCode: "INVALID_DLQ_POINTER_LEDGER_FAILED",
          operation: "dead_letter_consume",
          queueRef,
          status: "failed",
        });
        throw error;
      }
      console.error("[mail-projection] invalid dead-letter pointer", {
        attempt: message.attempts,
        errorCode: "INVALID_DLQ_POINTER",
        operation: "dead_letter_consume",
        queueRef,
        status: "quarantined",
      });
      message.ack();
      continue;
    }

    const { ingressRef, objectRef } = await projectionTelemetryRefs(
      message.body,
      message.id,
    );

    if (env.RAW_MAIL_BUCKET.head) {
      try {
        const currentReceipt = await env.RAW_MAIL_BUCKET.head(
          receiptKey(message.body.ingressId),
        );
        const currentState = currentReceipt?.customMetadata?.state;
        if (isTerminalReceiptState(currentState)) {
          console.log("[mail-projection] terminal DLQ delivery acknowledged", {
            attempt: message.attempts,
            ingressRef,
            operation: "dead_letter_terminal_check",
            queueRef,
            status: "terminal",
          });
          message.ack();
          continue;
        }
      } catch {
        console.error("[mail-projection] terminal DLQ check degraded", {
          attempt: message.attempts,
          errorCode: "TERMINAL_DLQ_RECEIPT_CHECK_FAILED",
          ingressRef,
          operation: "dead_letter_terminal_check",
          queueRef,
          status: "degraded",
        });
      }
    }

    const mailbox = env.MAILBOX.get(
      env.MAILBOX.idFromName(message.body.mailboxId),
    );
    if (mailbox.getEmail) {
      const deleted = mailbox.isEmailDeleted
        ? await mailbox.isEmailDeleted(message.body.ingressId)
        : false;
      const stored = deleted
        ? null
        : await mailbox.getEmail(message.body.ingressId);
      if (deleted || stored) {
        const state = deleted ? "deleted" : "stored";
        try {
          await writeReceipt(
            env.RAW_MAIL_BUCKET,
            message.body,
            state,
            runtime,
            {
              errorCode: deleted
                ? "MAILBOX_PROJECTION_DELETED"
                : "MAILBOX_PROJECTION_STORED",
            },
          );
        } catch {
          console.error("[mail-projection] terminal DLQ receipt degraded", {
            attempt: message.attempts,
            errorCode: "TERMINAL_DLQ_RECEIPT_WRITE_FAILED",
            ingressRef,
            operation: "dead_letter_terminal_check",
            queueRef,
            status: "degraded",
          });
        }
        console.log("[mail-projection] late DLQ delivery suppressed", {
          attempt: message.attempts,
          ingressRef,
          operation: "dead_letter_terminal_check",
          queueRef,
          status: "terminal",
        });
        message.ack();
        continue;
      }
    }
    let terminalLedgered = false;
    const durableQueueRef = await mailTelemetryRef("queue", message.id);
    try {
      if (!mailbox.recordInboundTerminalFailure) {
        throw new Error("Mailbox terminal-failure ledger is unavailable");
      }
      const disposition = await mailbox.recordInboundTerminalFailure({
        id: message.body.ingressId,
        queueRef: durableQueueRef,
        attempts: message.attempts,
        errorCode: "QUEUE_RETRY_EXHAUSTED",
      });
      if (disposition === "stored" || disposition === "deleted") {
        try {
          await writeReceipt(
            env.RAW_MAIL_BUCKET,
            message.body,
            disposition,
            runtime,
            {
              errorCode:
                disposition === "stored"
                  ? "MAILBOX_PROJECTION_STORED"
                  : "MAILBOX_PROJECTION_DELETED",
            },
          );
        } catch {
          console.error(
            "[mail-projection] atomic DLQ disposition receipt degraded",
            {
              errorCode: "ATOMIC_DLQ_DISPOSITION_RECEIPT_FAILED",
              ingressRef,
              operation: "dead_letter_terminal_ledger",
              queueRef,
              status: "degraded",
            },
          );
        }
        message.ack();
        continue;
      }
      terminalLedgered =
        disposition === "ledgered" || disposition === undefined;
    } catch {
      console.error("[mail-projection] terminal fallback ledger failed", {
        attempt: message.attempts,
        errorCode: "TERMINAL_FALLBACK_LEDGER_FAILED",
        ingressRef,
        operation: "dead_letter_terminal_ledger",
        queueRef,
        status: "failed",
      });
    }

    let written = false;
    try {
      written = await writeReceipt(
        env.RAW_MAIL_BUCKET,
        message.body,
        "dead_lettered",
        runtime,
        {
          attempt: message.attempts,
          errorCode: "QUEUE_RETRY_EXHAUSTED",
          queueRef: durableQueueRef,
        },
      );
    } catch (error) {
      console.error("[mail-projection] terminal receipt write failed", {
        attempt: message.attempts,
        errorCode: "TERMINAL_RECEIPT_WRITE_FAILED",
        ingressRef,
        operation: "dead_letter_consume",
        queueRef,
        status: terminalLedgered ? "fallback_ledgered" : "failed",
      });
      if (!terminalLedgered) throw error;
    }
    if (!written) {
      let supersededByTerminalReceipt = false;
      try {
        const current = env.RAW_MAIL_BUCKET.head
          ? await env.RAW_MAIL_BUCKET.head(receiptKey(message.body.ingressId))
          : null;
        supersededByTerminalReceipt = isTerminalReceiptState(
          current?.customMetadata?.state,
        );
      } catch (error) {
        if (!terminalLedgered) throw error;
      }
      if (!terminalLedgered && !supersededByTerminalReceipt) {
        throw new Error(
          "Dead-letter failure was not persisted in either durable terminal ledger",
        );
      }
    }
    console.error("[mail-projection] dead-letter handoff completed", {
      attempt: message.attempts,
      ingressRef,
      objectRef,
      operation: "dead_letter_consume",
      queueRef,
      status: written
        ? "dead_lettered"
        : terminalLedgered
          ? "fallback_ledgered"
          : "superseded",
    });
    message.ack();
  }
}
