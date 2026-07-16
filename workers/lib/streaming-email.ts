// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { once } from "node:events";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { type MimeNode, type SplitterChunk } from "@zone-eu/mailsplit";
import PostalMime, { type Email } from "postal-mime";
import { BoundedMimeSplitter } from "./bounded-mime-splitter.ts";
import {
  boundedAttachmentStorageFilename,
  sanitizeFilename,
  truncateUtf8Bytes,
  type StoredAttachment,
} from "./attachments.ts";
import {
  InboundProjectionOutcomeError,
  putVerifiedEmailObject,
  storeEmailProjection,
  type EmailStorageDependencies,
  type StoredEmailBodyObject,
  type StoreEmailProjectionOptions,
} from "./store-email.ts";
import { validateInboundDerivedContentProjectionProof } from "./inbound-derived-content-cleanup.ts";
import {
  createInboundCleanupIntent,
  createInboundCleanupPreflightController,
  persistInboundCleanupIntent,
  type InboundCleanupIntentPreflightBucket,
} from "./inbound-derived-content-cleanup-intent.ts";
import { mailTelemetryLogRef } from "./mail-telemetry.ts";

type CleanupPreflightController = {
  readonly attemptId: string;
  beforePut(): Promise<void>;
  assertActive(): Promise<void>;
  activateCommand(commandFingerprint: string): Promise<void>;
  resolveProjection(): Promise<void>;
  abandon(): Promise<boolean>;
  hasStarted(): boolean;
};

class PostUploadFenceLossError extends Error {
  constructor(cause: unknown) {
    super("Derived-content preflight fence was lost after upload", { cause });
    this.name = "PostUploadFenceLossError";
  }
}

const MAX_MIME_HEADER_BYTES = 128 * 1024;
const MAX_MIME_CHILD_NODES = 512;
const MAX_MIME_BOUNDARY_BYTES = 70;
const MAX_INLINE_BODY_BYTES = 512 * 1024;
const MIN_TEXT_PART_PREVIEW_BYTES = 4 * 1024;

const PERMANENT_MIME_ERROR_CODES = new Set([
  "MIME_HEADER_SIZE_EXCEEDED",
  "MIME_ROOT_HEADER_MISSING",
  "MIME_MULTIPART_BOUNDARY_MISSING",
  "MIME_MULTIPART_BOUNDARY_INVALID",
  "MIME_CHARSET_UNSUPPORTED",
  "EMAXLEN",
]);

export function isPermanentMimeProjectionError(error: unknown): boolean {
  return permanentMimeProjectionErrorCode(error) !== null;
}

export function permanentMimeProjectionErrorCode(
  error: unknown,
): string | null {
  if (!error || typeof error !== "object") return null;
  if (!("code" in error) || typeof error.code !== "string") return null;
  return PERMANENT_MIME_ERROR_CODES.has(error.code) ? error.code : null;
}

function permanentMimeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

type ActiveLeaf = {
  node: MimeNode;
  decoder: Transform;
  abort(error: unknown): void;
  finish(): Promise<void>;
};

type TextPart = {
  emailId: string;
  node: MimeNode;
  contentType: "text/html" | "text/plain";
  value: string;
  key: string | null;
  size: number;
  partIndex: number;
  charset: string;
  fullBytes?: Uint8Array;
  storageKey: string;
};

type BodyTypeState = {
  completed: TextPart[];
  external: boolean;
  previewBytesRemaining: number;
  totalBytes: number;
};

type BodyStates = Record<"text/html" | "text/plain", BodyTypeState>;

type MimeNodeMetadata = {
  contentId: string | null;
  contentTypeHeader: string;
  effectiveContentType: string;
};

function trackSinkPromise(
  sinkPromises: Promise<unknown>[],
  promise: Promise<unknown>,
): void {
  // Observe rejection immediately so a long parse cannot trigger an unhandled
  // rejection before the owned sink set is awaited at the projection boundary.
  void promise.catch(() => {});
  sinkPromises.push(promise);
}

class PackedWhitespace {
  #bits = new Uint8Array(0);
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(byte: number): void {
    const byteIndex = this.#length >> 3;
    if (byteIndex >= this.#bits.length) {
      const grown = new Uint8Array(
        Math.max(byteIndex + 1, this.#bits.length * 2, 64),
      );
      grown.set(this.#bits);
      this.#bits = grown;
    }
    const mask = 1 << (this.#length & 7);
    if (byte === 0x09) this.#bits[byteIndex] |= mask;
    else this.#bits[byteIndex] &= ~mask;
    this.#length += 1;
  }

  clear(): void {
    this.#length = 0;
  }

  async drain(write: (chunk: Buffer) => Promise<void>): Promise<void> {
    let offset = 0;
    while (offset < this.#length) {
      const length = Math.min(64 * 1024, this.#length - offset);
      const output = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        const sourceIndex = offset + index;
        output[index] =
          (this.#bits[sourceIndex >> 3] & (1 << (sourceIndex & 7))) !== 0
            ? 0x09
            : 0x20;
      }
      await write(output);
      offset += length;
    }
    this.clear();
  }
}

type QuotedPrintableState =
  | "normal"
  | "equals"
  | "equals-carriage-return"
  | "equals-padding"
  | "equals-padding-carriage-return"
  | "hex";

export class IncrementalQuotedPrintableDecoder extends Transform {
  #state: QuotedPrintableState = "normal";
  #pendingCarriageReturn = false;
  #firstHexByte = 0;
  #trailingWhitespace = new PackedWhitespace();
  #equalsPadding = new PackedWhitespace();
  #resumeReadable: (() => void) | null = null;

  override _read(size: number): void {
    const resume = this.#resumeReadable;
    this.#resumeReadable = null;
    super._read(size);
    resume?.();
  }

  async #pushWithBackpressure(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return;
    const resumed = new Promise<void>((resolve) => {
      this.#resumeReadable = resolve;
    });
    if (this.push(chunk)) {
      this.#resumeReadable = null;
      return;
    }
    await resumed;
  }

  static #hexValue(byte: number): number {
    if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
    if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
    if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
    return -1;
  }

  _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    void (async () => {
      const input = Buffer.from(chunk);
      let output = Buffer.allocUnsafe(64 * 1024);
      let outputIndex = 0;
      const flushOutput = async () => {
        if (outputIndex === 0) return;
        const ready = Buffer.from(output.subarray(0, outputIndex));
        output = Buffer.allocUnsafe(64 * 1024);
        outputIndex = 0;
        await this.#pushWithBackpressure(ready);
      };
      const emitByte = async (byte: number) => {
        if (outputIndex >= output.length) await flushOutput();
        output[outputIndex++] = byte;
      };
      const emitPacked = async (whitespace: PackedWhitespace) => {
        if (whitespace.length === 0) return;
        await flushOutput();
        await whitespace.drain((bytes) => this.#pushWithBackpressure(bytes));
      };

      for (const byte of input) {
        let consumed = false;
        while (!consumed) {
          if (this.#state === "normal") {
            if (this.#pendingCarriageReturn) {
              this.#pendingCarriageReturn = false;
              if (byte === 0x0a) {
                this.#trailingWhitespace.clear();
                await emitByte(0x0d);
                await emitByte(0x0a);
                consumed = true;
                continue;
              }
              await emitPacked(this.#trailingWhitespace);
              await emitByte(0x0d);
            }
            if (byte === 0x20 || byte === 0x09) {
              this.#trailingWhitespace.push(byte);
            } else if (byte === 0x0d) {
              this.#pendingCarriageReturn = true;
            } else if (byte === 0x0a) {
              this.#trailingWhitespace.clear();
              await emitByte(0x0a);
            } else {
              await emitPacked(this.#trailingWhitespace);
              if (byte === 0x3d) this.#state = "equals";
              else await emitByte(byte);
            }
            consumed = true;
            continue;
          }

          if (this.#state === "equals") {
            if (byte === 0x0a) {
              this.#state = "normal";
            } else if (byte === 0x0d) {
              this.#state = "equals-carriage-return";
            } else if (byte === 0x20 || byte === 0x09) {
              this.#equalsPadding.push(byte);
              this.#state = "equals-padding";
            } else if (IncrementalQuotedPrintableDecoder.#hexValue(byte) >= 0) {
              this.#firstHexByte = byte;
              this.#state = "hex";
            } else {
              await emitByte(0x3d);
              this.#state = "normal";
              continue;
            }
            consumed = true;
            continue;
          }

          if (this.#state === "equals-carriage-return") {
            if (byte === 0x0a) {
              this.#state = "normal";
              consumed = true;
              continue;
            }
            await emitByte(0x3d);
            await emitByte(0x0d);
            this.#state = "normal";
            continue;
          }

          if (this.#state === "equals-padding") {
            if (byte === 0x20 || byte === 0x09) {
              this.#equalsPadding.push(byte);
            } else if (byte === 0x0a) {
              this.#equalsPadding.clear();
              this.#state = "normal";
            } else if (byte === 0x0d) {
              this.#state = "equals-padding-carriage-return";
            } else {
              await emitByte(0x3d);
              await emitPacked(this.#equalsPadding);
              this.#state = "normal";
              continue;
            }
            consumed = true;
            continue;
          }

          if (this.#state === "equals-padding-carriage-return") {
            if (byte === 0x0a) {
              this.#equalsPadding.clear();
              this.#state = "normal";
              consumed = true;
              continue;
            }
            await emitByte(0x3d);
            await emitPacked(this.#equalsPadding);
            await emitByte(0x0d);
            this.#state = "normal";
            continue;
          }

          const high = IncrementalQuotedPrintableDecoder.#hexValue(
            this.#firstHexByte,
          );
          const low = IncrementalQuotedPrintableDecoder.#hexValue(byte);
          if (low >= 0) {
            await emitByte((high << 4) | low);
            this.#state = "normal";
            consumed = true;
            continue;
          }
          await emitByte(0x3d);
          await emitByte(this.#firstHexByte);
          this.#state = "normal";
        }
      }
      await flushOutput();
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }

  _flush(callback: (error?: Error | null, data?: Buffer) => void): void {
    void (async () => {
      const suffix: number[] = [];
      // Literal trailing whitespace is intentionally dropped at end of input.
      if (this.#pendingCarriageReturn) suffix.push(0x0d);
      if (this.#state === "equals") suffix.push(0x3d);
      if (this.#state === "equals-carriage-return") suffix.push(0x3d, 0x0d);
      if (this.#state === "hex") suffix.push(0x3d, this.#firstHexByte);
      if (
        this.#state === "equals-padding" ||
        this.#state === "equals-padding-carriage-return"
      ) {
        suffix.push(0x3d);
        if (suffix.length > 0)
          await this.#pushWithBackpressure(Buffer.from(suffix));
        await this.#equalsPadding.drain((bytes) =>
          this.#pushWithBackpressure(bytes),
        );
        if (this.#state === "equals-padding-carriage-return")
          await this.#pushWithBackpressure(Buffer.from("\r"));
        return;
      }
      if (suffix.length > 0)
        await this.#pushWithBackpressure(Buffer.from(suffix));
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }
}

const MAX_RFC_FLOWED_LINE_BYTES = 8 * 1024;

type PendingFlowedLine = {
  lineEnding: Buffer;
  quoteDepth: number;
};

/**
 * Incrementally unfolds RFC 3676 text while bounding retained physical-line
 * bytes. RFC-conforming lines are at most 998 characters. An overlong,
 * non-conforming line is preserved as fixed text rather than buffered.
 */
export class IncrementalFlowedDecoder extends Transform {
  readonly #delSp: boolean;
  #line = Buffer.allocUnsafe(MAX_RFC_FLOWED_LINE_BYTES);
  #lineLength = 0;
  #overlongLine = false;
  #overlongOutput = Buffer.allocUnsafe(64 * 1024);
  #overlongOutputLength = 0;
  #pendingCarriageReturn = false;
  #pendingFlowed: PendingFlowedLine | null = null;
  #resumeReadable: (() => void) | null = null;

  constructor(delSp: boolean) {
    super();
    this.#delSp = delSp;
  }

  override _read(size: number): void {
    const resume = this.#resumeReadable;
    this.#resumeReadable = null;
    super._read(size);
    resume?.();
  }

  async #pushWithBackpressure(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    const resumed = new Promise<void>((resolve) => {
      this.#resumeReadable = resolve;
    });
    if (this.push(Buffer.from(chunk))) {
      this.#resumeReadable = null;
      return;
    }
    await resumed;
  }

  async #pushQuotePrefix(depth: number): Promise<void> {
    let remaining = depth;
    while (remaining > 0) {
      const length = Math.min(remaining, 64 * 1024);
      await this.#pushWithBackpressure(Buffer.alloc(length, 0x3e));
      remaining -= length;
    }
  }

  async #startLine(quoteDepth: number, signature: boolean): Promise<void> {
    const previous = this.#pendingFlowed;
    this.#pendingFlowed = null;
    const joinsPrevious =
      previous && previous.quoteDepth === quoteDepth && !signature;
    if (previous) {
      if (!this.#delSp) await this.#pushWithBackpressure(Buffer.from(" "));
      if (!joinsPrevious) await this.#pushWithBackpressure(previous.lineEnding);
    }
    if (!joinsPrevious) await this.#pushQuotePrefix(quoteDepth);
  }

  #normalizedLine(): {
    content: Buffer;
    quoteDepth: number;
    signature: boolean;
  } {
    const line = this.#line.subarray(0, this.#lineLength);
    let quoteDepth = 0;
    while (line[quoteDepth] === 0x3e) quoteDepth += 1;
    let contentOffset = quoteDepth;
    if (line[contentOffset] === 0x20) contentOffset += 1;
    const content = line.subarray(contentOffset);
    const signature =
      content.length === 3 &&
      content[0] === 0x2d &&
      content[1] === 0x2d &&
      content[2] === 0x20;
    return { content, quoteDepth, signature };
  }

  async #flushPendingFlowedAtBodyEnd(): Promise<void> {
    const pending = this.#pendingFlowed;
    this.#pendingFlowed = null;
    if (!pending) return;
    if (!this.#delSp) await this.#pushWithBackpressure(Buffer.from(" "));
    await this.#pushWithBackpressure(pending.lineEnding);
  }

  async #beginOverlongLine(): Promise<void> {
    await this.#flushPendingFlowedAtBodyEnd();
    await this.#pushWithBackpressure(this.#line.subarray(0, this.#lineLength));
    this.#lineLength = 0;
    this.#overlongLine = true;
  }

  async #flushOverlongOutput(): Promise<void> {
    if (this.#overlongOutputLength === 0) return;
    await this.#pushWithBackpressure(
      this.#overlongOutput.subarray(0, this.#overlongOutputLength),
    );
    this.#overlongOutput = Buffer.allocUnsafe(64 * 1024);
    this.#overlongOutputLength = 0;
  }

  async #appendOverlongByte(byte: number): Promise<void> {
    this.#overlongOutput[this.#overlongOutputLength++] = byte;
    if (this.#overlongOutputLength === this.#overlongOutput.length)
      await this.#flushOverlongOutput();
  }

  async #appendByte(byte: number): Promise<void> {
    if (this.#overlongLine) {
      await this.#appendOverlongByte(byte);
      return;
    }
    if (this.#lineLength === this.#line.length) {
      await this.#beginOverlongLine();
      await this.#appendOverlongByte(byte);
      return;
    }
    this.#line[this.#lineLength++] = byte;
  }

  async #finishLine(lineEnding: Buffer): Promise<void> {
    if (this.#overlongLine) {
      await this.#flushOverlongOutput();
      await this.#pushWithBackpressure(lineEnding);
      this.#overlongLine = false;
      return;
    }
    const { content, quoteDepth, signature } = this.#normalizedLine();
    await this.#startLine(quoteDepth, signature);
    const flowed =
      !signature && content.length > 0 && content[content.length - 1] === 0x20;
    if (flowed) {
      await this.#pushWithBackpressure(content.subarray(0, content.length - 1));
      this.#pendingFlowed = { lineEnding, quoteDepth };
    } else {
      await this.#pushWithBackpressure(content);
      await this.#pushWithBackpressure(lineEnding);
    }
    this.#lineLength = 0;
  }

  _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    void (async () => {
      for (const byte of chunk) {
        if (this.#pendingCarriageReturn) {
          this.#pendingCarriageReturn = false;
          if (byte === 0x0a) {
            await this.#finishLine(Buffer.from("\r\n"));
            continue;
          }
          await this.#appendByte(0x0d);
        }
        if (byte === 0x0d) {
          this.#pendingCarriageReturn = true;
        } else if (byte === 0x0a) {
          await this.#finishLine(Buffer.from("\n"));
        } else {
          await this.#appendByte(byte);
        }
      }
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }

  _flush(callback: (error?: Error | null) => void): void {
    void (async () => {
      if (this.#pendingCarriageReturn) {
        await this.#appendByte(0x0d);
        this.#pendingCarriageReturn = false;
      }
      if (this.#overlongLine) {
        await this.#flushOverlongOutput();
        this.#overlongLine = false;
      } else if (this.#lineLength > 0) {
        await this.#finishLine(Buffer.alloc(0));
      }
      await this.#flushPendingFlowedAtBodyEnd();
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }
}

class CharsetToUtf8 extends Transform {
  readonly #decoder: TextDecoder;

  constructor(charset: string | false) {
    super();
    try {
      this.#decoder = new TextDecoder(charset || "utf-8", { fatal: false });
    } catch {
      throw permanentMimeError("MIME_CHARSET_UNSUPPORTED");
    }
  }

  _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    callback(null, Buffer.from(this.#decoder.decode(chunk, { stream: true })));
  }

  _flush(callback: (error?: Error | null, data?: Buffer) => void): void {
    callback(null, Buffer.from(this.#decoder.decode()));
  }
}

function decoderForNode(node: MimeNode): Transform {
  return node.encoding === "quoted-printable"
    ? new IncrementalQuotedPrintableDecoder()
    : node.getDecoder();
}

function decodeText(bytes: Uint8Array, charset: string | false): string {
  try {
    return new TextDecoder(charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

function attachmentKey(
  messageId: string,
  projectionAttemptId: string,
  attachmentId: string,
  filename: string,
): string {
  return `attachments/${messageId}/${projectionAttemptId}/${attachmentId}/${filename}`;
}

function metadataForNode(node: MimeNode): MimeNodeMetadata {
  const contentTypeHeader = node.headers
    ? node.headers.getFirst("content-type")
    : "";
  const effectiveContentType =
    !contentTypeHeader &&
    node.parentNode &&
    node.parentNode.multipart === "digest"
      ? "message/rfc822"
      : node.contentType || "application/octet-stream";
  const contentId = node.headers
    ? truncateUtf8Bytes(node.headers.getFirst("content-id") || "", 512) || null
    : null;
  return { contentId, contentTypeHeader, effectiveContentType };
}

function releaseNonRootHeaderStorage(node: MimeNode): void {
  if (node.root) return;
  const mutable = node as MimeNode & { _headersLines: Buffer[] };
  mutable._headersLines = [];
  mutable._headerlen = 0;
  mutable.headers = false;
}

function isAttachment(node: MimeNode, metadata: MimeNodeMetadata): boolean {
  const contentType = metadata.effectiveContentType;
  return (
    node.disposition === "attachment" ||
    Boolean(node.filename) ||
    (contentType !== "text/plain" && contentType !== "text/html")
  );
}

function startAttachment(
  dependencies: EmailStorageDependencies,
  node: MimeNode,
  messageId: string,
  projectionAttemptId: string,
  attachmentIndex: number,
  attachments: StoredAttachment[],
  attachmentNodes: Map<string, MimeNode>,
  metadata: MimeNodeMetadata,
  objectKeys: string[],
  attemptedPutKeys: string[],
  sinkPromises: Promise<unknown>[],
  preflight?: CleanupPreflightController,
): ActiveLeaf {
  const decoder = decoderForNode(node);
  const attachmentId = `${messageId}-${attachmentIndex}`;
  const filename = sanitizeFilename(
    node.filename ||
      (metadata.effectiveContentType === "message/rfc822"
        ? "message.eml"
        : "untitled"),
  );
  const storageFilename = boundedAttachmentStorageFilename(filename);
  const key = attachmentKey(
    messageId,
    projectionAttemptId,
    attachmentId,
    storageFilename,
  );
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer | Uint8Array, _encoding, callback) {
      size += chunk.byteLength;
      callback(null, chunk);
    },
  });
  decoder.once("error", (error) => counter.destroy(error));
  decoder.pipe(counter);
  objectKeys.push(key);

  // Cloudflare documents Node and Web stream interop under nodejs_compat. R2
  // accepts only the Web ReadableStream side of this bridge.
  const upload = (async () => {
    await preflight?.beforePut();
    attemptedPutKeys.push(key);
    await putVerifiedEmailObject(dependencies, {
      key,
      value: Readable.toWeb(counter) as ReadableStream,
      expectedSize: () => size,
      messageId,
      objectType: "attachment",
    });
    await assertUploadFence(
      preflight,
      dependencies,
      messageId,
      projectionAttemptId,
      key,
    );
  })();
  trackSinkPromise(sinkPromises, upload);
  return {
    node,
    decoder,
    abort(error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      decoder.destroy(failure);
      // A lazy preflight can fail before R2 starts consuming the counter's
      // readable side. Observe that owned stream error while the caller throws
      // the same failure through the projection Promise.
      counter.once("error", () => {});
      counter.destroy(failure);
    },
    async finish() {
      await upload;
      attachments.push({
        id: attachmentId,
        email_id: messageId,
        filename,
        mimetype: metadata.effectiveContentType,
        size,
        content_id: metadata.contentId,
        disposition: node.disposition || "attachment",
        r2_key: key,
      });
      attachmentNodes.set(key, node);
    },
  };
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function joinChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function startBufferedBodyUpload(
  dependencies: EmailStorageDependencies,
  part: TextPart,
  objectKeys: string[],
  attemptedPutKeys: string[],
  sinkPromises: Promise<unknown>[],
  preflight?: CleanupPreflightController,
): void {
  if (!part.fullBytes || part.key) return;
  const key = part.storageKey;
  const bytes = exactArrayBuffer(part.fullBytes);
  part.key = key;
  objectKeys.push(key);
  const upload = (async () => {
    await preflight?.beforePut();
    attemptedPutKeys.push(key);
    await putVerifiedEmailObject(dependencies, {
      key,
      value: bytes,
      expectedSize: part.size,
      messageId: part.emailId,
      objectType: "body",
    });
    await assertUploadFence(
      preflight,
      dependencies,
      part.emailId,
      preflight?.attemptId ?? "",
      key,
    );
  })();
  trackSinkPromise(sinkPromises, upload);
  delete part.fullBytes;
}

function startTextPart(
  dependencies: EmailStorageDependencies,
  node: MimeNode,
  messageId: string,
  projectionAttemptId: string,
  partIndex: number,
  textParts: TextPart[],
  objectKeys: string[],
  attemptedPutKeys: string[],
  bodyStates: BodyStates,
  sinkPromises: Promise<unknown>[],
  preflight?: CleanupPreflightController,
): ActiveLeaf {
  const decoder = decoderForNode(node);
  const transcoder = new CharsetToUtf8(node.charset);
  const contentType =
    node.contentType === "text/html" ? "text/html" : "text/plain";
  const flowedDecoder =
    contentType === "text/plain" && node.flowed
      ? new IncrementalFlowedDecoder(node.delSp)
      : null;
  const bodyState = bodyStates[contentType];
  const previewChunks: Uint8Array[] = [];
  const fullChunks: Uint8Array[] = [];
  let previewBytes = 0;
  let bufferedBytes = 0;
  let size = 0;
  let key: string | null = null;
  let sink: PassThrough | null = null;
  let upload: Promise<unknown> | null = null;

  const startCurrentUpload = (): PassThrough => {
    if (sink) return sink;
    key = `email-bodies/${messageId}/${projectionAttemptId}/${partIndex}.body`;
    sink = new PassThrough();
    objectKeys.push(key);
    upload = (async () => {
      await preflight?.beforePut();
      attemptedPutKeys.push(key!);
      await putVerifiedEmailObject(dependencies, {
        key: key!,
        value: Readable.toWeb(sink!) as ReadableStream,
        expectedSize: () => size,
        messageId,
        objectType: "body",
      });
      await assertUploadFence(
        preflight,
        dependencies,
        messageId,
        projectionAttemptId,
        key!,
      );
    })();
    trackSinkPromise(sinkPromises, upload);
    return sink;
  };

  const collector = new Writable({
    write(chunk: Buffer | Uint8Array, _encoding, callback) {
      const bytes = new Uint8Array(chunk);
      size += chunk.byteLength;
      bodyState.totalBytes += chunk.byteLength;
      const guaranteedPreviewRemaining = Math.max(
        0,
        MIN_TEXT_PART_PREVIEW_BYTES - previewBytes,
      );
      const previewAllowance =
        guaranteedPreviewRemaining + bodyState.previewBytesRemaining;
      if (previewAllowance > 0) {
        const retained = chunk.subarray(
          0,
          Math.min(chunk.byteLength, previewAllowance),
        );
        previewChunks.push(new Uint8Array(retained));
        previewBytes += retained.byteLength;
        bodyState.previewBytesRemaining -= Math.max(
          0,
          retained.byteLength - guaranteedPreviewRemaining,
        );
      }

      if (!bodyState.external) {
        fullChunks.push(bytes);
        bufferedBytes += bytes.byteLength;
        if (bodyState.totalBytes <= MAX_INLINE_BODY_BYTES) {
          callback();
          return;
        }

        bodyState.external = true;
        for (const completedPart of bodyState.completed) {
          startBufferedBodyUpload(
            dependencies,
            completedPart,
            objectKeys,
            attemptedPutKeys,
            sinkPromises,
            preflight,
          );
        }
        const prefix = joinChunks(fullChunks, bufferedBytes);
        fullChunks.length = 0;
        bufferedBytes = 0;
        startCurrentUpload().write(prefix, callback);
        return;
      }

      startCurrentUpload().write(bytes, callback);
    },
    final(callback) {
      if (!sink) {
        callback();
        return;
      }
      sink.end(callback);
    },
  });
  decoder.once("error", (error) => transcoder.destroy(error));
  transcoder.once("error", (error) => {
    flowedDecoder?.destroy(error);
    collector.destroy(error);
  });
  flowedDecoder?.once("error", (error) => collector.destroy(error));
  const decodedText = decoder.pipe(transcoder);
  if (flowedDecoder) decodedText.pipe(flowedDecoder).pipe(collector);
  else decodedText.pipe(collector);
  return {
    node,
    decoder,
    abort(error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      decoder.destroy(failure);
      transcoder.destroy(failure);
      flowedDecoder?.destroy(failure);
      collector.destroy(failure);
      sink?.destroy(failure);
    },
    async finish() {
      if (!collector.writableFinished) await once(collector, "finish");
      if (upload) await upload;
      const fullBytes = !bodyState.external
        ? joinChunks(fullChunks, bufferedBytes)
        : undefined;
      const part: TextPart = {
        emailId: messageId,
        node,
        contentType,
        value: decodeText(
          fullBytes ?? joinChunks(previewChunks, previewBytes),
          "utf-8",
        ),
        key,
        size,
        partIndex,
        charset: "utf-8",
        storageKey: `email-bodies/${messageId}/${projectionAttemptId}/${partIndex}.body`,
        ...(fullBytes ? { fullBytes } : {}),
      };
      textParts.push(part);
      bodyState.completed.push(part);
    },
  };
}

async function finishLeaf(activeLeaf: ActiveLeaf | null): Promise<void> {
  if (!activeLeaf) return;
  activeLeaf.decoder.end();
  await activeLeaf.finish();
}

async function writeLeafChunk(
  activeLeaf: ActiveLeaf,
  value: Uint8Array,
): Promise<void> {
  if (activeLeaf.decoder.write(value)) return;
  await once(activeLeaf.decoder, "drain");
}

function relatedRoot(
  node: MimeNode,
  children: MimeNode[],
  nodeMetadata: Map<MimeNode, MimeNodeMetadata>,
): MimeNode | null {
  if (children.length === 0) return null;
  const contentType = nodeMetadata.get(node)?.contentTypeHeader ?? "";
  const startMatch = /(?:^|;)\s*start\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(
    contentType,
  );
  const start = (startMatch?.[1] ?? startMatch?.[2] ?? "")
    .trim()
    .replace(/^<|>$/g, "");
  if (!start) return children[0];
  return (
    children.find((child) => {
      const contentId = (nodeMetadata.get(child)?.contentId ?? "")
        .trim()
        .replace(/^<|>$/g, "");
      return contentId === start;
    }) ?? children[0]
  );
}

function selectBody(
  textParts: TextPart[],
  nodes: MimeNode[],
  nodeMetadata: Map<MimeNode, MimeNodeMetadata>,
): {
  body: Pick<Email, "html" | "text">;
  parts: TextPart[];
} {
  const children = new Map<MimeNode, MimeNode[]>();
  const textByNode = new Map(textParts.map((part) => [part.node, part]));
  for (const node of nodes) {
    if (!node.parentNode) continue;
    const siblings = children.get(node.parentNode) ?? [];
    siblings.push(node);
    children.set(node.parentNode, siblings);
  }

  const selectNode = (node: MimeNode): TextPart[] => {
    const text = textByNode.get(node);
    if (text) return [text];
    const childNodes = children.get(node) ?? [];
    if (node.multipart === "alternative") {
      let fallback: TextPart[] = [];
      for (let index = childNodes.length - 1; index >= 0; index -= 1) {
        const selected = selectNode(childNodes[index]);
        if (selected.length === 0) continue;
        if (fallback.length === 0) fallback = selected;
        if (selected.some((part) => part.size > 0)) return selected;
      }
      return fallback;
    }
    if (node.multipart === "related") {
      const root = relatedRoot(node, childNodes, nodeMetadata);
      return root ? selectNode(root) : [];
    }
    return childNodes.flatMap(selectNode);
  };

  const root = nodes.find((node) => node.root);
  const selected = root ? selectNode(root) : textParts;
  const hasHtml = selected.some(
    (part) => part.contentType === "text/html" && part.value.length > 0,
  );
  if (hasHtml) {
    const html = selected
      .map((part) =>
        part.contentType === "text/html"
          ? part.value
          : `<pre>${part.value
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")}</pre>`,
      )
      .join("<br/>\n");
    return {
      body: { html: truncateUtf8Bytes(html, MAX_INLINE_BODY_BYTES) },
      parts: selected,
    };
  }
  const plainParts = selected.filter(
    (part) => part.contentType === "text/plain",
  );
  return {
    body: {
      text: truncateUtf8Bytes(
        plainParts.map((part) => part.value).join("\n"),
        MAX_INLINE_BODY_BYTES,
      ),
    },
    parts: plainParts,
  };
}

function directChildOf(ancestor: MimeNode, node: MimeNode): MimeNode | null {
  let child = node;
  let parent = child.parentNode as MimeNode | false;
  while (parent && parent !== ancestor) {
    child = parent;
    parent = child.parentNode as MimeNode | false;
  }
  return parent === ancestor ? child : null;
}

function attachmentBelongsToSelectedAlternative(
  node: MimeNode,
  selectedParts: TextPart[],
): boolean {
  let ancestor = node.parentNode as MimeNode | false;
  while (ancestor) {
    if (ancestor.multipart === "alternative") {
      const attachmentBranch = directChildOf(ancestor, node);
      const selectedBranches = new Set(
        selectedParts
          .map((part) => directChildOf(ancestor as MimeNode, part.node))
          .filter((branch): branch is MimeNode => Boolean(branch)),
      );
      if (!attachmentBranch || !selectedBranches.has(attachmentBranch))
        return false;
    }
    ancestor = ancestor.parentNode as MimeNode | false;
  }
  return true;
}

async function parseBoundedHeaders(root: MimeNode): Promise<Email> {
  const rawHeaders = root.getHeaders();
  if (rawHeaders.byteLength > MAX_MIME_HEADER_BYTES) {
    throw permanentMimeError("MIME_HEADER_SIZE_EXCEEDED");
  }
  return PostalMime.parse(rawHeaders);
}

export async function storeStreamingEmail(
  dependencies: EmailStorageDependencies,
  raw: ReadableStream,
  options: StoreEmailProjectionOptions,
  cleanupIntentBucket?: InboundCleanupIntentPreflightBucket,
): Promise<Email> {
  return processStreamingEmail(
    dependencies,
    raw,
    options,
    async (derived) => {
      const projectionStatus = await storeEmailProjection(
        dependencies,
        derived.parsed,
        options,
        derived.attachments,
        derived.bodyObjects,
        {
          projectionAttemptId: derived.projectionAttemptId,
          derivedContentProof: derived.derivedContentProof,
        },
      );
      if (!projectionStatus.cleanupKeys) {
        throw new Error("Inbound projection cleanup result is incomplete");
      }
      validateStreamingProjectionCleanup(
        projectionStatus,
        derived.derivedContentProof,
      );
      return {
        keepDerivedObjects: projectionStatus.status !== "duplicate",
        cleanupKeys: projectionStatus.cleanupKeys,
      };
    },
    "message_aware",
    cleanupIntentBucket,
  );
}

export class DerivedEmailConsumerError extends Error {
  readonly commitState: "not_committed" | "unverified";

  constructor(commitState: "not_committed" | "unverified", cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DerivedEmailConsumerError";
    this.commitState = commitState;
  }
}

function validateStreamingProjectionCleanup(
  result: InboundProjectionOutcomeError["projectionResult"],
  proof: Array<{ r2Key: string; byteLength: number }>,
): void {
  if (result.status !== "cleanup_conflict" && !result.cleanupKeys) {
    throw new Error("Inbound projection cleanup result is incomplete");
  }
  if (!result.cleanupKeys) return;
  const uniqueCleanupKeys = new Set(result.cleanupKeys);
  const proofKeys = new Set(proof.map(({ r2Key }) => r2Key));
  if (
    uniqueCleanupKeys.size !== result.cleanupKeys.length ||
    result.cleanupKeys.some((key) => !proofKeys.has(key))
  ) {
    throw new Error("Inbound projection cleanup result is invalid");
  }
}

const DERIVED_CLEANUP_ENQUEUE_ATTEMPTS = 3;

async function enqueueUnownedDerivedContentCleanup(
  dependencies: EmailStorageDependencies,
  input: {
    messageId: string;
    projectionAttemptId: string;
    keys: string[];
  },
): Promise<boolean> {
  if (!dependencies.mailbox.enqueueUnownedInboundDerivedContentCleanup) {
    return false;
  }
  for (
    let enqueueAttempt = 0;
    enqueueAttempt < DERIVED_CLEANUP_ENQUEUE_ATTEMPTS;
    enqueueAttempt += 1
  ) {
    try {
      await dependencies.mailbox.enqueueUnownedInboundDerivedContentCleanup({
        emailId: input.messageId,
        projectionAttemptId: input.projectionAttemptId,
        keys: input.keys,
      });
      return true;
    } catch {
      // The Mailbox insert is idempotent, so an ambiguous accepted call may
      // be retried safely without weakening exact-key ownership.
    }
  }
  return false;
}

async function assertUploadFence(
  preflight: CleanupPreflightController | undefined,
  dependencies: EmailStorageDependencies,
  messageId: string,
  projectionAttemptId: string,
  key: string,
): Promise<void> {
  if (!preflight) return;
  try {
    await preflight.assertActive();
  } catch (error) {
    await enqueueUnownedDerivedContentCleanup(dependencies, {
      messageId,
      projectionAttemptId,
      keys: [key],
    });
    throw new PostUploadFenceLossError(error);
  }
}

async function cleanupKnownPreProjectionFailure(
  dependencies: EmailStorageDependencies,
  input: {
    messageId: string;
    projectionAttemptId: string;
    keys: string[];
  },
): Promise<void> {
  const keys = [...new Set(input.keys)];
  if (keys.length === 0) return;
  try {
    await dependencies.bucket.delete(keys);
  } catch {
    // The guarded Mailbox cleanup below remains authoritative when the bulk
    // R2 response is failed or ambiguous.
  }
  await enqueueUnownedDerivedContentCleanup(dependencies, {
    messageId: input.messageId,
    projectionAttemptId: input.projectionAttemptId,
    keys,
  });
}

async function cleanupAttemptOwnedObjects(
  dependencies: EmailStorageDependencies,
  input: {
    messageId: string;
    projectionAttemptId: string;
    keys: string[];
    operation: "derived_attempt_cleanup" | "projection_staging_cleanup";
  },
): Promise<void> {
  const keys = [...new Set(input.keys)];
  if (keys.length === 0) return;

  const cleanupResults = await Promise.allSettled(
    keys.map((key) => dependencies.bucket.delete(key)),
  );
  const failedKeys = cleanupResults.flatMap((result, index) =>
    result.status === "rejected" ? [keys[index]] : [],
  );
  if (failedKeys.length === 0) return;

  const queued = await enqueueUnownedDerivedContentCleanup(dependencies, {
    messageId: input.messageId,
    projectionAttemptId: input.projectionAttemptId,
    keys: failedKeys,
  });
  const [attemptRef, messageRef] = await Promise.all([
    mailTelemetryLogRef("attempt", input.projectionAttemptId),
    mailTelemetryLogRef("message", input.messageId),
  ]);
  console.error("[mail-store] attempt-owned R2 cleanup degraded", {
    attemptRef,
    cleanupFailures: failedKeys.length,
    cleanupQueued: queued,
    messageRef,
    operation: input.operation,
    status: "retrying",
  });
}

export async function deriveStreamingEmail<
  TResult extends { keepDerivedObjects: boolean },
>(
  dependencies: EmailStorageDependencies,
  raw: ReadableStream,
  options: StoreEmailProjectionOptions,
  consume: (derived: {
    parsed: Email;
    attachments: StoredAttachment[];
    bodyObjects: StoredEmailBodyObject[];
    derivedContentProof: Array<{ r2Key: string; byteLength: number }>;
    projectionAttemptId: string;
    activateCommand(commandFingerprint: string): Promise<void>;
  }) => Promise<TResult>,
  cleanupIntentBucket: InboundCleanupIntentPreflightBucket,
): Promise<{ parsed: Email; result: TResult }> {
  let result: TResult | undefined;
  const parsed = await processStreamingEmail(
    dependencies,
    raw,
    options,
    async (derived) => {
      result = await consume(derived);
      return result;
    },
    "attempt_owned",
    cleanupIntentBucket,
  );
  if (!result) throw new Error("Derived email was not consumed");
  return { parsed, result };
}

async function processStreamingEmail(
  dependencies: EmailStorageDependencies,
  raw: ReadableStream,
  options: StoreEmailProjectionOptions,
  consume: (derived: {
    parsed: Email;
    attachments: StoredAttachment[];
    bodyObjects: StoredEmailBodyObject[];
    derivedContentProof: Array<{ r2Key: string; byteLength: number }>;
    projectionAttemptId: string;
    activateCommand(commandFingerprint: string): Promise<void>;
  }) => Promise<{ keepDerivedObjects: boolean; cleanupKeys?: string[] }>,
  failureCleanup: "attempt_owned" | "message_aware",
  cleanupIntentBucket?: InboundCleanupIntentPreflightBucket,
): Promise<Email> {
  const attachments: StoredAttachment[] = [];
  const attachmentNodes = new Map<string, MimeNode>();
  const objectKeys: string[] = [];
  const attemptedPutKeys: string[] = [];
  const sinkPromises: Promise<unknown>[] = [];
  const textParts: TextPart[] = [];
  const nodes: MimeNode[] = [];
  const nodeMetadata = new Map<MimeNode, MimeNodeMetadata>();
  const projectionAttemptId = crypto.randomUUID();
  const bodyStates: BodyStates = {
    "text/html": {
      completed: [],
      external: false,
      previewBytesRemaining: MAX_INLINE_BODY_BYTES,
      totalBytes: 0,
    },
    "text/plain": {
      completed: [],
      external: false,
      previewBytesRemaining: MAX_INLINE_BODY_BYTES,
      totalBytes: 0,
    },
  };
  const splitter = new BoundedMimeSplitter({
    ignoreEmbedded: true,
    maxHeadSize: MAX_MIME_HEADER_BYTES,
    maxChildNodes: MAX_MIME_CHILD_NODES,
  });
  let activeLeaf: ActiveLeaf | null = null;
  let rootNode: MimeNode | null = null;
  let attachmentIndex = 0;
  let textPartIndex = 0;
  let consumeStarted = false;
  let cleanupIntent: ReturnType<typeof createInboundCleanupIntent> | undefined;
  let initializedPreflight:
    | ReturnType<typeof createInboundCleanupPreflightController>
    | undefined;
  let preflightInitialization:
    | Promise<ReturnType<typeof createInboundCleanupPreflightController>>
    | undefined;
  const preflightMode =
    failureCleanup === "attempt_owned" ? "repair" : "normal";
  const initializePreflight = () => {
    if (!preflightInitialization) {
      preflightInitialization = (async () => {
        if (!cleanupIntentBucket || !options.mailboxAddress) {
          throw new DerivedEmailConsumerError(
            "unverified",
            new Error("Derived-content cleanup ledger is unavailable"),
          );
        }
        cleanupIntent = createInboundCleanupIntent({
          emailId: options.messageId,
          mailboxId: options.mailboxAddress,
          projectionAttemptId,
        });
        if (
          !(await persistInboundCleanupIntent(cleanupIntentBucket, cleanupIntent))
        ) {
          throw new DerivedEmailConsumerError(
            "unverified",
            new Error("Derived-content cleanup ledger could not be verified"),
          );
        }
        initializedPreflight = createInboundCleanupPreflightController(
          cleanupIntentBucket,
          cleanupIntent,
        );
        return initializedPreflight;
      })();
      void preflightInitialization.catch(() => {});
    }
    return preflightInitialization;
  };
  const preflight: CleanupPreflightController = {
    attemptId: projectionAttemptId,
    async beforePut() {
      const initialized = await initializePreflight();
      if (preflightMode === "repair") await initialized.renew();
    },
    async assertActive() {
      await (await initializePreflight()).assertActive();
    },
    async activateCommand(commandFingerprint) {
      await (await initializePreflight()).activateCommand(commandFingerprint);
    },
    async resolveProjection() {
      await (await initializePreflight()).resolveProjection();
    },
    async abandon() {
      return (await initializePreflight()).abandon();
    },
    hasStarted() {
      return initializedPreflight !== undefined;
    },
  };

  try {
    if (failureCleanup === "attempt_owned") {
      await initializePreflight();
    }
    // Per Cloudflare Workers Node-stream documentation, nodejs_compat supports
    // this Web-to-Node bridge. BoundedMimeSplitter retains only headers and a
    // possible boundary prefix while streaming arbitrary-length body lines.
    const source = Readable.fromWeb(raw as never);
    source.once("error", (error) => splitter.destroy(error));
    source.pipe(splitter);

    for await (const chunk of splitter as AsyncIterable<SplitterChunk>) {
      if (chunk.type !== "body") {
        await finishLeaf(activeLeaf);
        activeLeaf = null;
      }
      if (chunk.type === "node") {
        const metadata = metadataForNode(chunk);
        nodeMetadata.set(chunk, metadata);
        nodes.push(chunk);
        if (chunk.root) rootNode = chunk;
        if (chunk.multipart) {
          if (!chunk._boundary) {
            throw permanentMimeError("MIME_MULTIPART_BOUNDARY_MISSING");
          }
          if (chunk._boundary.byteLength > MAX_MIME_BOUNDARY_BYTES) {
            throw permanentMimeError("MIME_MULTIPART_BOUNDARY_INVALID");
          }
          releaseNonRootHeaderStorage(chunk);
          continue;
        }
        activeLeaf = isAttachment(chunk, metadata)
          ? startAttachment(
              dependencies,
              chunk,
              options.messageId,
              projectionAttemptId,
              attachmentIndex++,
              attachments,
              attachmentNodes,
              metadata,
              objectKeys,
              attemptedPutKeys,
              sinkPromises,
              preflight,
            )
          : startTextPart(
              dependencies,
              chunk,
              options.messageId,
              projectionAttemptId,
              textPartIndex++,
              textParts,
              objectKeys,
              attemptedPutKeys,
              bodyStates,
              sinkPromises,
              preflight,
            );
        releaseNonRootHeaderStorage(chunk);
        continue;
      }
      if (chunk.type === "body" && activeLeaf) {
        await writeLeafChunk(activeLeaf, chunk.value);
      }
    }
    await finishLeaf(activeLeaf);
    await Promise.all(sinkPromises);
    if (!rootNode) throw permanentMimeError("MIME_ROOT_HEADER_MISSING");

    const parsedHeaders = await parseBoundedHeaders(rootNode);
    const selected = selectBody(textParts, nodes, nodeMetadata);
    const selectedParts = selected.parts;
    const selectedAttachments = attachments.filter((attachment) => {
      const node = attachment.r2_key
        ? attachmentNodes.get(attachment.r2_key)
        : undefined;
      return node
        ? attachmentBelongsToSelectedAlternative(node, selectedParts)
        : true;
    });
    const selectedAttachmentKeys = new Set(
      selectedAttachments.flatMap((attachment) =>
        attachment.r2_key ? [attachment.r2_key] : [],
      ),
    );
    const discardedAttachmentKeys = attachments
      .flatMap((attachment) => (attachment.r2_key ? [attachment.r2_key] : []))
      .filter((key) => !selectedAttachmentKeys.has(key));
    const externalBody =
      selectedParts.some((part) => Boolean(part.key)) ||
      selectedParts.reduce((total, part) => total + part.size, 0) >
        MAX_INLINE_BODY_BYTES;
    if (externalBody) {
      for (const part of selectedParts) {
        startBufferedBodyUpload(
          dependencies,
          part,
          objectKeys,
          attemptedPutKeys,
          sinkPromises,
          preflight,
        );
      }
      await Promise.all(sinkPromises);
    }
    const retainedTextKeys = new Set(
      externalBody
        ? selectedParts.flatMap((part) => (part.key ? [part.key] : []))
        : [],
    );
    const discardedTextKeys = textParts
      .flatMap((part) => (part.key ? [part.key] : []))
      .filter((key) => !retainedTextKeys.has(key));
    const bodyObjects: StoredEmailBodyObject[] = externalBody
      ? selectedParts
          .filter((part) => part.key)
          .map((part) => ({
            id: `${options.messageId}-body-${part.partIndex}`,
            email_id: options.messageId,
            part_index: part.partIndex,
            content_type: part.contentType,
            charset: part.charset,
            r2_key: part.key!,
            byte_length: part.size,
          }))
      : [];
    const parsed: Email = {
      ...parsedHeaders,
      ...selected.body,
      attachments: [],
    };
    const derivedContentProof = validateInboundDerivedContentProjectionProof({
      emailId: options.messageId,
      projectionAttemptId,
      objects: [
        ...attachments.flatMap((attachment) =>
          attachment.r2_key
            ? [{ r2Key: attachment.r2_key, byteLength: attachment.size }]
            : [],
        ),
        ...textParts.flatMap((part) =>
          part.key ? [{ r2Key: part.key, byteLength: part.size }] : [],
        ),
      ],
    });
    const proofKeys = new Set(derivedContentProof.map(({ r2Key }) => r2Key));
    if (
      proofKeys.size !== objectKeys.length ||
      objectKeys.some((key) => !proofKeys.has(key))
    ) {
      throw new Error("Inbound projection object proof is incomplete");
    }
    consumeStarted = true;
    let consumption: Awaited<ReturnType<typeof consume>>;
    try {
      consumption = await consume({
        parsed,
        attachments: selectedAttachments,
        bodyObjects,
        derivedContentProof,
        projectionAttemptId,
        activateCommand: async (commandFingerprint) => {
          await preflight.activateCommand(commandFingerprint);
        },
      });
    } catch (error) {
      if (
        failureCleanup === "message_aware" &&
        error instanceof InboundProjectionOutcomeError
      ) {
        validateStreamingProjectionCleanup(
          error.projectionResult,
          derivedContentProof,
        );
        if (preflight.hasStarted()) await preflight.resolveProjection();
      }
      throw error;
    }
    if (failureCleanup === "message_aware" && preflight.hasStarted()) {
      await preflight.resolveProjection();
    }
    const cleanupKeys =
      failureCleanup === "attempt_owned"
        ? !consumption.keepDerivedObjects
          ? objectKeys
          : [...discardedTextKeys, ...discardedAttachmentKeys]
        : (consumption.cleanupKeys ?? []);
    if (failureCleanup === "attempt_owned") {
      if (!cleanupIntent || !cleanupIntentBucket) {
        throw new Error("Cleanup intent was not initialized");
      }
      await cleanupAttemptOwnedObjects(dependencies, {
        messageId: options.messageId,
        projectionAttemptId,
        keys: cleanupKeys,
        operation: "projection_staging_cleanup",
      });
    }
    return parsed;
  } catch (error) {
    activeLeaf?.abort(error);
    await Promise.allSettled(sinkPromises);
    const safeRepairFailure =
      failureCleanup === "attempt_owned" &&
      error instanceof DerivedEmailConsumerError &&
      error.commitState === "not_committed";
    if (
      !(error instanceof PostUploadFenceLossError) &&
      preflight.hasStarted() &&
      (!consumeStarted || safeRepairFailure)
    ) {
      let abandonmentVerified = false;
      try {
        abandonmentVerified = await preflight.abandon();
      } catch {
        // A failed or ambiguous fence transition cannot authorize deletion.
      }
      if (abandonmentVerified) {
        await cleanupKnownPreProjectionFailure(dependencies, {
          messageId: options.messageId,
          projectionAttemptId,
          keys: attemptedPutKeys,
        });
      }
    }
    throw error;
  }
}
