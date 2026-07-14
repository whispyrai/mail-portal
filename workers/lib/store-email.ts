// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email } from "postal-mime";
import { extractThreadToken } from "./thread-token.ts";
import {
  boundedAttachmentStorageFilename,
  sanitizeFilename,
  type StoredAttachment,
} from "./attachments.ts";

export const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

type StoredEmail = {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
  cc: string | null;
  bcc: string | null;
  date: string;
  read?: boolean;
  body: string;
  in_reply_to: string | null;
  email_references: string | null;
  thread_id: string;
  message_id: string | null;
  raw_headers: string;
};

export type StoredEmailBodyObject = {
  id: string;
  email_id: string;
  part_index: number;
  content_type: "text/html" | "text/plain";
  charset: string;
  r2_key: string;
  byte_length: number;
};

type AttachmentBucket = {
  put(
    key: string,
    value: ArrayBuffer | string | ReadableStream,
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  createMultipartUpload?(key: string): Promise<MultipartUpload>;
};

type UploadedPart = {
  partNumber: number;
  etag: string;
};

type MultipartUpload = {
  uploadPart(partNumber: number, value: ArrayBuffer): Promise<UploadedPart>;
  abort(): Promise<void>;
  complete(parts: UploadedPart[]): Promise<unknown>;
};

// R2 multipart parts must be at least 5 MiB except for the final part. Keeping
// one part in memory makes unknown-length MIME decoding compatible with R2's
// known-length stream requirement while bounding memory independently of the
// attachment size.
const R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(
    value &&
    typeof value === "object" &&
    "getReader" in value &&
    typeof value.getReader === "function",
  );
}

async function putUnknownLengthStream(
  bucket: AttachmentBucket,
  key: string,
  stream: ReadableStream<Uint8Array>,
  expectedSize: number | (() => number),
): Promise<unknown> {
  // Test doubles and non-R2 adapters can explicitly omit multipart support.
  // The production R2 binding always provides it.
  if (!bucket.createMultipartUpload) return bucket.put(key, stream);

  let multipart: MultipartUpload | null = null;
  const reader = stream.getReader();
  try {
    multipart = await bucket.createMultipartUpload(key);
    const parts: UploadedPart[] = [];
    let partNumber = 1;
    let buffer = new Uint8Array(R2_MULTIPART_PART_BYTES);
    let bufferedBytes = 0;
    let totalBytes = 0;

    while (true) {
      const result = await reader.read();
      if (result.done) break;
      let offset = 0;
      while (offset < result.value.byteLength) {
        const copiedBytes = Math.min(
          buffer.byteLength - bufferedBytes,
          result.value.byteLength - offset,
        );
        buffer.set(
          result.value.subarray(offset, offset + copiedBytes),
          bufferedBytes,
        );
        bufferedBytes += copiedBytes;
        offset += copiedBytes;
        totalBytes += copiedBytes;
        if (bufferedBytes === buffer.byteLength) {
          parts.push(await multipart.uploadPart(partNumber++, buffer.buffer));
          buffer = new Uint8Array(R2_MULTIPART_PART_BYTES);
          bufferedBytes = 0;
        }
      }
    }

    const finalExpectedSize =
      typeof expectedSize === "function" ? expectedSize() : expectedSize;
    if (totalBytes !== finalExpectedSize) {
      throw Object.assign(
        new Error(
          `Decoded stream produced ${totalBytes} bytes; expected ${finalExpectedSize}`,
        ),
        { code: "R2_DERIVED_UPLOAD_INTEGRITY_FAILED" },
      );
    }

    if (bufferedBytes > 0) {
      parts.push(
        await multipart.uploadPart(
          partNumber,
          buffer.buffer.slice(0, bufferedBytes),
        ),
      );
    }
    if (parts.length === 0) {
      await multipart.abort();
      multipart = null;
      return bucket.put(key, new ArrayBuffer(0));
    }
    const completed = await multipart.complete(parts);
    multipart = null;
    return completed;
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    if (multipart) {
      try {
        await multipart.abort();
      } catch (abortError) {
        console.error("[mail-store] multipart upload abort failed", {
          errorCode: "R2_MULTIPART_ABORT_FAILED",
          errorMessage:
            abortError instanceof Error
              ? abortError.message
              : String(abortError),
          key,
          operation: "derived_object_upload_abort",
          status: "degraded",
        });
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

type MailboxEmailStore = {
  createEmail(
    folder: string,
    email: StoredEmail,
    attachments: StoredAttachment[],
    bodyObjects?: StoredEmailBodyObject[],
    allowTerminalRecovery?: boolean,
  ): Promise<unknown>;
  findThreadBySubject(
    subject: string,
    senderAddress?: string,
  ): Promise<string | null>;
  getEmail(id: string): Promise<unknown | null>;
  hasEmail?(id: string): Promise<boolean>;
  isEmailDeleted?(id: string): Promise<boolean>;
  claimInboundPush?(id: string): Promise<boolean>;
  recordInboundTerminalFailure?(input: {
    id: string;
    queueMessageId: string;
    attempts: number;
    errorCode: string;
  }): Promise<"deleted" | "ledgered" | "stored">;
  getInboundTerminalFailure?(id: string): Promise<{
    queueMessageId: string;
    attempts: number;
    errorCode: string;
    recordedAt: string;
  } | null>;
};

export type EmailStorageDependencies = {
  bucket: AttachmentBucket;
  mailbox: MailboxEmailStore;
};

export async function putVerifiedEmailObject(
  dependencies: EmailStorageDependencies,
  input: {
    key: string;
    value: ArrayBuffer | string | ReadableStream;
    expectedSize: number | (() => number);
    messageId: string;
    objectType: "attachment" | "body";
  },
): Promise<void> {
  const startedAt = Date.now();
  console.log("[mail-store] derived object upload started", {
    messageId: input.messageId,
    objectType: input.objectType,
    operation: "derived_object_upload",
    status: "started",
  });
  try {
    const result = isReadableStream(input.value)
      ? await putUnknownLengthStream(
          dependencies.bucket,
          input.key,
          input.value,
          input.expectedSize,
        )
      : await dependencies.bucket.put(input.key, input.value);
    const expectedSize =
      typeof input.expectedSize === "function"
        ? input.expectedSize()
        : input.expectedSize;
    const actualSize =
      result &&
      typeof result === "object" &&
      "size" in result &&
      typeof result.size === "number"
        ? result.size
        : null;
    if (actualSize !== expectedSize) {
      throw Object.assign(
        new Error(
          actualSize === null
            ? "R2 did not return verifiable object metadata"
            : `R2 stored ${actualSize} bytes; expected ${expectedSize}`,
        ),
        { code: "R2_DERIVED_UPLOAD_INTEGRITY_FAILED" },
      );
    }
    console.log("[mail-store] derived object upload completed", {
      byteLength: expectedSize,
      durationMs: Date.now() - startedAt,
      messageId: input.messageId,
      objectType: input.objectType,
      operation: "derived_object_upload",
      status: "succeeded",
    });
  } catch (error) {
    console.error("[mail-store] derived object upload failed", {
      durationMs: Date.now() - startedAt,
      errorCode:
        error && typeof error === "object" && "code" in error
          ? error.code
          : "R2_DERIVED_UPLOAD_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      messageId: input.messageId,
      objectType: input.objectType,
      operation: "derived_object_upload",
      status: "failed",
    });
    throw error;
  }
}

export async function emailExists(
  mailbox: MailboxEmailStore,
  id: string,
): Promise<boolean> {
  return mailbox.hasEmail
    ? mailbox.hasEmail(id)
    : Boolean(await mailbox.getEmail(id));
}

type StoreParsedEmailOptions = {
  folder: string;
  date: string;
  messageId: string;
  read?: boolean;
  threadId?: string;
  allowTerminalRecovery?: boolean;
};

export type StoreEmailProjectionOptions = StoreParsedEmailOptions;

export function isEmailTerminalDuringProjection(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EMAIL_TERMINAL_DURING_PROJECTION",
  );
}

function messageIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const bracketed = Array.from(
    value.matchAll(/<([^>]+)>/g),
    (match) => match[1],
  ).filter((messageId): messageId is string => Boolean(messageId));
  return bracketed.length > 0
    ? bracketed
    : value.trim().split(/\s+/).filter(Boolean);
}

function addresses(entries: Email["to"]): string[] {
  return (entries ?? []).flatMap((entry) =>
    entry.address ? [entry.address.toLowerCase()] : [],
  );
}

export function isEmailDeletedDuringProjection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "code" in error && error.code === "EMAIL_DELETED_DURING_PROJECTION";
}

export async function storeEmailProjection(
  dependencies: EmailStorageDependencies,
  parsed: Email,
  options: StoreEmailProjectionOptions,
  attachmentData: StoredAttachment[],
  bodyObjects: StoredEmailBodyObject[] = [],
): Promise<"duplicate" | "stored"> {
  const { folder, date, messageId, read } = options;
  const inReplyTo = messageIds(parsed.inReplyTo)[0] ?? null;
  const references = messageIds(parsed.references);
  const tokenThreadId = extractThreadToken(references, inReplyTo);
  let threadId =
    options.threadId ??
    tokenThreadId ??
    references[0] ??
    inReplyTo ??
    messageId;

  if (
    !options.threadId &&
    !tokenThreadId &&
    !inReplyTo &&
    references.length === 0
  ) {
    threadId =
      (await dependencies.mailbox.findThreadBySubject(
        parsed.subject ?? "",
        parsed.from?.address,
      )) ?? messageId;
  }

  const result = await dependencies.mailbox.createEmail(
    folder,
    {
      id: messageId,
      subject: parsed.subject ?? "",
      sender: parsed.from?.address?.toLowerCase() ?? "",
      recipient: addresses(parsed.to).join(", "),
      cc: addresses(parsed.cc).join(", ") || null,
      bcc: addresses(parsed.bcc).join(", ") || null,
      date,
      read,
      body: parsed.html ?? parsed.text ?? "",
      in_reply_to: inReplyTo,
      email_references:
        references.length > 0 ? JSON.stringify(references) : null,
      thread_id: threadId,
      message_id: messageIds(parsed.messageId)[0] ?? null,
      raw_headers: JSON.stringify(parsed.headers),
    },
    attachmentData,
    bodyObjects,
    options.allowTerminalRecovery,
  );
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "deleted"
  ) {
    throw Object.assign(
      new Error("Email was deleted while its projection was in flight"),
      { code: "EMAIL_DELETED_DURING_PROJECTION" },
    );
  }
  if (
    result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "terminal"
  ) {
    throw Object.assign(new Error("Inbound delivery is already terminal"), {
      code: "EMAIL_TERMINAL_DURING_PROJECTION",
    });
  }
  return result &&
    typeof result === "object" &&
    "status" in result &&
    result.status === "duplicate"
    ? "duplicate"
    : "stored";
}

export async function removeUncommittedEmailObjects(
  dependencies: EmailStorageDependencies,
  messageId: string,
  objectKeys: string[],
  originalError: unknown,
): Promise<never> {
  let emailWasStored: boolean;
  try {
    emailWasStored = await emailExists(dependencies.mailbox, messageId);
  } catch (verificationError) {
    console.error(
      "[mail-store] could not verify failed persistence; preserving R2 objects",
      { messageId, verificationError },
    );
    throw originalError;
  }

  if (!emailWasStored) {
    const cleanupResults = await Promise.allSettled(
      objectKeys.map((key) => dependencies.bucket.delete(key)),
    );
    const cleanupFailures = cleanupResults.filter(
      (result) => result.status === "rejected",
    ).length;
    if (cleanupFailures > 0) {
      console.error(
        "[mail-store] failed to remove R2 objects after persistence error",
        {
          messageId,
          cleanupFailures,
        },
      );
    }
  }
  throw originalError;
}

/**
 * Persist one parsed email through the shared live-receive and import path.
 * Callers choose identity, folder, date, read state, and an optional imported
 * thread id; this module owns attachment storage and the stored row shape.
 */
export async function storeParsedEmail(
  dependencies: EmailStorageDependencies,
  parsed: Email,
  options: StoreParsedEmailOptions,
): Promise<void> {
  const { folder, date, messageId, read } = options;
  const attachmentData: StoredAttachment[] = [];
  const attachmentKeys: string[] = [];

  try {
    for (const [attachmentIndex, attachment] of parsed.attachments.entries()) {
      const attachmentId = `${messageId}-${attachmentIndex}`;
      const filename = sanitizeFilename(attachment.filename ?? "untitled");
      const key = `attachments/${messageId}/${attachmentId}/${boundedAttachmentStorageFilename(filename)}`;
      attachmentKeys.push(key);
      const byteLength =
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content).byteLength
          : attachment.content.byteLength;
      await putVerifiedEmailObject(dependencies, {
        key,
        value: attachment.content,
        expectedSize: byteLength,
        messageId,
        objectType: "attachment",
      });
      attachmentData.push({
        id: attachmentId,
        email_id: messageId,
        filename,
        mimetype: attachment.mimeType,
        size: byteLength,
        content_id: attachment.contentId ?? null,
        disposition: attachment.disposition ?? "attachment",
        r2_key: key,
      });
    }

    await storeEmailProjection(dependencies, parsed, options, attachmentData);
  } catch (error) {
    return removeUncommittedEmailObjects(
      dependencies,
      messageId,
      attachmentKeys,
      error,
    );
  }
}
