// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { Folders } from "../shared/folders.ts";
import {
  INBOUND_RECEIPT_SCHEMA_VERSION,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import { buildPushPayload } from "./lib/push/payload.ts";
import type { PushPayload } from "./lib/push/types.ts";
import { resolveBrand } from "./routes/brand.ts";
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

export const INBOUND_MAX_RETRIES = 10;

type ArchivedEmailObject = {
  key: string;
  version: string;
  size: number;
  etag: string;
  body: ReadableStream;
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
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    },
  ): Promise<unknown | null>;
};

type InboundMailboxNamespace = {
  idFromName(mailboxId: string): unknown;
  get(id: unknown): EmailStorageDependencies["mailbox"] & {
    firePush?(payload: PushPayload): Promise<void>;
  };
};

type InboundProjectionEnvironment = {
  BRAND?: string;
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

const defaultRuntime: InboundProjectionRuntime = {
  now: () => new Date(),
};

function receiptKey(ingressId: string): string {
  return `receipts/${ingressId}.json`;
}

function invalidPointerKey(queueMessageId: string): string {
  return `invalid-queue-pointers/${encodeURIComponent(queueMessageId)}.json`;
}

async function persistInvalidPointer(
  bucket: InboundReceiptBucket,
  message: UntrustedQueueMessage,
  errorCode: "INVALID_QUEUE_POINTER" | "INVALID_DLQ_POINTER",
  runtime: InboundProjectionRuntime,
): Promise<void> {
  await bucket.put(
    invalidPointerKey(message.id),
    JSON.stringify({
      attempts: message.attempts,
      body: message.body,
      errorCode,
      queueMessageId: message.id,
      recordedAt: runtime.now().toISOString(),
    }),
    {
      customMetadata: { errorCode },
      onlyIf: { etagDoesNotMatch: "*" },
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationMs(
  runtime: InboundProjectionRuntime,
  startedAt: number,
): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
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
    | "quarantined",
  runtime: InboundProjectionRuntime,
  details: Record<string, unknown> = {},
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
      ...pointer,
      state,
      updatedAt: runtime.now().toISOString(),
      ...details,
    }),
    {
      customMetadata: { state },
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
  try {
    const written = await writeReceipt(bucket, pointer, state, runtime);
    console.log(
      written
        ? "[mail-projection] receipt state persisted"
        : "[mail-projection] receipt state superseded",
      {
        attempt: message.attempts,
        durationMs: durationMs(runtime, startedAt),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "receipt_write",
        queueMessageId: message.id,
        state,
        status: written ? "succeeded" : "superseded",
        target: "r2",
      },
    );
  } catch (error) {
    console.error("[mail-projection] receipt write degraded", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, startedAt),
      errorCode: "RECEIPT_WRITE_FAILED",
      errorMessage: errorMessage(error),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "receipt_write",
      queueMessageId: message.id,
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
  errorCode: string,
  operation: string,
  error: unknown,
  startedAt: number,
): Promise<void> {
  const delaySeconds = retryDelaySeconds(message.attempts);
  const isFinalAttempt = message.attempts >= INBOUND_MAX_RETRIES + 1;
  const state = isFinalAttempt ? "dead_letter_pending" : "retrying";
  await writeReceipt(env.RAW_MAIL_BUCKET, pointer, state, runtime, {
    attempt: message.attempts,
    delaySeconds,
    errorCode,
  });
  console.error(
    isFinalAttempt
      ? "[mail-projection] dead-letter handoff scheduled"
      : "[mail-projection] retry scheduled",
    {
      attempt: message.attempts,
      delaySeconds,
      durationMs: durationMs(runtime, startedAt),
      errorCode,
      errorMessage: errorMessage(error),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation,
      queueMessageId: message.id,
      rawKey: pointer.rawKey,
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
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "queue_terminal_check",
          queueMessageId: message.id,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        return;
      }
      if (isTerminalReceiptState(currentState)) {
        console.log("[mail-projection] terminal delivery acknowledged", {
          attempt: message.attempts,
          durationMs: durationMs(runtime, projectionStartedAt),
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "queue_terminal_check",
          queueMessageId: message.id,
          state: currentState,
          status: "terminal",
        });
        message.ack();
        return;
      }
      if (currentState === "dead_letter_pending") {
        console.log("[mail-projection] pending DLQ delivery acknowledged", {
          attempt: message.attempts,
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "queue_terminal_check",
          queueMessageId: message.id,
          state: currentState,
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
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "queue_terminal_check",
          queueMessageId: message.id,
          state: currentState,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        return;
      }
    } catch (error) {
      console.error("[mail-projection] terminal receipt check degraded", {
        attempt: message.attempts,
        errorCode: "TERMINAL_RECEIPT_CHECK_FAILED",
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "queue_terminal_check",
        queueMessageId: message.id,
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
  } catch (error) {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "MAILBOX_MARKER_READ_FAILED",
      "mailbox_resolution",
      error,
      mailboxLookupStartedAt,
    );
    return;
  }
  console.log("[mail-projection] mailbox marker read completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, mailboxLookupStartedAt),
    found: Boolean(mailboxMarker),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "mailbox_resolution",
    queueMessageId: message.id,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "mailbox_resolution",
      queueMessageId: message.id,
      rawKey: pointer.rawKey,
      status: "quarantined",
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
  } catch (error) {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "IDEMPOTENCY_CHECK_FAILED",
      "mailbox_idempotency_check",
      error,
      idempotencyStartedAt,
    );
    return;
  }
  console.log("[mail-projection] idempotency check completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, idempotencyStartedAt),
    found: Boolean(existingEmail),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "mailbox_idempotency_check",
    queueMessageId: message.id,
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "receipt_write",
        queueMessageId: message.id,
        state: "deleted",
        status: written ? "succeeded" : "superseded",
        target: "r2",
      });
    } catch (error) {
      console.error("[mail-projection] deletion receipt write degraded", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, receiptStartedAt),
        errorCode: "DELETION_RECEIPT_WRITE_FAILED",
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "receipt_write",
        queueMessageId: message.id,
        state: "deleted",
        status: "degraded",
      });
    }
    console.log("[mail-projection] deleted projection remains suppressed", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, projectionStartedAt),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "mailbox_projection",
      queueMessageId: message.id,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "mailbox_projection",
      queueMessageId: message.id,
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
  } catch (error) {
    await scheduleRetry(
      message,
      pointer,
      env,
      runtime,
      "RAW_ARCHIVE_READ_FAILED",
      "raw_archive_read",
      error,
      rawReadStartedAt,
    );
    return;
  }
  console.log("[mail-projection] raw archive read completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, rawReadStartedAt),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "raw_archive_read",
    queueMessageId: message.id,
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
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "raw_archive_verify",
      queueMessageId: message.id,
      rawKey: pointer.rawKey,
      status: "quarantined",
    });
    message.ack();
    return;
  }

  let parsed: Email | undefined;
  const parseStartedAt = runtime.now().getTime();
  const mailboxProjectionStartedAt = runtime.now().getTime();
  try {
    if (runtime.parse) {
      try {
        parsed = await runtime.parse(raw.body);
      } catch (error) {
        await writeReceipt(
          env.RAW_MAIL_BUCKET,
          pointer,
          "quarantined",
          runtime,
          {
            errorCode: "MIME_PARSE_FAILED",
            errorMessage: errorMessage(error),
          },
        );
        console.error("[mail-projection] quarantined", {
          attempt: message.attempts,
          durationMs: durationMs(runtime, parseStartedAt),
          errorCode: "MIME_PARSE_FAILED",
          errorMessage: errorMessage(error),
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "mime_parse",
          queueMessageId: message.id,
          rawKey: pointer.rawKey,
          status: "quarantined",
        });
        message.ack();
        return;
      }
      await storeParsedEmail({ bucket: env.BUCKET, mailbox }, parsed, {
        folder: Folders.INBOX,
        date: pointer.archivedAt,
        messageId: pointer.ingressId,
        read: false,
      });
    } else {
      parsed = await storeStreamingEmail(
        { bucket: env.BUCKET, mailbox },
        raw.body,
        {
          folder: Folders.INBOX,
          date: pointer.archivedAt,
          messageId: pointer.ingressId,
          read: false,
        },
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "mailbox_projection",
        queueMessageId: message.id,
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
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "mailbox_projection",
        queueMessageId: message.id,
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
        errorMessage: errorMessage(error),
      });
      console.error("[mail-projection] quarantined", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, parseStartedAt),
        errorCode: permanentErrorCode,
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "mime_parse",
        queueMessageId: message.id,
        rawKey: pointer.rawKey,
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
        error,
        mailboxProjectionStartedAt,
      );
      return;
    }
    console.log("[mail-projection] ambiguous commit recovered", {
      attempt: message.attempts,
      durationMs: durationMs(runtime, mailboxProjectionStartedAt),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "mailbox_projection",
      queueMessageId: message.id,
      status: "recovered",
    });
  }
  console.log("[mail-projection] MIME parse completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, parseStartedAt),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "mime_parse",
    queueMessageId: message.id,
    status: "succeeded",
  });
  console.log("[mail-projection] Mailbox projection completed", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, mailboxProjectionStartedAt),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "mailbox_projection",
    queueMessageId: message.id,
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
  let pushClaimed = Boolean(mailbox.firePush && parsed);
  if (mailbox.firePush && parsed && mailbox.claimInboundPush) {
    try {
      pushClaimed = await mailbox.claimInboundPush(pointer.ingressId);
    } catch (error) {
      pushClaimed = false;
      console.error("[mail-projection] push claim degraded", {
        attempt: message.attempts,
        errorCode: "PUSH_CLAIM_FAILED",
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "push_claim",
        queueMessageId: message.id,
        status: "degraded",
      });
    }
  }
  if (mailbox.firePush && pushClaimed && parsed) {
    const pushStartedAt = runtime.now().getTime();
    try {
      const brand = resolveBrand(env.BRAND);
      await mailbox.firePush(
        buildPushPayload({
          emailId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          fromName: parsed.from?.name,
          fromAddress: parsed.from?.address ?? "",
          subject: parsed.subject,
          body: parsed.html ?? parsed.text,
          icon: brand.pwaIcon192,
          badge: brand.notificationBadge,
        }),
      );
      console.log("[mail-projection] push dispatch delegated", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, pushStartedAt),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "push_dispatch",
        queueMessageId: message.id,
        status: "delegated",
        target: "mailbox_push_fanout",
      });
    } catch (error) {
      console.error("[mail-projection] push degraded", {
        attempt: message.attempts,
        durationMs: durationMs(runtime, pushStartedAt),
        errorCode: "PUSH_DISPATCH_FAILED",
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "push_dispatch",
        queueMessageId: message.id,
        status: "degraded",
      });
    }
  } else if (mailbox.firePush && !parsed) {
    console.error(
      "[mail-projection] push deferred after ambiguous projection",
      {
        attempt: message.attempts,
        errorCode: "PUSH_PAYLOAD_UNAVAILABLE",
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "push_dispatch",
        queueMessageId: message.id,
        status: "deferred",
      },
    );
  } else if (mailbox.firePush) {
    console.log("[mail-projection] duplicate push suppressed", {
      attempt: message.attempts,
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      operation: "push_dispatch",
      queueMessageId: message.id,
      status: "suppressed",
    });
  }
  message.ack();
  console.log("[mail-projection] message acknowledged", {
    attempt: message.attempts,
    durationMs: durationMs(runtime, projectionStartedAt),
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    operation: "mailbox_projection",
    queueMessageId: message.id,
    status: "succeeded",
  });
}

export async function processInboundBatch(
  batch: { messages: readonly UntrustedQueueMessage[] },
  env: InboundProjectionEnvironment,
  runtime: InboundProjectionRuntime = defaultRuntime,
): Promise<void> {
  for (const message of batch.messages) {
    console.log("[mail-projection] Queue message received", {
      attempt: message.attempts,
      operation: "queue_consume",
      queueMessageId: message.id,
      status: "started",
    });
    if (!isInboundArchivePointer(message.body)) {
      try {
        await persistInvalidPointer(
          env.RAW_MAIL_BUCKET,
          message,
          "INVALID_QUEUE_POINTER",
          runtime,
        );
      } catch (error) {
        const delaySeconds = retryDelaySeconds(message.attempts);
        console.error("[mail-projection] invalid pointer ledger failed", {
          attempt: message.attempts,
          delaySeconds,
          errorCode: "INVALID_POINTER_LEDGER_FAILED",
          errorMessage: errorMessage(error),
          operation: "queue_pointer_validate",
          queueMessageId: message.id,
          status: "retrying",
        });
        message.retry({ delaySeconds });
        continue;
      }
      console.error("[mail-projection] invalid Queue pointer", {
        attempt: message.attempts,
        errorCode: "INVALID_QUEUE_POINTER",
        operation: "queue_pointer_validate",
        queueMessageId: message.id,
        status: "quarantined",
      });
      message.ack();
      continue;
    }

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
    } catch (error) {
      const delaySeconds = retryDelaySeconds(message.attempts);
      console.error("[mail-projection] unexpected failure", {
        attempt: message.attempts,
        delaySeconds,
        errorCode: "UNEXPECTED_PROJECTION_FAILURE",
        errorMessage: errorMessage(error),
        ingressId: message.body.ingressId,
        mailboxId: message.body.mailboxId,
        operation: "mailbox_projection",
        queueMessageId: message.id,
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
    if (!isInboundArchivePointer(message.body)) {
      try {
        await persistInvalidPointer(
          env.RAW_MAIL_BUCKET,
          message,
          "INVALID_DLQ_POINTER",
          runtime,
        );
      } catch (error) {
        console.error("[mail-projection] invalid DLQ pointer ledger failed", {
          attempt: message.attempts,
          errorCode: "INVALID_DLQ_POINTER_LEDGER_FAILED",
          errorMessage: errorMessage(error),
          operation: "dead_letter_consume",
          queueMessageId: message.id,
          status: "failed",
        });
        throw error;
      }
      console.error("[mail-projection] invalid dead-letter pointer", {
        attempt: message.attempts,
        errorCode: "INVALID_DLQ_POINTER",
        operation: "dead_letter_consume",
        queueMessageId: message.id,
        status: "quarantined",
      });
      message.ack();
      continue;
    }

    if (env.RAW_MAIL_BUCKET.head) {
      try {
        const currentReceipt = await env.RAW_MAIL_BUCKET.head(
          receiptKey(message.body.ingressId),
        );
        const currentState = currentReceipt?.customMetadata?.state;
        if (isTerminalReceiptState(currentState)) {
          console.log("[mail-projection] terminal DLQ delivery acknowledged", {
            attempt: message.attempts,
            ingressId: message.body.ingressId,
            mailboxId: message.body.mailboxId,
            operation: "dead_letter_terminal_check",
            queueMessageId: message.id,
            state: currentState,
            status: "terminal",
          });
          message.ack();
          continue;
        }
      } catch (error) {
        console.error("[mail-projection] terminal DLQ check degraded", {
          attempt: message.attempts,
          errorCode: "TERMINAL_DLQ_RECEIPT_CHECK_FAILED",
          errorMessage: errorMessage(error),
          ingressId: message.body.ingressId,
          mailboxId: message.body.mailboxId,
          operation: "dead_letter_terminal_check",
          queueMessageId: message.id,
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
                : "MAILBOX_PROJECTION_ALREADY_STORED",
            },
          );
        } catch (error) {
          console.error("[mail-projection] terminal DLQ receipt degraded", {
            attempt: message.attempts,
            errorCode: "TERMINAL_DLQ_RECEIPT_WRITE_FAILED",
            errorMessage: errorMessage(error),
            ingressId: message.body.ingressId,
            mailboxId: message.body.mailboxId,
            operation: "dead_letter_terminal_check",
            queueMessageId: message.id,
            state,
            status: "degraded",
          });
        }
        console.log("[mail-projection] late DLQ delivery suppressed", {
          attempt: message.attempts,
          ingressId: message.body.ingressId,
          mailboxId: message.body.mailboxId,
          operation: "dead_letter_terminal_check",
          queueMessageId: message.id,
          state,
          status: "terminal",
        });
        message.ack();
        continue;
      }
    }
    let terminalLedgered = false;
    try {
      if (!mailbox.recordInboundTerminalFailure) {
        throw new Error("Mailbox terminal-failure ledger is unavailable");
      }
      const disposition = await mailbox.recordInboundTerminalFailure({
        id: message.body.ingressId,
        queueMessageId: message.id,
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
            { errorCode: `MAILBOX_PROJECTION_${disposition.toUpperCase()}` },
          );
        } catch (error) {
          console.error(
            "[mail-projection] atomic DLQ disposition receipt degraded",
            {
              errorCode: "ATOMIC_DLQ_DISPOSITION_RECEIPT_FAILED",
              errorMessage: errorMessage(error),
              ingressId: message.body.ingressId,
              mailboxId: message.body.mailboxId,
              operation: "dead_letter_terminal_ledger",
              queueMessageId: message.id,
              state: disposition,
              status: "degraded",
            },
          );
        }
        message.ack();
        continue;
      }
      terminalLedgered =
        disposition === "ledgered" || disposition === undefined;
    } catch (error) {
      console.error("[mail-projection] terminal fallback ledger failed", {
        attempt: message.attempts,
        errorCode: "TERMINAL_FALLBACK_LEDGER_FAILED",
        errorMessage: errorMessage(error),
        ingressId: message.body.ingressId,
        mailboxId: message.body.mailboxId,
        operation: "dead_letter_terminal_ledger",
        queueMessageId: message.id,
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
          queueMessageId: message.id,
        },
      );
    } catch (error) {
      console.error("[mail-projection] terminal receipt write failed", {
        attempt: message.attempts,
        errorCode: "TERMINAL_RECEIPT_WRITE_FAILED",
        errorMessage: errorMessage(error),
        ingressId: message.body.ingressId,
        mailboxId: message.body.mailboxId,
        operation: "dead_letter_consume",
        queueMessageId: message.id,
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
      ingressId: message.body.ingressId,
      mailboxId: message.body.mailboxId,
      operation: "dead_letter_consume",
      queueMessageId: message.id,
      rawKey: message.body.rawKey,
      status: written
        ? "dead_lettered"
        : terminalLedgered
          ? "fallback_ledgered"
          : "superseded",
    });
    message.ack();
  }
}
