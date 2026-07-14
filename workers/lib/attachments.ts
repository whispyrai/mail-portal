// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound-attachment storage for the upload-first reference model.
 *
 * Files are uploaded once to R2 staging (`uploads/{mailbox}/{uploadId}`), and
 * carried through compose/reply/bulk as lightweight *references*. At send time
 * `resolveAndPromoteAttachments` reads the bytes, enforces the shared limits,
 * base64-encodes for SES, and writes a permanent per-email copy under
 * `attachments/{emailId}/...` (the same layout inbound mail and the download
 * route already use).
 */
import type { Env } from "../types";
import {
  ATTACHMENT_LIMITS,
  validateAttachmentSet,
} from "../../shared/attachments.ts";

/** Metadata for one stored attachment, shaped for the DO `attachments` table. */
export type StoredAttachment = {
  id: string;
  email_id: string;
  filename: string;
  mimetype: string;
  size: number;
  content_id: string | null;
  disposition: string;
  r2_key?: string | null;
};

/** An attachment shaped for `sendEmail` (SES inline delivery). */
type SesAttachmentInput = {
  content: string; // base64
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
};

/**
 * A reference to a file to attach, sent by the client instead of the bytes:
 *  - `upload`: a freshly uploaded file still in R2 staging.
 *  - `existing`: a file already stored against another email (e.g. a draft
 *    being sent, where the draft already owns the R2 objects).
 */
export type AttachmentRef =
  | { kind: "upload"; uploadId: string; disposition?: "attachment" | "inline" }
  | {
      kind: "existing";
      emailId: string;
      attachmentId: string;
      disposition?: "attachment" | "inline";
    };

/** R2 key for a freshly uploaded file not yet attached to a sent email. */
export function uploadKey(mailboxId: string, uploadId: string): string {
  return `uploads/${mailboxId.toLowerCase()}/${uploadId}`;
}

/** R2 key for an attachment permanently stored against an email. */
export function attachmentKey(
  emailId: string,
  attachmentId: string,
  filename: string,
): string {
  return `attachments/${emailId}/${attachmentId}/${filename}`;
}

/** Strip characters that could escape the R2 key namespace or break headers. */
export function sanitizeFilename(name: string): string {
  return (name || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
}

const MAX_ATTACHMENT_STORAGE_FILENAME_BYTES = 240;
const MAX_ATTACHMENT_STORAGE_EXTENSION_BYTES = 24;

/** Truncate without splitting a UTF-8 code point. */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";

  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;

  let result = "";
  let usedBytes = 0;
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (usedBytes + characterBytes > maxBytes) break;
    result += character;
    usedBytes += characterBytes;
  }

  return result;
}

/**
 * Bound only the filename segment used in an R2 key. The complete sanitized
 * filename remains the display filename stored in metadata and sent in mail.
 */
export function boundedAttachmentStorageFilename(name: string): string {
  const cleaned = sanitizeFilename(name);
  const encoder = new TextEncoder();
  if (
    encoder.encode(cleaned).byteLength <= MAX_ATTACHMENT_STORAGE_FILENAME_BYTES
  ) {
    return cleaned;
  }

  const dot = cleaned.lastIndexOf(".");
  const hasExtension = dot > 0 && dot < cleaned.length - 1;
  const extension = hasExtension
    ? truncateUtf8Bytes(
        cleaned.slice(dot),
        MAX_ATTACHMENT_STORAGE_EXTENSION_BYTES,
      )
    : "";
  const extensionBytes = encoder.encode(extension).byteLength;
  const baseLimit = MAX_ATTACHMENT_STORAGE_FILENAME_BYTES - extensionBytes;
  const rawBase = hasExtension ? cleaned.slice(0, dot) : cleaned;
  const base = truncateUtf8Bytes(rawBase, baseLimit) || "attachment";

  return `${base}${extension}`;
}

/**
 * Base64-encode an ArrayBuffer in chunks. `btoa(String.fromCharCode(...bytes))`
 * blows the call stack for large files; chunking keeps each spread small.
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000; // 32 KB
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Minimal DO-stub surface needed to resolve `existing` references. */
type StubForResolve = {
  getAttachment: (id: string) => Promise<{
    filename: string;
    mimetype: string;
    size: number;
    email_id: string;
    r2_key?: string | null;
  } | null>;
};

type ResolvedSource = {
  bytes: ArrayBuffer;
  filename: string;
  mimetype: string;
  disposition: "attachment" | "inline";
  stagingKey?: string; // present for `upload` refs; deleted after promotion
};

/**
 * Resolve attachment references to deliverable + storable form.
 *
 * Reads each ref's bytes from R2, enforces the shared count/size limits against
 * the real resolved sizes, base64-encodes for SES, writes a fresh permanent
 * copy under `attachments/{newEmailId}/...`, and deletes staging objects for
 * `upload` refs. Throws on a missing/expired upload or a limit violation — the
 * caller maps the throw to a 400.
 */
export async function resolveAndPromoteAttachments(
  bucket: Env["BUCKET"],
  stub: StubForResolve,
  mailboxId: string,
  newEmailId: string,
  refs: AttachmentRef[] | undefined,
): Promise<{
  sesAttachments: SesAttachmentInput[];
  storedMetadata: StoredAttachment[];
}> {
  if (!refs?.length) return { sesAttachments: [], storedMetadata: [] };
  if (refs.length > ATTACHMENT_LIMITS.maxFiles) {
    throw new Error(
      `Too many files: max ${ATTACHMENT_LIMITS.maxFiles} per message.`,
    );
  }

  // Pass 1: locate each source and pull its bytes + metadata.
  const sources: ResolvedSource[] = [];
  for (const ref of refs) {
    const disposition: "attachment" | "inline" =
      ref.disposition === "inline" ? "inline" : "attachment";

    if (ref.kind === "upload") {
      const key = uploadKey(mailboxId, ref.uploadId);
      const obj = await bucket.get(key);
      if (!obj) {
        throw new Error(
          "An attachment upload was not found or has expired. Re-attach the file and try again.",
        );
      }
      const meta = obj.customMetadata ?? {};
      sources.push({
        bytes: await obj.arrayBuffer(),
        filename: sanitizeFilename(meta.filename || "untitled"),
        mimetype:
          meta.type ||
          obj.httpMetadata?.contentType ||
          "application/octet-stream",
        disposition,
        stagingKey: key,
      });
    } else {
      const att = await stub.getAttachment(ref.attachmentId);
      if (!att) throw new Error("A referenced attachment no longer exists.");
      const safe = sanitizeFilename(att.filename);
      const obj = await bucket.get(
        att.r2_key ?? attachmentKey(att.email_id, ref.attachmentId, safe),
      );
      if (!obj) throw new Error("A referenced attachment file is missing.");
      sources.push({
        bytes: await obj.arrayBuffer(),
        filename: safe,
        mimetype: att.mimetype || "application/octet-stream",
        disposition,
      });
    }
  }

  // Enforce the full-set limits against the actual resolved sizes.
  const setError = validateAttachmentSet(
    sources.map((s) => ({ filename: s.filename, size: s.bytes.byteLength })),
  );
  if (setError) throw new Error(setError);

  // Pass 2: promote to permanent storage + build the SES + DB payloads.
  const sesAttachments: SesAttachmentInput[] = [];
  const storedMetadata: StoredAttachment[] = [];
  for (const s of sources) {
    const attachmentId = crypto.randomUUID();
    const permanentKey = attachmentKey(
      newEmailId,
      attachmentId,
      boundedAttachmentStorageFilename(s.filename),
    );
    await bucket.put(permanentKey, s.bytes);
    sesAttachments.push({
      content: arrayBufferToBase64(s.bytes),
      filename: s.filename,
      type: s.mimetype,
      disposition: s.disposition,
    });
    storedMetadata.push({
      id: attachmentId,
      email_id: newEmailId,
      filename: s.filename,
      mimetype: s.mimetype,
      size: s.bytes.byteLength,
      content_id: null,
      disposition: s.disposition,
      r2_key: permanentKey,
    });
  }

  // Best-effort staging cleanup; the R2 lifecycle rule on `uploads/` is the backstop.
  await Promise.all(
    sources
      .filter((s) => s.stagingKey)
      .map((s) => bucket.delete(s.stagingKey!).catch(() => {})),
  );

  return { sesAttachments, storedMetadata };
}
