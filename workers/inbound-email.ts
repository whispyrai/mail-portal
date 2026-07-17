// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
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
import { liveInboundProjectionOptions } from "./lib/live-inbound-projection.ts";
import type { DirectInboundAuthority } from "./lib/inbound-projection-contract.ts";
import { mailTelemetryLogRef } from "./lib/mail-telemetry.ts";
import {
  INBOUND_SMTP_REJECTION_ORIGIN,
  hasExactInboundSmtpRejectionAuthority,
  type InboundSmtpRejectionErrorCode,
} from "./lib/inbound-smtp-rejection.ts";
import {
  clearInboundActiveMarker,
  persistInboundActiveMarker,
} from "./lib/inbound-active-index.ts";
import { inboundRawArchiveKey } from "./lib/inbound-raw-key.ts";
import {
  beginEmergencyForward,
  commitIngressForwardAcceptance,
} from "./lib/emergency-forward.ts";

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

export function projectInboundArchivePointer(
  pointer: InboundArchivePointer,
): InboundArchivePointer {
  return {
    schemaVersion: pointer.schemaVersion,
    ingressId: pointer.ingressId,
    rawKey: pointer.rawKey,
    mailboxId: pointer.mailboxId,
    rawSize: pointer.rawSize,
    ...(pointer.rawSha256 === undefined
      ? {}
      : { rawSha256: pointer.rawSha256 }),
    archivedAt: pointer.archivedAt,
    etag: pointer.etag,
    version: pointer.version,
  };
}

type InboundEmailEvent = Pick<
  ForwardableEmailMessage,
  "forward" | "raw" | "rawSize" | "to" | "setReject"
>;

type InboundEnvironment = {
  BRAND?: string;
  DOMAINS: string;
  EMAIL_ADDRESSES?: string[];
  EMERGENCY_FORWARD_DESTINATION: string;
  DB: Pick<D1Database, "prepare">;
  BUCKET: EmailStorageDependencies["bucket"] & Pick<R2Bucket, "head">;
  RAW_MAIL_BUCKET: Pick<R2Bucket, "get" | "head" | "put"> &
    Partial<Pick<R2Bucket, "delete">>;
  INBOUND_QUEUE: Pick<Queue<InboundArchivePointer>, "send">;
  EMERGENCY_FORWARD_QUEUE: Pick<Queue, "send">;
  MAILBOX: {
    idFromName(mailboxId: string): unknown;
    get(id: unknown): EmailStorageDependencies["mailbox"];
  };
};

type IngressReceiptState = "archived" | "admitted" | "enqueued" | "rejected";

type InboundRuntime = {
  now(): Date;
  randomUUID(): string;
  random(): number;
  sleep(delayMs: number): Promise<void>;
  digestSha256(value: ArrayBuffer): Promise<ArrayBuffer>;
  bestEffortTimeoutMs: number;
  infrastructureTimeoutMs: number;
  providerTimeoutMs: number;
  telemetryLogRef(
    kind: "ingress" | "message" | "object",
    value: string,
  ): Promise<string>;
  parse?(raw: ArrayBuffer): Promise<Email>;
};

const defaultRuntime: InboundRuntime = {
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  random: () => Math.random(),
  sleep: (delayMs) => scheduler.wait(delayMs),
  digestSha256: (value) => crypto.subtle.digest("SHA-256", value),
  bestEffortTimeoutMs: 100,
  infrastructureTimeoutMs: 2_500,
  providerTimeoutMs: 10_000,
  telemetryLogRef: (kind, value) => mailTelemetryLogRef(kind, value),
};

const RAW_ARCHIVE_MAX_ATTEMPTS = 10;
const RAW_ARCHIVE_INITIAL_BACKOFF_MS = 100;
const RAW_ARCHIVE_MAX_BACKOFF_MS = 2_000;
const RECEIPT_MAX_ATTEMPTS = 10;
const RECEIPT_INITIAL_BACKOFF_MS = 50;
const RECEIPT_MAX_BACKOFF_MS = 1_000;
const ACTIVE_MARKER_MAX_ATTEMPTS = 10;

type DirectMailboxFallbackResult =
  | "stored"
  | "unprovisioned"
  | "unverified"
  | "failed";

function durationMs(runtime: InboundRuntime, startedAt: number): number {
  return Math.max(0, runtime.now().getTime() - startedAt);
}

function jitteredBackoff(maxDelayMs: number, runtime: InboundRuntime): number {
  const sample = runtime.random();
  const random = Number.isFinite(sample)
    ? Math.min(1, Math.max(0, sample))
    : 0.5;
  return Math.max(1, Math.floor(maxDelayMs * (0.5 + random * 0.5)));
}

async function withBoundaryDeadline<T>(
  work: () => PromiseLike<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Per Cloudflare Workers limits, individual service subrequests have no
    // fixed timeout. Bound every ingress boundary so one stalled dependency
    // cannot prevent the Email handler from forwarding or rejecting.
    // https://developers.cloudflare.com/workers/platform/limits/#subrequests
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function bestEffortMailTelemetryLogRef(
  runtime: InboundRuntime,
  kind: "ingress" | "message" | "object",
  value: string,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => runtime.telemetryLogRef(kind, value)),
      new Promise<string>((resolve) => {
        timeout = setTimeout(
          () => resolve("unavailable"),
          runtime.bestEffortTimeoutMs,
        );
      }),
    ]);
  } catch {
    return "unavailable";
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function rejectMessage(
  event: InboundEmailEvent,
  input: {
    errorCode: InboundSmtpRejectionErrorCode;
    smtpMessage: string;
  },
): void {
  console.error("[mail-ingress] permanent SMTP rejection requested", {
    errorCode: input.errorCode,
    operation: "smtp_rejection",
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

function rawArchiveMetadataMatches(
  object: R2Object,
  metadata: Record<string, string>,
): boolean {
  const actual = object.customMetadata ?? {};
  const expectedEntries = Object.entries(metadata).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const actualEntries = Object.entries(actual).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return (
    actualEntries.length === expectedEntries.length &&
    actualEntries.every(
      ([key, value], index) =>
        key === expectedEntries[index]?.[0] &&
        value === expectedEntries[index]?.[1],
    )
  );
}

async function readRawArchiveWinner(
  env: InboundEnvironment,
  rawKey: string,
  runtime: InboundRuntime,
): Promise<R2Object | null> {
  return withBoundaryDeadline(
    () => env.RAW_MAIL_BUCKET.head(rawKey),
    runtime.infrastructureTimeoutMs,
    "raw archive winner head",
  );
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
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  for (let attempt = 1; attempt <= RAW_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    let errorCode:
      | "RAW_ARCHIVE_CHECKSUM_MISMATCH"
      | "RAW_ARCHIVE_CHECKSUM_UNAVAILABLE"
      | "RAW_ARCHIVE_FAILED"
      | "RAW_ARCHIVE_SIZE_MISMATCH" = "RAW_ARCHIVE_FAILED";
    console.log("[mail-ingress] raw archive attempt started", {
      attempt,
      ingressRef,
      maxAttempts: RAW_ARCHIVE_MAX_ATTEMPTS,
      objectRef,
      operation: "raw_archive",
      status: "started",
      target: "r2",
    });
    try {
      const putResult = await withBoundaryDeadline(
        () =>
          env.RAW_MAIL_BUCKET.put(rawKey, rawBytes, {
            httpMetadata: { contentType: "message/rfc822" },
            customMetadata: metadata,
            onlyIf: { etagDoesNotMatch: "*" },
            sha256: rawSha256,
          }),
        runtime.infrastructureTimeoutMs,
        "raw archive put",
      );
      const archived =
        putResult ?? (await readRawArchiveWinner(env, rawKey, runtime));
      if (!archived) throw new Error("Raw email archive winner unavailable");
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
      if (!rawArchiveMetadataMatches(archived, metadata)) {
        errorCode = "RAW_ARCHIVE_CHECKSUM_MISMATCH";
        throw new Error("Raw email archive metadata mismatch");
      }
      console.log("[mail-ingress] raw archive persisted", {
        archivedSize: archived.size,
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "raw_archive",
        status: "succeeded",
        target: "r2",
      });
      return archived;
    } catch (error) {
      const finalAttempt = attempt === RAW_ARCHIVE_MAX_ATTEMPTS;
      console.error(
        "[mail-ingress] raw archive attempt completed",
        {
          attempt,
          durationMs: durationMs(runtime, startedAt),
          errorCode,
          ingressRef,
          maxAttempts: RAW_ARCHIVE_MAX_ATTEMPTS,
          objectRef,
          operation: "raw_archive",
          status: finalAttempt ? "failed" : "retrying",
        },
      );
      if (finalAttempt) throw error;

      const maxDelayMs = Math.min(
        RAW_ARCHIVE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RAW_ARCHIVE_MAX_BACKOFF_MS,
      );
      const delayMs = jitteredBackoff(maxDelayMs, runtime);
      console.log("[mail-ingress] raw archive retry scheduled", {
        attempt,
        delayMs,
        ingressRef,
        nextAttempt: attempt + 1,
        objectRef,
        operation: "raw_archive",
        status: "retrying",
      });
      await runtime.sleep(delayMs);
    }
  }
  throw new Error("Raw archive retry loop ended unexpectedly");
}

async function persistRawWithProviderChecksumRetry(
  env: InboundEnvironment,
  rawKey: string,
  rawBytes: ArrayBuffer,
  metadata: Record<string, string>,
  runtime: InboundRuntime,
): Promise<R2Object> {
  const startedAt = runtime.now().getTime();
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  for (let attempt = 1; attempt <= RAW_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    let errorCode:
      | "RAW_ARCHIVE_FAILED"
      | "RAW_ARCHIVE_PROVIDER_CHECKSUM_INVALID"
      | "RAW_ARCHIVE_SIZE_MISMATCH" = "RAW_ARCHIVE_FAILED";
    try {
      const putResult = await withBoundaryDeadline(
        () =>
          env.RAW_MAIL_BUCKET.put(rawKey, rawBytes, {
            httpMetadata: { contentType: "message/rfc822" },
            customMetadata: metadata,
            onlyIf: { etagDoesNotMatch: "*" },
          }),
        runtime.infrastructureTimeoutMs,
        "provider-checksummed raw archive put",
      );
      const archived =
        putResult ?? (await readRawArchiveWinner(env, rawKey, runtime));
      if (!archived) throw new Error("Raw email archive winner unavailable");
      if (archived.size !== rawBytes.byteLength) {
        errorCode = "RAW_ARCHIVE_SIZE_MISMATCH";
        throw new Error("Raw email archive size mismatch");
      }
      if (
        !(archived.checksums?.md5 instanceof ArrayBuffer) ||
        archived.checksums.md5.byteLength !== 16
      ) {
        errorCode = "RAW_ARCHIVE_PROVIDER_CHECKSUM_INVALID";
        throw new Error("Raw email archive provider checksum unavailable");
      }
      if (!rawArchiveMetadataMatches(archived, metadata)) {
        errorCode = "RAW_ARCHIVE_PROVIDER_CHECKSUM_INVALID";
        throw new Error("Raw email archive metadata mismatch");
      }
      console.log("[mail-ingress] raw archive persisted", {
        archivedSize: archived.size,
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "raw_archive",
        status: "succeeded",
        target: "r2",
      });
      return archived;
    } catch (error) {
      const finalAttempt = attempt === RAW_ARCHIVE_MAX_ATTEMPTS;
      console.error("[mail-ingress] raw archive fallback attempt completed", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        errorCode,
        ingressRef,
        maxAttempts: RAW_ARCHIVE_MAX_ATTEMPTS,
        objectRef,
        operation: "raw_archive",
        status: finalAttempt ? "failed" : "retrying",
      });
      if (finalAttempt) throw error;
      const maxDelayMs = Math.min(
        RAW_ARCHIVE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RAW_ARCHIVE_MAX_BACKOFF_MS,
      );
      await runtime.sleep(jitteredBackoff(maxDelayMs, runtime));
    }
  }
  throw new Error("Raw archive fallback retry loop ended unexpectedly");
}

async function upgradeProviderChecksummedRawToSha256WithRetry(
  env: InboundEnvironment,
  rawKey: string,
  rawBytes: ArrayBuffer,
  metadata: Record<string, string>,
  rawSha256: ArrayBuffer,
  rawSha256Hex: string,
  weakArchiveEtag: string,
  runtime: InboundRuntime,
): Promise<R2Object> {
  for (let attempt = 1; attempt <= RAW_ARCHIVE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const putResult = await withBoundaryDeadline(
        () =>
          env.RAW_MAIL_BUCKET.put(rawKey, rawBytes, {
            httpMetadata: { contentType: "message/rfc822" },
            customMetadata: metadata,
            onlyIf: { etagMatches: weakArchiveEtag },
            sha256: rawSha256,
          }),
        runtime.infrastructureTimeoutMs,
        "raw archive SHA-256 upgrade put",
      );
      const archived =
        putResult ?? (await readRawArchiveWinner(env, rawKey, runtime));
      if (
        archived &&
        archived.size === rawBytes.byteLength &&
        archived.checksums?.sha256 &&
        arrayBufferToHex(archived.checksums.sha256) === rawSha256Hex &&
        rawArchiveMetadataMatches(archived, metadata)
      ) {
        return archived;
      }
      throw new Error("Raw email SHA-256 upgrade winner is not exact");
    } catch (error) {
      if (attempt === RAW_ARCHIVE_MAX_ATTEMPTS) throw error;
      const maxDelayMs = Math.min(
        RAW_ARCHIVE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RAW_ARCHIVE_MAX_BACKOFF_MS,
      );
      await runtime.sleep(jitteredBackoff(maxDelayMs, runtime));
    }
  }
  throw new Error("Raw archive SHA-256 upgrade retry loop ended unexpectedly");
}

async function recordReceiptState(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  state: IngressReceiptState,
  updatedAt: string,
  runtime: InboundRuntime,
  onlyIfEtag?: string,
  details: {
    errorCode?: InboundSmtpRejectionErrorCode;
    rejectionOrigin?: typeof INBOUND_SMTP_REJECTION_ORIGIN;
  } = {},
): Promise<R2Object | null> {
  const startedAt = runtime.now().getTime();
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  for (let attempt = 1; attempt <= RECEIPT_MAX_ATTEMPTS; attempt += 1) {
    try {
      const receiptKey = `receipts/${pointer.ingressId}.json`;
      const receiptBody = JSON.stringify({
        ...projectInboundArchivePointer(pointer),
        state,
        updatedAt,
        ...details,
      });
      console.log("[mail-ingress] receipt write started", {
        attempt,
        ingressRef,
        maxAttempts: RECEIPT_MAX_ATTEMPTS,
        objectRef,
        operation: "receipt_write",
        state,
        status: "started",
        target: "r2",
      });
      const receipt = await withBoundaryDeadline(
        () =>
          onlyIfEtag
            ? env.RAW_MAIL_BUCKET.put(receiptKey, receiptBody, {
                httpMetadata: { contentType: "application/json" },
                customMetadata: { state },
                onlyIf: { etagMatches: onlyIfEtag },
              })
            : env.RAW_MAIL_BUCKET.put(receiptKey, receiptBody, {
                httpMetadata: { contentType: "application/json" },
                customMetadata: { state },
                onlyIf: { etagDoesNotMatch: "*" },
              }),
        runtime.infrastructureTimeoutMs,
        `${state} receipt put`,
      );
      if (!receipt) {
        console.log("[mail-ingress] receipt state superseded", {
          attempt,
          durationMs: durationMs(runtime, startedAt),
          ingressRef,
          objectRef,
          operation: "receipt_write",
          state,
          status: "superseded",
          target: "r2",
        });
        return null;
      }
      console.log("[mail-ingress] receipt state persisted", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "receipt_write",
        state,
        status: "succeeded",
        target: "r2",
      });
      return receipt;
    } catch {
      const finalAttempt = attempt === RECEIPT_MAX_ATTEMPTS;
      console.error("[mail-ingress] receipt write degraded", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        errorCode: "RECEIPT_WRITE_FAILED",
        ingressRef,
        maxAttempts: RECEIPT_MAX_ATTEMPTS,
        objectRef,
        operation: "receipt_write",
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

async function recordActiveMarkerWithRetry(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  runtime: InboundRuntime,
): Promise<boolean> {
  const startedAt = runtime.now().getTime();
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  for (let attempt = 1; attempt <= ACTIVE_MARKER_MAX_ATTEMPTS; attempt += 1) {
    try {
      await withBoundaryDeadline(
        () => persistInboundActiveMarker(env.RAW_MAIL_BUCKET, pointer),
        runtime.infrastructureTimeoutMs,
        "active recovery marker put",
      );
      console.log("[mail-ingress] active recovery marker persisted", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        objectRef,
        operation: "active_recovery_index_write",
        status: "succeeded",
        target: "r2",
      });
      return true;
    } catch {
      const finalAttempt = attempt === ACTIVE_MARKER_MAX_ATTEMPTS;
      console.error("[mail-ingress] active recovery marker write degraded", {
        attempt,
        durationMs: durationMs(runtime, startedAt),
        errorCode: "ACTIVE_RECOVERY_INDEX_WRITE_FAILED",
        ingressRef,
        maxAttempts: ACTIVE_MARKER_MAX_ATTEMPTS,
        objectRef,
        operation: "active_recovery_index_write",
        status: finalAttempt ? "failed" : "retrying",
      });
      if (finalAttempt) return false;
      const delayMs = Math.min(
        RECEIPT_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
        RECEIPT_MAX_BACKOFF_MS,
      );
      await runtime.sleep(delayMs);
    }
  }
  return false;
}

async function clearActiveMarkerBestEffort(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  runtime: InboundRuntime,
): Promise<void> {
  if (!env.RAW_MAIL_BUCKET.delete) return;
  try {
    await withBoundaryDeadline(
      () =>
        clearInboundActiveMarker(
          { delete: env.RAW_MAIL_BUCKET.delete!.bind(env.RAW_MAIL_BUCKET) },
          pointer.rawKey,
        ),
      runtime.infrastructureTimeoutMs,
      "active recovery marker delete",
    );
  } catch {
    const [ingressRef, objectRef] = await Promise.all([
      bestEffortMailTelemetryLogRef(runtime, "ingress", pointer.ingressId),
      bestEffortMailTelemetryLogRef(runtime, "object", pointer.rawKey),
    ]);
    console.error("[mail-ingress] terminal active marker cleanup degraded", {
      errorCode: "ACTIVE_RECOVERY_INDEX_DELETE_FAILED",
      ingressRef,
      objectRef,
      operation: "active_recovery_index_delete",
      recoveryAction: "scheduled_reconciliation",
      status: "degraded",
    });
  }
}

function exactRejectedReceiptMatches(
  value: unknown,
  pointer: InboundArchivePointer,
  errorCode: InboundSmtpRejectionErrorCode,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const expectedPointer = projectInboundArchivePointer(pointer);
  const allowedFields = new Set([
    ...Object.keys(expectedPointer),
    "state",
    "updatedAt",
    "errorCode",
    "rejectionOrigin",
  ]);
  if (
    !Object.keys(receipt).every((field) => allowedFields.has(field)) ||
    Object.keys(receipt).length !== allowedFields.size ||
    !hasExactInboundSmtpRejectionAuthority(receipt) ||
    receipt.errorCode !== errorCode ||
    typeof receipt.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.updatedAt)) ||
    new Date(receipt.updatedAt).toISOString() !== receipt.updatedAt
  ) {
    return false;
  }
  return Object.entries(expectedPointer).every(
    ([field, expected]) => receipt[field] === expected,
  );
}

async function readExactRejectedReceipt(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  errorCode: InboundSmtpRejectionErrorCode,
  runtime: InboundRuntime,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(async () => {
        const object = await env.RAW_MAIL_BUCKET.get(
          `receipts/${pointer.ingressId}.json`,
        );
        return object ? JSON.parse(await object.text()) : null;
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Rejected receipt readback timed out")),
          runtime.infrastructureTimeoutMs,
        );
      }),
    ]);
    return exactRejectedReceiptMatches(value, pointer, errorCode);
  } catch {
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function recordDurableRejection(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  archivedReceipt: R2Object,
  errorCode: InboundSmtpRejectionErrorCode,
  runtime: InboundRuntime,
): Promise<boolean> {
  await recordReceiptState(
    env,
    pointer,
    "rejected",
    runtime.now().toISOString(),
    runtime,
    archivedReceipt.etag,
    {
      errorCode,
      rejectionOrigin: INBOUND_SMTP_REJECTION_ORIGIN,
    },
  );
  if (await readExactRejectedReceipt(env, pointer, errorCode, runtime))
    return true;

  const [ingressRef, objectRef] = await Promise.all([
    bestEffortMailTelemetryLogRef(runtime, "ingress", pointer.ingressId),
    bestEffortMailTelemetryLogRef(runtime, "object", pointer.rawKey),
  ]);
  console.error("[mail-ingress] rejection receipt unavailable", {
    errorCode: "REJECTION_RECEIPT_AUTHORITY_UNAVAILABLE",
    ingressRef,
    objectRef,
    operation: "smtp_rejection",
    recoveryAction: "scheduled_reconciliation",
    status: "degraded",
  });
  return false;
}

async function establishPostArchiveEmergencyAuthority(
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  runtime: InboundRuntime,
): Promise<boolean> {
  const established = await boundedAuthorityRead(
    beginEmergencyForward(
      {
        RAW_MAIL_BUCKET: env.RAW_MAIL_BUCKET,
        EMERGENCY_FORWARD_QUEUE: env.EMERGENCY_FORWARD_QUEUE,
      },
      pointer,
      "INGRESS_RECOVERY_REQUIRED",
      runtime,
    ).then(() => true),
    runtime,
  );
  if (established === true) return true;

  console.error("[mail-ingress] automatic emergency authority degraded", {
    errorCode: "EMERGENCY_FORWARD_AUTHORITY_UNAVAILABLE",
    operation: "emergency_forward_admission",
    recoveryAction: "provider_forward_then_smtp_rejection",
    status: "degraded",
  });
  return false;
}

async function rejectOnlyWithDurableAuthority(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  pointer: InboundArchivePointer,
  archivedReceipt: R2Object,
  errorCode: InboundSmtpRejectionErrorCode,
  smtpMessage: string,
  runtime: InboundRuntime,
): Promise<boolean> {
  rejectMessage(event, { errorCode, smtpMessage });
  const authoritative = await recordDurableRejection(
    env,
    pointer,
    archivedReceipt,
    errorCode,
    runtime,
  );
  if (!authoritative) {
    await establishPostArchiveEmergencyAuthority(env, pointer, runtime);
    return true;
  }
  await clearActiveMarkerBestEffort(env, pointer, runtime);
  return true;
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

async function isActiveMailbox(
  env: Pick<InboundEnvironment, "DB">,
  mailboxId: string,
  runtime: InboundRuntime,
): Promise<boolean> {
  const mailbox = await withBoundaryDeadline(
    () =>
      env.DB.prepare(
        "SELECT id FROM mailboxes WHERE id = ?1 AND is_active = 1 LIMIT 1",
      )
        .bind(mailboxId)
        .first<{ id: string }>(),
    runtime.infrastructureTimeoutMs,
    "active mailbox lookup",
  );
  return Boolean(mailbox);
}

function exactArchiveAuthority(
  pointer: InboundArchivePointer | undefined,
) {
  return pointer?.rawSha256 === undefined
    ? null
    : {
        ...projectInboundArchivePointer(pointer),
        rawSha256: pointer.rawSha256,
      };
}

function directInboundAuthority(input: {
  ingressId: string;
  mailboxId: string;
  rawSize: number;
  rawSha256: string;
  receivedAt: string;
}): DirectInboundAuthority {
  return {
    schemaVersion: INBOUND_RECEIPT_SCHEMA_VERSION,
    ingressId: input.ingressId,
    mailboxId: input.mailboxId,
    rawSize: input.rawSize,
    rawSha256: input.rawSha256,
    receivedAt: input.receivedAt,
  };
}

function directInboundAuthorityForFallback(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  rawBytes: ArrayBuffer,
  ingressId: string,
  receivedAt: string,
  rawSha256: string,
): DirectInboundAuthority | undefined {
  const mailboxId = admittedMailboxId(event, env, rawBytes.byteLength);
  if (!mailboxId) return undefined;
  return directInboundAuthority({
    ingressId,
    mailboxId,
    rawSize: rawBytes.byteLength,
    rawSha256,
    receivedAt,
  });
}

async function retryRawSha256(
  rawBytes: ArrayBuffer,
  runtime: InboundRuntime,
): Promise<{ digest: ArrayBuffer; hex: string } | null> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const digest = await withBoundaryDeadline(
        () => runtime.digestSha256(rawBytes),
        runtime.infrastructureTimeoutMs,
        "raw SHA-256 digest retry",
      );
      return { digest, hex: arrayBufferToHex(digest) };
    } catch {
      if (attempt < 2) await runtime.sleep(25 * attempt);
    }
  }
  return null;
}

async function boundedAuthorityRead<T>(
  work: Promise<T>,
  runtime: InboundRuntime,
): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Mailbox authority read timed out")),
          runtime.infrastructureTimeoutMs,
        );
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function hasExactArchiveDeletionAuthority(
  mailbox: EmailStorageDependencies["mailbox"],
  pointer: InboundArchivePointer | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  const authority = exactArchiveAuthority(pointer);
  if (!authority || !mailbox.getInboundDeletionAuthority) return false;
  const value = await boundedAuthorityRead(
    mailbox.getInboundDeletionAuthority(authority),
    runtime,
  );
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") ===
        ["deletedAt", "generation"].sort().join("\0") &&
      Number.isSafeInteger(value.generation) &&
      value.generation >= 2 &&
      typeof value.deletedAt === "string" &&
      Number.isFinite(Date.parse(value.deletedAt)) &&
      new Date(value.deletedAt).toISOString() === value.deletedAt,
  );
}

async function hasExactArchiveProjectionAuthority(
  mailbox: EmailStorageDependencies["mailbox"],
  pointer: InboundArchivePointer | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  const authority = exactArchiveAuthority(pointer);
  if (!authority || !mailbox.getInboundProjectionAuthority) return false;
  const value = await boundedAuthorityRead(
    mailbox.getInboundProjectionAuthority(authority),
    runtime,
  );
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      value.generation === 1,
  );
}

async function hasExactDirectDeletionAuthority(
  mailbox: EmailStorageDependencies["mailbox"],
  authority: DirectInboundAuthority | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  if (!authority || !mailbox.getDirectInboundDeletionAuthority) return false;
  const value = await boundedAuthorityRead(
    mailbox.getDirectInboundDeletionAuthority(authority),
    runtime,
  );
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("\0") ===
        ["deletedAt", "generation"].sort().join("\0") &&
      Number.isSafeInteger(value.generation) &&
      value.generation >= 2 &&
      typeof value.deletedAt === "string" &&
      Number.isFinite(Date.parse(value.deletedAt)) &&
      new Date(value.deletedAt).toISOString() === value.deletedAt,
  );
}

async function hasExactDirectProjectionAuthority(
  mailbox: EmailStorageDependencies["mailbox"],
  authority: DirectInboundAuthority | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  if (!authority || !mailbox.getDirectInboundProjectionAuthority) return false;
  const value = await boundedAuthorityRead(
    mailbox.getDirectInboundProjectionAuthority(authority),
    runtime,
  );
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      value.generation === 1,
  );
}

async function hasExactFallbackDeletionAuthority(
  mailbox: EmailStorageDependencies["mailbox"],
  archiveAuthority: InboundArchivePointer | undefined,
  directAuthority: DirectInboundAuthority | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  return (
    (await hasExactArchiveDeletionAuthority(
      mailbox,
      archiveAuthority,
      runtime,
    )) ||
    (await hasExactDirectDeletionAuthority(
      mailbox,
      directAuthority,
      runtime,
    ))
  );
}

async function exactFallbackDeletionIsTerminal(
  env: Pick<InboundEnvironment, "MAILBOX">,
  mailboxId: string,
  archiveAuthority: InboundArchivePointer | undefined,
  directAuthority: DirectInboundAuthority | undefined,
  runtime: InboundRuntime,
): Promise<boolean> {
  try {
    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
    return hasExactFallbackDeletionAuthority(
      mailbox,
      archiveAuthority,
      directAuthority,
      runtime,
    );
  } catch {
    return false;
  }
}

async function storeDirectlyInMailbox(
  mailboxId: string,
  rawBytes: ArrayBuffer,
  ingressId: string,
  receivedAt: string,
  env: InboundEnvironment,
  runtime: InboundRuntime,
  archiveAuthority?: InboundArchivePointer,
  directAuthority?: DirectInboundAuthority,
): Promise<DirectMailboxFallbackResult> {
  const startedAt = runtime.now().getTime();
  const ingressRef = "unavailable";
  if (
    (archiveAuthority === undefined) === (directAuthority === undefined) ||
    (archiveAuthority !== undefined &&
      exactArchiveAuthority(archiveAuthority) === null)
  ) {
    return "unverified";
  }
  console.log("[mail-ingress] direct mailbox fallback started", {
    ingressRef,
    operation: "direct_mailbox_fallback",
    status: "started",
    target: "durable_object",
  });
  let marker: unknown | null;
  try {
    marker = await withBoundaryDeadline(
      () => env.BUCKET.head(`mailboxes/${mailboxId}.json`),
      runtime.infrastructureTimeoutMs,
      "mailbox marker head",
    );
  } catch {
    console.error(
      "[mail-ingress] direct mailbox fallback could not verify recipient",
      {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "MAILBOX_VERIFICATION_FAILED",
        ingressRef,
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
      ingressRef,
      operation: "direct_mailbox_fallback",
      status: "unprovisioned",
    });
    return "unprovisioned";
  }
  try {
    if (!(await isActiveMailbox(env, mailboxId, runtime))) {
      console.error("[mail-ingress] direct mailbox fallback unavailable", {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "MAILBOX_INACTIVE",
        ingressRef,
        operation: "direct_mailbox_fallback",
        status: "unprovisioned",
      });
      return "unprovisioned";
    }
  } catch {
    console.error(
      "[mail-ingress] direct mailbox fallback could not verify active state",
      {
        durationMs: durationMs(runtime, startedAt),
        errorCode: "MAILBOX_ACTIVE_CHECK_FAILED",
        ingressRef,
        operation: "direct_mailbox_fallback",
        status: "unverified",
      },
    );
    return "unverified";
  }

  let mailboxForRecovery: EmailStorageDependencies["mailbox"] | undefined;
  try {
    const mailbox = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));
    mailboxForRecovery = mailbox;
    if (
      await hasExactFallbackDeletionAuthority(
        mailbox,
        archiveAuthority,
        directAuthority,
        runtime,
      )
    ) {
      console.log("[mail-ingress] deleted projection remains suppressed", {
        durationMs: durationMs(runtime, startedAt),
        ingressRef,
        operation: "direct_mailbox_fallback",
        status: "deleted",
      });
      return "stored";
    }
    if (
      (archiveAuthority || directAuthority) &&
      mailbox.isEmailDeleted &&
      (await withBoundaryDeadline(
        () => mailbox.isEmailDeleted!(ingressId),
        runtime.infrastructureTimeoutMs,
        "mailbox tombstone lookup",
      ))
    ) {
      return "unverified";
    }
    const existing = await withBoundaryDeadline(
      () => emailExists(mailbox, ingressId),
      runtime.infrastructureTimeoutMs,
      "mailbox projection lookup",
    );
    if (
      existing &&
      archiveAuthority &&
      !(await hasExactArchiveProjectionAuthority(
        mailbox,
        archiveAuthority,
        runtime,
      ))
    ) {
      if (
        await hasExactFallbackDeletionAuthority(
          mailbox,
          archiveAuthority,
          directAuthority,
          runtime,
        )
      ) {
        return "stored";
      }
      return "unverified";
    }
    if (
      existing &&
      directAuthority &&
      !(await hasExactDirectProjectionAuthority(
        mailbox,
        directAuthority,
        runtime,
      ))
    ) {
      if (
        await hasExactFallbackDeletionAuthority(
          mailbox,
          archiveAuthority,
          directAuthority,
          runtime,
        )
      ) {
        return "stored";
      }
      return "unverified";
    }
    if (!existing) {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          if (!(await isActiveMailbox(env, mailboxId, runtime))) {
            console.error("[mail-ingress] direct mailbox fallback unavailable", {
              attempt,
              durationMs: durationMs(runtime, startedAt),
              errorCode: "MAILBOX_INACTIVE",
              ingressRef,
              operation: "direct_mailbox_fallback",
              status: "unprovisioned",
            });
            return "unprovisioned";
          }
        } catch {
          console.error(
            "[mail-ingress] direct mailbox fallback could not reverify active state",
            {
              attempt,
              durationMs: durationMs(runtime, startedAt),
              errorCode: "MAILBOX_ACTIVE_RECHECK_FAILED",
              ingressRef,
              operation: "direct_mailbox_fallback",
              status: "unverified",
            },
          );
          return "unverified";
        }
        try {
          // Test seam only. Production omits parse so normal delivery uses the streamed path.
          if (runtime.parse) {
            const parsed = await withBoundaryDeadline(
              () => runtime.parse!(rawBytes),
              runtime.infrastructureTimeoutMs,
              "MIME parse",
            );
            await withBoundaryDeadline(
              () =>
                storeParsedEmail(
                  { bucket: env.BUCKET, mailbox },
                  parsed,
                  liveInboundProjectionOptions({
                    brand: env.BRAND,
                    mailboxId,
                    messageId: ingressId,
                    date: receivedAt,
                    projectionExpiresAt:
                      Date.now() + runtime.infrastructureTimeoutMs,
                    ...(directAuthority === undefined
                      ? {}
                      : { directAuthority }),
                    ...(archiveAuthority?.rawSha256 === undefined
                      ? {}
                      : {
                          archiveAuthority: {
                            ...projectInboundArchivePointer(archiveAuthority),
                            rawSha256: archiveAuthority.rawSha256,
                          },
                        }),
                  }),
                ),
              runtime.infrastructureTimeoutMs,
              "direct mailbox projection",
            );
          } else {
            await withBoundaryDeadline(
              () =>
                storeStreamingEmail(
                  { bucket: env.BUCKET, mailbox },
                  replayStream(rawBytes),
                  liveInboundProjectionOptions({
                    brand: env.BRAND,
                    mailboxId,
                    messageId: ingressId,
                    date: receivedAt,
                    projectionExpiresAt:
                      Date.now() + runtime.infrastructureTimeoutMs,
                    ...(directAuthority === undefined
                      ? {}
                      : { directAuthority }),
                    ...(archiveAuthority?.rawSha256 === undefined
                      ? {}
                      : {
                          archiveAuthority: {
                            ...projectInboundArchivePointer(archiveAuthority),
                            rawSha256: archiveAuthority.rawSha256,
                          },
                        }),
                  }),
                  env.RAW_MAIL_BUCKET,
                ),
              runtime.infrastructureTimeoutMs,
              "streaming direct mailbox projection",
            );
          }
          break;
        } catch (error) {
          if (
            await hasExactFallbackDeletionAuthority(
              mailbox,
              archiveAuthority,
              directAuthority,
              runtime,
            )
          ) {
            return "stored";
          }
          const committed =
            (await boundedAuthorityRead(
              emailExists(mailbox, ingressId),
              runtime,
            )) === true;
          if (committed) {
            if (
              archiveAuthority &&
              !(await hasExactArchiveProjectionAuthority(
                mailbox,
                archiveAuthority,
                runtime,
              ))
            ) {
              if (
                await hasExactFallbackDeletionAuthority(
                  mailbox,
                  archiveAuthority,
                  directAuthority,
                  runtime,
                )
              ) {
                return "stored";
              }
              return "unverified";
            }
            if (
              directAuthority &&
              !(await hasExactDirectProjectionAuthority(
                mailbox,
                directAuthority,
                runtime,
              ))
            ) {
              if (
                await hasExactFallbackDeletionAuthority(
                  mailbox,
                  archiveAuthority,
                  directAuthority,
                  runtime,
                )
              ) {
                return "stored";
              }
              return "unverified";
            }
            console.log(
              "[mail-ingress] direct mailbox ambiguous commit recovered",
              {
                durationMs: durationMs(runtime, startedAt),
                ingressRef,
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
              ingressRef,
              maxAttempts: 3,
              operation: "direct_mailbox_fallback",
              status: "retrying",
            },
          );
          await runtime.sleep(delayMs);
        }
      }
    }

    if (
      await hasExactFallbackDeletionAuthority(
        mailbox,
        archiveAuthority,
        directAuthority,
        runtime,
      )
    ) {
      return "stored";
    }
    if (
      archiveAuthority &&
      !(await hasExactArchiveProjectionAuthority(
        mailbox,
        archiveAuthority,
        runtime,
      ))
    ) {
      return "unverified";
    }
    if (
      directAuthority &&
      !(await hasExactDirectProjectionAuthority(
        mailbox,
        directAuthority,
        runtime,
      ))
    ) {
      return "unverified";
    }
    console.log("[mail-ingress] direct mailbox fallback completed", {
      durationMs: durationMs(runtime, startedAt),
      ingressRef,
      operation: "direct_mailbox_fallback",
      status: existing ? "duplicate" : "succeeded",
      target: "durable_object",
    });
    return "stored";
  } catch {
    if (
      mailboxForRecovery &&
      (await hasExactFallbackDeletionAuthority(
        mailboxForRecovery,
        archiveAuthority,
        directAuthority,
        runtime,
      ))
    ) {
      return "stored";
    }
    console.error("[mail-ingress] direct mailbox fallback failed", {
      durationMs: durationMs(runtime, startedAt),
      errorCode: "DIRECT_MAILBOX_FALLBACK_FAILED",
      ingressRef,
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
  rawKey: string,
  runtime: InboundRuntime,
  pointer?: InboundArchivePointer,
): Promise<void> {
  const forwardStartedAt = runtime.now().getTime();
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  console.log("[mail-ingress] emergency forwarding started", {
    ingressRef,
    objectRef,
    operation: "emergency_forward",
    status: "started",
    target: "verified_destination",
  });
  let providerMessageId: string;
  try {
    const result = await withBoundaryDeadline(
      () => event.forward(env.EMERGENCY_FORWARD_DESTINATION),
      runtime.providerTimeoutMs,
      "provider emergency forward",
    );
    const untrustedResult: unknown = result;
    if (
      !untrustedResult ||
      typeof untrustedResult !== "object" ||
      Array.isArray(untrustedResult) ||
      !("messageId" in untrustedResult) ||
      typeof untrustedResult.messageId !== "string" ||
      untrustedResult.messageId.trim().length === 0
    ) {
      throw new Error("Emergency forwarding returned an invalid result");
    }
    providerMessageId = untrustedResult.messageId;
  } catch {
    console.error("[mail-ingress] emergency forwarding failed", {
      durationMs: durationMs(runtime, forwardStartedAt),
      errorCode: "EMERGENCY_FORWARD_FAILED",
      ingressRef,
      objectRef,
      operation: "emergency_forward",
      status: "failed",
    });
    if (pointer) {
      if (await establishPostArchiveEmergencyAuthority(env, pointer, runtime))
        return;
    }
    rejectMessage(event, {
      errorCode: "ALL_DURABILITY_PATHS_FAILED",
      smtpMessage: "Message could not be stored; please resend later",
    });
    return;
  }

  let durableAcceptance = false;
  if (pointer) {
    try {
      durableAcceptance = await withBoundaryDeadline(
        () =>
          commitIngressForwardAcceptance(
            env,
            pointer,
            providerMessageId,
            runtime,
          ),
        runtime.infrastructureTimeoutMs,
        "forward acceptance commit",
      );
    } catch {
      // Provider acceptance without durable local authority is an
      // at-least-once ambiguity. Raw and active recovery stay intact so a
      // later pass cannot miss the message.
    }
    if (durableAcceptance) {
      await clearActiveMarkerBestEffort(env, pointer, runtime);
    }
  }
  const messageRef = await bestEffortMailTelemetryLogRef(
    runtime,
    "message",
    providerMessageId,
  );
  if (pointer && !durableAcceptance) {
    console.error("[mail-ingress] forward acceptance persistence degraded", {
      errorCode: "FORWARD_ACCEPTANCE_AUTHORITY_UNAVAILABLE",
      ingressRef,
      messageRef,
      objectRef,
      operation: "emergency_forward",
      recoveryAction: "scheduled_reconciliation",
      status: "degraded",
    });
  }
  console.log("[mail-ingress] emergency forwarding completed", {
    durationMs: durationMs(runtime, forwardStartedAt),
    ingressRef,
    messageRef,
    objectRef,
    operation: "emergency_forward",
    status: "succeeded",
    target: "verified_destination",
  });
}

async function recoverWithDirectMailboxOrSmtpAction(
  event: InboundEmailEvent,
  env: InboundEnvironment,
  rawBytes: ArrayBuffer,
  ingressId: string,
  receivedAt: string,
  rawKey: string,
  runtime: InboundRuntime,
  pointer?: InboundArchivePointer,
  directAuthority?: DirectInboundAuthority,
): Promise<void> {
  const mailboxId = admittedMailboxId(event, env, rawBytes.byteLength);
  if (!mailboxId) {
    const ingressRef = "unavailable";
    const objectRef = "unavailable";
    console.error("[mail-ingress] fallback admission rejected", {
      errorCode: "FALLBACK_RECIPIENT_OR_SIZE_INVALID",
      ingressRef,
      objectRef,
      operation: "fallback_admission",
      status: pointer || directAuthority ? "forward_pending" : "rejected",
    });
    if (pointer) {
      if (await establishPostArchiveEmergencyAuthority(env, pointer, runtime))
        return;
      await forwardEmergencyOrReject(
        event,
        env,
        ingressId,
        rawKey,
        runtime,
        pointer,
      );
      return;
    }
    if (directAuthority) {
      await forwardEmergencyOrReject(
        event,
        env,
        ingressId,
        rawKey,
        runtime,
      );
      return;
    }
    rejectMessage(event, {
      errorCode: "FALLBACK_RECIPIENT_OR_SIZE_INVALID",
      smtpMessage: "Mailbox unavailable",
    });
    return;
  }

  if (!pointer && !directAuthority) {
    await forwardEmergencyOrReject(event, env, ingressId, rawKey, runtime);
    return;
  }

  const directResult = await storeDirectlyInMailbox(
    mailboxId,
    rawBytes,
    ingressId,
    receivedAt,
    env,
    runtime,
    pointer,
    directAuthority,
  );
  if (directResult === "stored") return;
  if (
    await exactFallbackDeletionIsTerminal(
      env,
      mailboxId,
      pointer,
      directAuthority,
      runtime,
    )
  ) {
    return;
  }
  if (directResult === "unprovisioned") {
    if (pointer) {
      if (await establishPostArchiveEmergencyAuthority(env, pointer, runtime))
        return;
      await forwardEmergencyOrReject(
        event,
        env,
        ingressId,
        rawKey,
        runtime,
        pointer,
      );
      return;
    }
    await forwardEmergencyOrReject(event, env, ingressId, rawKey, runtime);
    return;
  }

  await forwardEmergencyOrReject(
    event,
    env,
    ingressId,
    rawKey,
    runtime,
    pointer,
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
  const rawKey = inboundRawArchiveKey(archivedAtDate, ingressId);
  const envelopeRecipient = event.to.trim().toLowerCase();
  const ingressRef = "unavailable";
  const objectRef = "unavailable";
  console.log("[mail-ingress] inbound receive started", {
    declaredRawSize: event.rawSize,
    ingressRef,
    objectRef,
    operation: "inbound_receive",
    status: "started",
  });
  let rawBytes: ArrayBuffer;
  const rawReadStartedAt = runtime.now().getTime();
  console.log("[mail-ingress] raw stream read started", {
    ingressRef,
    objectRef,
    operation: "raw_stream_read",
    status: "started",
  });
  try {
    rawBytes = await withBoundaryDeadline(
      () => new Response(event.raw).arrayBuffer(),
      runtime.infrastructureTimeoutMs,
      "raw stream read",
    );
    console.log("[mail-ingress] raw stream read completed", {
      durationMs: durationMs(runtime, rawReadStartedAt),
      ingressRef,
      objectRef,
      operation: "raw_stream_read",
      rawSize: rawBytes.byteLength,
      status: "succeeded",
    });
  } catch {
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_STREAM_READ_FAILED",
      ingressRef,
      objectRef,
      operation: "raw_stream_read",
      status: "failed",
    });
    const mailboxId = envelopeMailboxId(event, env);
    if (!mailboxId) {
      rejectMessage(event, {
        errorCode: "FALLBACK_RECIPIENT_INVALID",
        smtpMessage: "Mailbox unavailable",
      });
      return;
    }
    const admissionStartedAt = runtime.now().getTime();
    console.log("[mail-ingress] emergency forward admission started", {
      ingressRef,
      objectRef,
      operation: "emergency_forward_admission",
      status: "started",
      target: "r2",
    });
    let mailboxExists: boolean;
    try {
      mailboxExists = Boolean(
        await withBoundaryDeadline(
          () => env.BUCKET.head(`mailboxes/${mailboxId}.json`),
          runtime.infrastructureTimeoutMs,
          "unreadable-message mailbox marker head",
        ),
      );
      console.log("[mail-ingress] emergency forward admission completed", {
        durationMs: durationMs(runtime, admissionStartedAt),
        found: mailboxExists,
        ingressRef,
        objectRef,
        operation: "emergency_forward_admission",
        status: "succeeded",
        target: "r2",
      });
    } catch {
      console.error(
        "[mail-ingress] unreadable message recipient could not be verified",
        {
          durationMs: durationMs(runtime, admissionStartedAt),
          errorCode: "MAILBOX_VERIFICATION_FAILED",
          ingressRef,
          objectRef,
          operation: "emergency_forward_admission",
          status: "failed",
          target: "r2",
        },
      );
      await forwardEmergencyOrReject(event, env, ingressId, rawKey, runtime);
      return;
    }
    if (!mailboxExists) {
      rejectMessage(event, {
        errorCode: "MAILBOX_UNAVAILABLE",
        smtpMessage: "Mailbox unavailable",
      });
      return;
    }
    console.log("[mail-ingress] emergency forward admission started", {
      ingressRef,
      objectRef,
      operation: "emergency_forward_admission",
      status: "started",
      target: "d1",
    });
    let mailboxActive: boolean;
    try {
      mailboxActive = await isActiveMailbox(env, mailboxId, runtime);
      console.log("[mail-ingress] emergency forward admission completed", {
        durationMs: durationMs(runtime, admissionStartedAt),
        ingressRef,
        objectRef,
        operation: "emergency_forward_admission",
        status: "succeeded",
        target: "d1",
      });
    } catch {
      console.error(
        "[mail-ingress] unreadable message recipient could not be verified",
        {
          durationMs: durationMs(runtime, admissionStartedAt),
          errorCode: "MAILBOX_VERIFICATION_FAILED",
          ingressRef,
          objectRef,
          operation: "emergency_forward_admission",
          status: "failed",
          target: "d1",
        },
      );
      await forwardEmergencyOrReject(event, env, ingressId, rawKey, runtime);
      return;
    }
    if (!mailboxActive) {
      rejectMessage(event, {
        errorCode: "MAILBOX_INACTIVE",
        smtpMessage: "Mailbox unavailable",
      });
      return;
    }
    await forwardEmergencyOrReject(
      event,
      env,
      ingressId,
      rawKey,
      runtime,
    );
    return;
  }

  let rawSha256: ArrayBuffer | undefined;
  let rawSha256Hex: string | undefined;
  let archived: R2Object;
  let archiveRequiresEmergencyForward = false;
  const checksumStartedAt = runtime.now().getTime();
  console.log("[mail-ingress] raw archive checksum started", {
    ingressRef,
    objectRef,
    operation: "raw_archive_checksum",
    status: "started",
  });
  try {
    rawSha256 = await withBoundaryDeadline(
      () => runtime.digestSha256(rawBytes),
      runtime.infrastructureTimeoutMs,
      "raw SHA-256 digest",
    );
    rawSha256Hex = arrayBufferToHex(rawSha256);
    console.log("[mail-ingress] raw archive checksum completed", {
      durationMs: durationMs(runtime, checksumStartedAt),
      ingressRef,
      objectRef,
      operation: "raw_archive_checksum",
      status: "succeeded",
    });
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
    if (rawSha256 !== undefined && rawSha256Hex !== undefined) {
      await recoverWithDirectMailboxOrSmtpAction(
        event,
        env,
        rawBytes,
        ingressId,
        archivedAt,
        rawKey,
        runtime,
        undefined,
        directInboundAuthorityForFallback(
          event,
          env,
          rawBytes,
          ingressId,
          archivedAt,
          rawSha256Hex,
        ),
      );
      return;
    }
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED",
      ingressRef,
      objectRef,
      operation: "raw_archive_checksum",
      status: "failed",
    });
    try {
      archived = await persistRawWithProviderChecksumRetry(
        env,
        rawKey,
        rawBytes,
        {
          archivedAt,
          declaredRawSize: String(event.rawSize),
          ingressId,
          mailboxId: envelopeRecipient,
          rawSize: String(rawBytes.byteLength),
          schemaVersion: String(INBOUND_RECEIPT_SCHEMA_VERSION),
        },
        runtime,
      );
    } catch {
      const retriedDigest = await retryRawSha256(rawBytes, runtime);
      if (retriedDigest) {
        rawSha256 = retriedDigest.digest;
        rawSha256Hex = retriedDigest.hex;
      }
      await recoverWithDirectMailboxOrSmtpAction(
        event,
        env,
        rawBytes,
        ingressId,
        archivedAt,
        rawKey,
        runtime,
        undefined,
        rawSha256Hex === undefined
          ? undefined
          : directInboundAuthorityForFallback(
              event,
              env,
              rawBytes,
              ingressId,
              archivedAt,
              rawSha256Hex,
            ),
      );
      return;
    }
    const retriedDigest = await retryRawSha256(rawBytes, runtime);
    if (retriedDigest) {
      rawSha256 = retriedDigest.digest;
      rawSha256Hex = retriedDigest.hex;
    }
    if (rawSha256 !== undefined && rawSha256Hex !== undefined) {
      try {
        archived = await upgradeProviderChecksummedRawToSha256WithRetry(
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
          archived.etag,
          runtime,
        );
      } catch {
        await recoverWithDirectMailboxOrSmtpAction(
          event,
          env,
          rawBytes,
          ingressId,
          archivedAt,
          rawKey,
          runtime,
          undefined,
          directInboundAuthorityForFallback(
            event,
            env,
            rawBytes,
            ingressId,
            archivedAt,
            rawSha256Hex,
          ),
        );
        return;
      }
    } else {
      archiveRequiresEmergencyForward = true;
    }
  }

  if (archiveRequiresEmergencyForward) {
    await forwardEmergencyOrReject(event, env, ingressId, rawKey, runtime);
    return;
  }
  const mailboxId = normalizeMailAddress(event.to);
  const pointer: InboundArchivePointer = {
    schemaVersion: INBOUND_RECEIPT_SCHEMA_VERSION,
    ingressId,
    rawKey,
    mailboxId: mailboxId ?? envelopeRecipient,
    rawSize: rawBytes.byteLength,
    ...(rawSha256Hex === undefined ? {} : { rawSha256: rawSha256Hex }),
    archivedAt,
    etag: archived.etag,
    version: archived.version,
  };
  console.log("[mail-ingress] message archived before admission", {
    declaredRawSize: event.rawSize,
    durationMs: durationMs(runtime, handlerStartedAt),
    ingressRef,
    objectRef,
    operation: "inbound_receive",
    rawSize: rawBytes.byteLength,
    status: "archived",
  });
  if (!(await recordActiveMarkerWithRetry(env, pointer, runtime))) {
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
    return;
  }
  const archivedReceipt = await recordReceiptState(
    env,
    pointer,
    "archived",
    archivedAt,
    runtime,
  );
  if (!archivedReceipt) {
    console.error("[mail-ingress] archived receipt unavailable", {
      errorCode: "ARCHIVED_RECEIPT_UNAVAILABLE",
      ingressRef,
      objectRef,
      operation: "receipt_write",
      recoveryAction: "scheduled_reconciliation",
      status: "preserved",
    });
    // Cloudflare Email handlers must explicitly forward or reject when durable
    // processing cannot complete; a verified Mailbox projection is also durable.
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
    return;
  }
  if (!mailboxId || !isAddressInConfiguredMailDomains(mailboxId, env.DOMAINS)) {
    const rejected = await rejectOnlyWithDurableAuthority(
      event,
      env,
      pointer,
      archivedReceipt,
      "RECIPIENT_DOMAIN_INVALID",
      "Mailbox unavailable",
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RECIPIENT_DOMAIN_INVALID",
      ingressRef,
      objectRef,
      operation: "envelope_admission",
      status: rejected ? "rejected" : "forward_pending",
    });
    return;
  }

  const allowedAddresses = (env.EMAIL_ADDRESSES ?? []).map((address) =>
    address.toLowerCase(),
  );
  if (allowedAddresses.length > 0 && !allowedAddresses.includes(mailboxId)) {
    const rejected = await rejectOnlyWithDurableAuthority(
      event,
      env,
      pointer,
      archivedReceipt,
      "RECIPIENT_NOT_ALLOWED",
      "Mailbox unavailable",
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RECIPIENT_NOT_ALLOWED",
      ingressRef,
      objectRef,
      operation: "envelope_admission",
      status: rejected ? "rejected" : "forward_pending",
    });
    return;
  }

  if (
    rawBytes.byteLength <= 0 ||
    rawBytes.byteLength > MAX_EMAIL_SIZE ||
    event.rawSize !== rawBytes.byteLength
  ) {
    const rejected = await rejectOnlyWithDurableAuthority(
      event,
      env,
      pointer,
      archivedReceipt,
      "RAW_SIZE_INVALID",
      "Message size unavailable",
      runtime,
    );
    console.error("[mail-ingress] message rejected", {
      actualRawSize: rawBytes.byteLength,
      declaredRawSize: event.rawSize,
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "RAW_SIZE_INVALID",
      ingressRef,
      objectRef,
      operation: "envelope_admission",
      status: rejected ? "rejected" : "forward_pending",
    });
    return;
  }

  let mailboxProvisioned: boolean | undefined;
  const admissionStartedAt = runtime.now().getTime();
  console.log("[mail-ingress] admission check started", {
    ingressRef,
    objectRef,
    operation: "mailbox_admission_check",
    status: "started",
    target: "r2",
  });
  try {
    mailboxProvisioned = Boolean(
      await withBoundaryDeadline(
        () => env.BUCKET.head(`mailboxes/${mailboxId}.json`),
        runtime.infrastructureTimeoutMs,
        "mailbox admission marker head",
      ),
    );
  } catch {
    console.error("[mail-ingress] admission check degraded", {
      durationMs: durationMs(runtime, admissionStartedAt),
      errorCode: "MAILBOX_ADMISSION_CHECK_FAILED",
      operation: "mailbox_admission_check",
      recoveryAction: "direct_mailbox_then_forward_or_reject",
      status: "degraded",
    });
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
    return;
  }
  if (mailboxProvisioned === false) {
    const rejected = await rejectOnlyWithDurableAuthority(
      event,
      env,
      pointer,
      archivedReceipt,
      "MAILBOX_UNAVAILABLE",
      "Mailbox unavailable",
      runtime,
    );
    console.log("[mail-ingress] message rejected", {
      durationMs: durationMs(runtime, handlerStartedAt),
      errorCode: "MAILBOX_UNAVAILABLE",
      ingressRef,
      objectRef,
      operation: "mailbox_admission_check",
      status: rejected ? "rejected" : "forward_pending",
    });
    return;
  }
  if (mailboxProvisioned) {
    console.log("[mail-ingress] admission check completed", {
      durationMs: durationMs(runtime, admissionStartedAt),
      found: true,
      operation: "mailbox_admission_check",
      status: "succeeded",
      target: "r2",
    });
  }

  let mailboxActive: boolean;
  try {
    mailboxActive = await isActiveMailbox(env, mailboxId, runtime);
  } catch {
    console.error("[mail-ingress] active mailbox check degraded", {
      durationMs: durationMs(runtime, admissionStartedAt),
      errorCode: "MAILBOX_ACTIVE_CHECK_FAILED",
      ingressRef,
      objectRef,
      operation: "mailbox_admission_check",
      recoveryAction: "direct_mailbox_then_forward_or_reject",
      status: "degraded",
      target: "d1",
    });
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
    return;
  }
  if (!mailboxActive) {
    await rejectOnlyWithDurableAuthority(
      event,
      env,
      pointer,
      archivedReceipt,
      "MAILBOX_INACTIVE",
      "Mailbox unavailable",
      runtime,
    );
    return;
  }

  const admittedReceipt = await recordReceiptState(
    env,
    pointer,
    "admitted",
    archivedAt,
    runtime,
    archivedReceipt.etag,
  );
  if (!admittedReceipt) {
    console.error(
      "[mail-ingress] handoff deferred until admission is durable",
      {
        errorCode: "ADMITTED_RECEIPT_UNAVAILABLE",
        ingressRef,
        objectRef,
        operation: "queue_enqueue",
        recoveryAction: "direct_mailbox_then_forward_or_reject",
        status: "degraded",
      },
    );
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
    return;
  }
  const enqueueStartedAt = runtime.now().getTime();
  console.log("[mail-ingress] Queue enqueue started", {
    ingressRef,
    objectRef,
    operation: "queue_enqueue",
    status: "started",
    target: "cloudflare_queue",
  });
  try {
    await withBoundaryDeadline(
      () => env.INBOUND_QUEUE.send(projectInboundArchivePointer(pointer)),
      runtime.infrastructureTimeoutMs,
      "primary Queue send",
    );
  } catch {
    console.error("[mail-ingress] boundary failed", {
      durationMs: durationMs(runtime, enqueueStartedAt),
      errorCode: "QUEUE_ENQUEUE_FAILED",
      ingressRef,
      objectRef,
      operation: "queue_enqueue",
      recoveryAction: "direct_mailbox_then_forward_or_reject",
      status: "degraded",
    });
    await recoverWithDirectMailboxOrSmtpAction(
      event,
      env,
      rawBytes,
      ingressId,
      archivedAt,
      rawKey,
      runtime,
      pointer,
    );
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
    ingressRef,
    objectRef,
    operation: "queue_enqueue",
    status: "succeeded",
    target: "cloudflare_queue",
  });
  console.log("[mail-ingress] message archived and handed off", {
    durationMs: durationMs(runtime, handlerStartedAt),
    ingressRef,
    operation: "inbound_receive",
    status: "succeeded",
  });
}
