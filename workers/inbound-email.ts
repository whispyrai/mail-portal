// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { Folders } from "../shared/folders.ts";
import {
  MAX_EMAIL_SIZE,
  emailExists,
  storeParsedEmail,
  type EmailStorageDependencies,
} from "./lib/store-email.ts";
import {
  isPermanentMimeProjectionError,
  storeStreamingEmail,
} from "./lib/streaming-email.ts";
import {
  isAddressInConfiguredMailDomains,
  normalizeMailAddress,
} from "./lib/mail-address.ts";
import { arrayBufferToHex } from "./lib/checksum.ts";

export const INBOUND_RECEIPT_SCHEMA_VERSION: 1 = 1;

export type InboundArchivePointer = {
  schemaVersion: typeof INBOUND_RECEIPT_SCHEMA_VERSION;
  ingressId: string;
  rawKey: string;
  mailboxId: string;
  rawSize: number;
  rawSha256?: string;
  archivedAt: string;
  etag: string;
  version: string;
};

type InboundEmailEvent = Pick<
  ForwardableEmailMessage,
  "forward" | "raw" | "rawSize" | "to" | "setReject"
>;

type InboundEnvironment = {
  BRAND?: string;
  DOMAINS: string;
  EMAIL_ADDRESSES?: string[];
  EMERGENCY_FORWARD_TO: string;
  BUCKET: EmailStorageDependencies["bucket"] & Pick<R2Bucket, "head">;
  RAW_MAIL_BUCKET: Pick<R2Bucket, "put">;
  INBOUND_QUEUE: Pick<Queue<InboundArchivePointer>, "send">;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): EmailStorageDependencies["mailbox"];
  };
};

type IngressReceiptState = "admitted" | "enqueued" | "rejected";

type InboundRuntime = {
  now(): Date;
  randomUUID(): string;
  sleep(delayMs: number): Promise<void>;
  digestSha256(value: ArrayBuffer): Promise<ArrayBuffer>;
  parse?(raw: ArrayBuffer): Promise<Email>;
};

const defaultRuntime: InboundRuntime = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  sleep: (delayMs) => scheduler.wait(delayMs),
  digestSha256: (value) => crypto.subtle.digest("SHA-256", value),
};

const RAW_ARCHIVE_MAX_ATTEMPTS = 10;
const RAW_ARCHIVE_INITIAL_BACKOFF_MS = 100;
const RAW_ARCHIVE_MAX_BACKOFF_MS = 2_000;
const RECEIPT_MAX_ATTEMPTS = 10;
const RECEIPT_INITIAL_BACKOFF_MS = 50;
const RECEIPT_MAX_BACKOFF_MS = 1_000;

type DirectMailboxFallbackResult =
  | "stored"
  | "unprovisioned"
  | "unverified"
  | "failed";

function archiveKey(archivedAt: Date, ingressId: string): string {
  const year = archivedAt.getUTCFullYear();
  const month = String(archivedAt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(archivedAt.getUTCDate()).padStart(2, "0");
  return `raw/${year}/${month}/${day}/${ingressId}.eml`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function durationMs(runtime: InboundRuntime, startedAt: number): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

function rejectMessage(
  event: InboundEmailEvent,
  input: {
    errorCode: string;
    ingressId: string;
    mailboxId: string;
    rawKey: string;
    reason: string;
    smtpMessage: string;
  },
): void {
  console.error("[mail-ingress] permanent SMTP rejection requested", {
    errorCode: input.errorCode,
    ingressId: input.ingressId,
    mailboxId: input.mailboxId,
    operation: "smtp_rejection",
    rawKey: input.rawKey,
    reason: input.reason,
    status: "rejected",
  });
  event.setReject(input.smtpMessage);
}

function replayStream(rawBytes: ArrayBuffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(rawBytes));
      controller.close();
    },
  });
}

async function persistRawWithRetry(
  env: InboundEnvironment,
  rawKey: string,
  rawBytes: ArrayBuffer,
  metadata: Record<string, string>,
  rawSha256: ArrayBuffer,
  rawSha256Hex: string,
  ingressId: string,
  mailboxId: string,
  runtime: InboundRuntime,
): Promise<R2Object> {
  const startedAt = runtime.now().getTime();
  for (let attempt = 1; attempt <= RAW_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    let errorCode = "RAW_ARCHIVE_FAILED";
    try {
      const archived = await env.RAW_MAIL_BUCKET.put(rawKey, rawBytes, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: metadata,
        sha256: rawSha256,
      });
      if (archived.size !== rawBytes.byteLength) {
        errorCode = "RAW_ARCHIVE_SIZE_MISMATCH";
        throw new Error("Raw email archive size mismatch");
      }
      if (!archived.checksums?.sha256) {
        errorCode = "RAW_ARCHIVE_CHECKSUM_UNAVAILABLE";
        throw new Error("Raw email archive checksum unavailable");
      }
      if (arrayBufferToHex(archived.checksums.sha256) !== rawSha256Hex) {
        errorCode = "RAW_ARCHIVE_CHECKSUM_MISMATCH";
        throw new Error("Raw email archive checksum mismatch");
      }
      console.log("[mail-ingress] raw archive persisted", {
        archivedSize: archived.size,
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressId,
        mailboxId,
        operation: "raw_archive",
        rawKey,
        status: "succeeded",
        target: "r2",
      });
      return archived;
    } catch (error) {
      const finalAttempt = attempt === RAW_ARCHIVE_MAX_ATTEMPTS;
      console.error(
        finalAttempt
          ? "[mail-ingress] boundary failed"
          : "[mail-ingress] raw archive attempt failed",
        {
          attempt,
          durationMs: durationMs(runtime, startedAt),
          errorCode,
          errorMessage: errorMessage(error),
          ingressId,
          mailboxId,
          maxAttempts: RAW_ARCHIVE_MAX_ATTEMPTS,
          operation: "raw_archive",
          rawKey,
          status: finalAttempt ? "failed" : "retrying",
        },
      );
      if (finalAttempt) throw error;

      const delayMs = Math.min(
        RAW_ARCHIVE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RAW_ARCHIVE_MAX_BACKOFF_MS,
      );
      console.log("[mail-ingress] raw archive retry scheduled", {
        attempt,
        delayMs,
        ingressId,
        mailboxId,
        nextAttempt: attempt + 1,
        operation: "raw_archive",
        rawKey,
        status: "retrying",
      });
      await runtime.sleep(delayMs);
    }
  }
  throw new Error("Raw archive retry loop ended unexpectedly");
}

async function recordReceiptState(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  state: IngressReceiptState,
  updatedAt: string,
  runtime: InboundRuntime,
  onlyIfEtag?: string,
): Promise<R2Object | null> {
  const startedAt = runtime.now().getTime();
  for (let attempt = 1; attempt <= RECEIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const receiptKey = `receipts/${pointer.ingressId}.json`;
      const receiptBody = JSON.stringify({
        ...pointer,
        state,
        updatedAt,
      });
      const receipt = onlyIfEtag
        ? await env.RAW_MAIL_BUCKET.put(receiptKey, receiptBody, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { state },
            onlyIf: { etagMatches: onlyIfEtag },
          })
        : await env.RAW_MAIL_BUCKET.put(receiptKey, receiptBody, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { state },
            onlyIf: { etagDoesNotMatch: "*" },
          });
      if (!receipt) {
        console.log("[mail-ingress] receipt state superseded", {
          attempt,
          durationMs: durationMs(runtime, startedAt),
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "receipt_write",
          rawKey: pointer.rawKey,
          state,
          status: "superseded",
          target: "r2",
        });
        return null;
      }
      console.log("[mail-ingress] receipt state persisted", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        operation: "receipt_write",
        rawKey: pointer.rawKey,
        state,
        status: "succeeded",
        target: "r2",
      });
      return receipt;
    } catch (error) {
      const finalAttempt = attempt === RECEIPT_MAX_ATTEMPTS;
      console.error("[mail-ingress] receipt write degraded", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        errorCode: "RECEIPT_WRITE_FAILED",
        errorMessage: errorMessage(error),
        ingressId: pointer.ingressId,
        mailboxId: pointer.mailboxId,
        maxAttempts: RECEIPT_MAX_ATTEMPTS,
        operation: "receipt_write",
        rawKey: pointer.rawKey,
        state,
        status: finalAttempt ? "degraded" : "retrying",
      });
      if (finalAttempt) return null;
      const delayMs = Math.min(
        RECEIPT_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RECEIPT_MAX_BACKOFF_MS,
      );
      await runtime.sleep(delayMs);
    }
  }
  return null;
}

function envelopeMailboxId(
  event: InboundEmailEvent,
  env: InboundEnvironment,
): string | null {
  const mailboxId = normalizeMailAddress(event.to);
  if (!mailboxId || !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS))
    return null;

  const allowedAddresses = (env.EMAIL_ADDRESSES ?? []).map((address) =>
    address.toLowerCase(),
  );
  if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId))
    return null;
  return mailboxId;
}

function admittedMailboxId(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  rawSize: number,
): string | null {
  const mailboxId = envelopeMailboxId(event, env);
  if (!mailboxId) return null;
  if (rawSize <= 0 || rawSize > MAX_EMAIL_SIZE || event.rawSize !== rawSize)
    return null;
  return mailboxId;
}

async function storeDirectlyInMailbox(
  mailboxId: string,
  rawBytes: ArrayBuffer,
  ingressId: string,
  receivedAt: string,
  env: InboundEnvironment,
  runtime: InboundRuntime,
): Promise<DirectMailboxFallbackResult> {
  const startedAt = runtime.now().getTime();
  let marker: unknown | null;
  try {
    marker = await env.BUCKET.head(`mailboxes/${mailboxId}.json`);
  } catch (error) {
    console.error(
      "[mail-ingress] direct mailbox fallback could not verify recipient",
      {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "MAILBOX_VERIFICATION_FAILED",
        errorMessage: errorMessage(error),
        ingressId,
        mailboxId,
        operation: "direct_mailbox_fallback",
        status: "unverified",
      },
    );
    return "unverified";
  }
  if (!marker) {
    console.error("[mail-ingress] direct mailbox fallback unavailable", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressId,
      mailboxId,
      operation: "direct_mailbox_fallback",
      status: "unprovisioned",
    });
    return "unprovisioned";
  }

  try {
    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
    if (mailbox.isEmailDeleted && (await mailbox.isEmailDeleted(ingressId))) {
      console.log("[mail-ingress] deleted projection remains suppressed", {
        durationMs: durationMs(runtime, startedAt),
        ingressId,
        mailboxId,
        operation: "direct_mailbox_fallback",
        status: "deleted",
      });
      return "stored";
    }
    const existing = await emailExists(mailbox, ingressId);
    if (!existing) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (runtime.parse) {
            const parsed = await runtime.parse(rawBytes);
            await storeParsedEmail({ bucket: env.BUCKET, mailbox }, parsed, {
              folder: Folders.INBOX,
              date: receivedAt,
              messageId: ingressId,
              read: false,
            });
          } else {
            await storeStreamingEmail(
              { bucket: env.BUCKET, mailbox },
              replayStream(rawBytes),
              {
                folder: Folders.INBOX,
                date: receivedAt,
                messageId: ingressId,
                read: false,
              },
            );
          }
          break;
        } catch (error) {
          const committed = await emailExists(mailbox, ingressId);
          if (committed) {
            console.log(
              "[mail-ingress] direct mailbox ambiguous commit recovered",
              {
                durationMs: durationMs(runtime, startedAt),
                ingressId,
                mailboxId,
                operation: "direct_mailbox_fallback",
                status: "recovered",
              },
            );
            break;
          }
          if (attempt === 3 || isPermanentMimeProjectionError(error))
            throw error;
          const delayMs = 100 * 2 ** (attempt - 1);
          console.error(
            "[mail-ingress] direct mailbox fallback retry scheduled",
            {
              attempt,
              delayMs,
              errorCode: "DIRECT_MAILBOX_FALLBACK_RETRY",
              errorMessage: errorMessage(error),
              ingressId,
              mailboxId,
              maxAttempts: 3,
              operation: "direct_mailbox_fallback",
              status: "retrying",
            },
          );
          await runtime.sleep(delayMs);
        }
      }
    }

    console.log("[mail-ingress] direct mailbox fallback completed", {
      durationMs: durationMs(runtime, startedAt),
      ingressId,
      mailboxId,
      operation: "direct_mailbox_fallback",
      status: existing ? "duplicate" : "succeeded",
      target: "durable_object",
    });
    return "stored";
  } catch (error) {
    console.error("[mail-ingress] direct mailbox fallback failed", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "DIRECT_MAILBOX_FALLBACK_FAILED",
      errorMessage: errorMessage(error),
      ingressId,
      mailboxId,
      operation: "direct_mailbox_fallback",
      status: "failed",
    });
    return "failed";
  }
}

async function forwardEmergencyOrReject(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  ingressId: string,
  mailboxId: string,
  rawKey: string,
  runtime: InboundRuntime,
): Promise<void> {
  const forwardStartedAt = runtime.now().getTime();
  try {
    const result = await event.forward(env.EMERGENCY_FORWARD_TO);
    console.log("[mail-ingress] emergency forwarding completed", {
      durationMs: durationMs(runtime, forwardStartedAt),
      ingressId,
      mailboxId,
      messageId: result.messageId,
      operation: "emergency_forward",
      rawKey,
      status: "succeeded",
      target: "verified_destination",
    });
    return;
  } catch (error) {
    console.error("[mail-ingress] emergency forwarding failed", {
      durationMs: durationMs(runtime, forwardStartedAt),
      errorCode: "EMERGENCY_FORWARD_FAILED",
      errorMessage: errorMessage(error),
      ingressId,
      mailboxId,
      operation: "emergency_forward",
      rawKey,
      status: "failed",
    });
  }

  rejectMessage(event, {
    errorCode: "ALL_DURABILITY_PATHS_FAILED",
    ingressId,
    mailboxId,
    rawKey,
    reason: "raw_archive_mailbox_and_emergency_failed",
    smtpMessage: "Message could not be stored; please resend later",
  });
}

async function recoverFromRawArchiveFailure(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  rawBytes: ArrayBuffer,
  ingressId: string,
  receivedAt: string,
  rawKey: string,
  runtime: InboundRuntime,
): Promise<void> {
  const mailboxId = admittedMailboxId(event, env, rawBytes.byteLength);
  if (!mailboxId) {
    console.error("[mail-ingress] fallback admission rejected", {
      errorCode: "FALLBACK_RECIPIENT_OR_SIZE_INVALID",
      ingressId,
      mailboxId: event.to.trim().toLowerCase(),
      operation: "fallback_admission",
      rawKey,
      status: "rejected",
    });
    rejectMessage(event, {
      errorCode: "FALLBACK_RECIPIENT_OR_SIZE_INVALID",
      ingressId,
      mailboxId: event.to.trim().toLowerCase(),
      rawKey,
      reason: "fallback_admission_invalid",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }

  const directResult = await storeDirectlyInMailbox(
    mailboxId,
    rawBytes,
    ingressId,
    receivedAt,
    env,
    runtime,
  );
  if (directResult === "stored") return;
  if (directResult === "unprovisioned" || directResult === "unverified") {
    rejectMessage(event, {
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressId,
      mailboxId,
      rawKey,
      reason: "direct_mailbox_unprovisioned_or_unverified",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }

  await forwardEmergencyOrReject(
    event,
    env,
    ingressId,
    mailboxId,
    rawKey,
    runtime,
  );
}

export async function receiveEmail(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  _ctx: Pick<ExecutionContext, "waitUntil">,
  runtimeOverrides: Partial<InboundRuntime> = {},
): Promise<void> {
  const runtime: InboundRuntime = { ...defaultRuntime, ...runtimeOverrides };
  const handlerStartedAt = runtime.now().getTime();
  const archivedAtDate = runtime.now();
  const archivedAt = archivedAtDate.toISOString();
  const ingressId = runtime.randomUUID();
  const rawKey = archiveKey(archivedAtDate, ingressId);
  const envelopeRecipient = event.to.trim().toLowerCase();
  let rawBytes: ArrayBuffer;
  try {
    rawBytes = await new Response(event.raw).arrayBuffer();
  } catch (error) {
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_STREAM_READ_FAILED",
      errorMessage: errorMessage(error),
      ingressId,
      mailboxId: envelopeRecipient,
      operation: "raw_stream_read",
      rawKey,
      status: "failed",
    });
    const mailboxId = envelopeMailboxId(event, env);
    if (!mailboxId) {
      rejectMessage(event, {
        errorCode: "FALLBACK_RECIPIENT_INVALID",
        ingressId,
        mailboxId: envelopeRecipient,
        rawKey,
        reason: "unreadable_raw_recipient_invalid",
        smtpMessage: "Mailbox unavailable",
      });
      return;
    }
    try {
      if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) {
        rejectMessage(event, {
          errorCode: "MAILBOX_UNAVAILABLE",
          ingressId,
          mailboxId,
          rawKey,
          reason: "unreadable_raw_mailbox_unprovisioned",
          smtpMessage: "Mailbox unavailable",
        });
        return;
      }
    } catch (verificationError) {
      console.error(
        "[mail-ingress] unreadable message recipient could not be verified",
        {
          errorCode: "MAILBOX_VERIFICATION_FAILED",
          errorMessage: errorMessage(verificationError),
          ingressId,
          mailboxId,
          operation: "emergency_forward_admission",
          status: "unverified",
        },
      );
      rejectMessage(event, {
        errorCode: "MAILBOX_VERIFICATION_FAILED",
        ingressId,
        mailboxId,
        rawKey,
        reason: "unreadable_raw_mailbox_unverified",
        smtpMessage: "Mailbox unavailable",
      });
      return;
    }
    await forwardEmergencyOrReject(
      event,
      env,
      ingressId,
      mailboxId,
      rawKey,
      runtime,
    );
    return;
  }

  let rawSha256: ArrayBuffer;
  try {
    rawSha256 = await runtime.digestSha256(rawBytes);
  } catch (error) {
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED",
      errorMessage: errorMessage(error),
      ingressId,
      mailboxId: envelopeRecipient,
      operation: "raw_archive_checksum",
      rawKey,
      status: "failed",
    });
    await recoverFromRawArchiveFailure(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
    );
    return;
  }
  const rawSha256Hex = arrayBufferToHex(rawSha256);
  let archived: R2Object;
  try {
    archived = await persistRawWithRetry(
      env,
      rawKey,
      rawBytes,
      {
        archivedAt,
        declaredRawSize: String(event.rawSize),
        ingressId,
        mailboxId: envelopeRecipient,
        rawSize: String(rawBytes.byteLength),
        rawSha256: rawSha256Hex,
        schemaVersion: String(INBOUND_RECEIPT_SCHEMA_VERSION),
      },
      rawSha256,
      rawSha256Hex,
      ingressId,
      envelopeRecipient,
      runtime,
    );
  } catch {
    await recoverFromRawArchiveFailure(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
    );
    return;
  }

  const mailboxId = normalizeMailAddress(event.to);
  const pointer: InboundArchivePointer = {
    schemaVersion: INBOUND_RECEIPT_SCHEMA_VERSION,
    ingressId,
    rawKey,
    mailboxId: mailboxId ?? envelopeRecipient,
    rawSize: rawBytes.byteLength,
    rawSha256: rawSha256Hex,
    archivedAt,
    etag: archived.etag,
    version: archived.version,
  };
  console.log("[mail-ingress] message archived before admission", {
    declaredRawSize: event.rawSize,
    durationMs: durationMs(runtime, handlerStartedAt),
    ingressId,
    mailboxId: pointer.mailboxId,
    operation: "inbound_receive",
    rawKey,
    rawSize: rawBytes.byteLength,
    status: "archived",
  });
  if (!mailboxId || !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS)) {
    await recordReceiptState(
      env,
      pointer,
      "rejected",
      runtime.now().toISOString(),
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RECIPIENT_DOMAIN_INVALID",
      ingressId,
      mailboxId: pointer.mailboxId,
      operation: "envelope_admission",
      rawKey,
      status: "rejected",
    });
    rejectMessage(event, {
      errorCode: "RECIPIENT_DOMAIN_INVALID",
      ingressId,
      mailboxId: pointer.mailboxId,
      rawKey,
      reason: "recipient_domain_invalid",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }

  const allowedAddresses = (env.EMAIL_ADDRESSES ?? []).map((address) =>
    address.toLowerCase(),
  );
  if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId)) {
    await recordReceiptState(
      env,
      pointer,
      "rejected",
      runtime.now().toISOString(),
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RECIPIENT_NOT_ALLOWED",
      ingressId,
      mailboxId,
      operation: "envelope_admission",
      rawKey,
      status: "rejected",
    });
    rejectMessage(event, {
      errorCode: "RECIPIENT_NOT_ALLOWED",
      ingressId,
      mailboxId,
      rawKey,
      reason: "recipient_not_allowed",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }

  if (
    rawBytes.byteLength <= 0 ||
    rawBytes.byteLength > MAX_EMAIL_SIZE ||
    event.rawSize !== rawBytes.byteLength
  ) {
    await recordReceiptState(
      env,
      pointer,
      "rejected",
      runtime.now().toISOString(),
      runtime,
    );
    console.error("[mail-ingress] message rejected", {
      actualRawSize: rawBytes.byteLength,
      declaredRawSize: event.rawSize,
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_SIZE_INVALID",
      ingressId,
      mailboxId,
      operation: "envelope_admission",
      rawKey,
      status: "rejected",
    });
    rejectMessage(event, {
      errorCode: "RAW_SIZE_INVALID",
      ingressId,
      mailboxId,
      rawKey,
      reason: "raw_size_invalid",
      smtpMessage: "Message size unavailable",
    });
    return;
  }

  let mailboxProvisioned: boolean | undefined;
  const admissionStartedAt = runtime.now().getTime();
  try {
    mailboxProvisioned = Boolean(
      await env.BUCKET.head(`mailboxes/${mailboxId}.json`),
    );
  } catch (error) {
    console.error("[mail-ingress] admission check degraded", {
      durationMs: durationMs(runtime, admissionStartedAt),
      errorCode: "MAILBOX_ADMISSION_CHECK_FAILED",
      errorMessage: errorMessage(error),
      mailboxId,
      operation: "mailbox_admission_check",
      recoveryAction: "queue_consumer_recheck",
      status: "degraded",
    });
  }
  if (mailboxProvisioned === false) {
    await recordReceiptState(
      env,
      pointer,
      "rejected",
      runtime.now().toISOString(),
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressId,
      mailboxId,
      operation: "mailbox_admission_check",
      rawKey,
      status: "rejected",
    });
    rejectMessage(event, {
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressId,
      mailboxId,
      rawKey,
      reason: "mailbox_unprovisioned",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }
  if (mailboxProvisioned) {
    console.log("[mail-ingress] admission check completed", {
      durationMs: durationMs(runtime, admissionStartedAt),
      found: true,
      mailboxId,
      operation: "mailbox_admission_check",
      status: "succeeded",
      target: "r2",
    });
  }

  const admittedReceipt = await recordReceiptState(
    env,
    pointer,
    "admitted",
    archivedAt,
    runtime,
  );
  if (!admittedReceipt) {
    console.error(
      "[mail-ingress] handoff deferred until admission is durable",
      {
        errorCode: "ADMITTED_RECEIPT_UNAVAILABLE",
        ingressId,
        mailboxId,
        operation: "queue_enqueue",
        rawKey,
        recoveryAction: "operator_review",
        status: "preserved",
      },
    );
    return;
  }
  const enqueueStartedAt = runtime.now().getTime();
  try {
    await env.INBOUND_QUEUE.send(pointer);
  } catch (error) {
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, enqueueStartedAt),
      errorCode: "QUEUE_ENQUEUE_FAILED",
      errorMessage: errorMessage(error),
      ingressId,
      mailboxId,
      operation: "queue_enqueue",
      rawKey,
      recoveryAction: "scheduled_reconciliation",
      status: "deferred",
    });
    return;
  }
  await recordReceiptState(
    env,
    pointer,
    "enqueued",
    runtime.now().toISOString(),
    runtime,
    admittedReceipt.etag,
  );

  console.log("[mail-ingress] archive pointer enqueued", {
    durationMs: durationMs(runtime, enqueueStartedAt),
    ingressId,
    mailboxId,
    operation: "queue_enqueue",
    rawKey,
    status: "succeeded",
    target: "cloudflare_queue",
  });
  console.log("[mail-ingress] message archived and handed off", {
    durationMs: durationMs(runtime, handlerStartedAt),
    ingressId,
    mailboxId,
    operation: "inbound_receive",
    status: "succeeded",
  });
}
