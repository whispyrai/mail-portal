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
  removeUncommittedEmailObjects,
  putVerifiedEmailObject,
  storeEmailProjection,
  type EmailStorageDependencies,
  type StoredEmailBodyObject,
  type StoreEmailProjectionOptions,
} from "./store-email.ts";

const MAX_MIME_HEADER_BYTES = 128 * 1024;
const MAX_MIME_CHILD_NODES = 512;
const MAX_INLINE_BODY_BYTES = 512 * 1024;
const MIN_TEXT_PART_PREVIEW_BYTES = 4 * 1024;

const PERMANENT_MIME_ERROR_CODES = new Set([
  "MIME_HEADER_SIZE_EXCEEDED",
  "MIME_ROOT_HEADER_MISSING",
  "MIME_MULTIPART_BOUNDARY_MISSING",
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

function isAttachment(node: MimeNode): boolean {
  const contentType = node.contentType || "application/octet-stream";
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
  objectKeys: string[],
  sinkPromises: Promise<unknown>[],
): ActiveLeaf {
  const decoder = decoderForNode(node);
  const attachmentId = `${messageId}-${attachmentIndex}`;
  const filename = sanitizeFilename(node.filename || "untitled");
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
  const upload = putVerifiedEmailObject(dependencies, {
    key,
    value: Readable.toWeb(counter) as ReadableStream,
    expectedSize: () => size,
    messageId,
    objectType: "attachment",
  });
  trackSinkPromise(sinkPromises, upload);
  return {
    node,
    decoder,
    abort(error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      decoder.destroy(failure);
      counter.destroy(failure);
    },
    async finish() {
      await upload;
      attachments.push({
        id: attachmentId,
        email_id: messageId,
        filename,
        mimetype: node.contentType || "application/octet-stream",
        size,
        content_id: node.headers
          ? truncateUtf8Bytes(node.headers.getFirst("content-id") || "", 512) ||
            null
          : null,
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
  sinkPromises: Promise<unknown>[],
): void {
  if (!part.fullBytes || part.key) return;
  const key = part.storageKey;
  part.key = key;
  objectKeys.push(key);
  const upload = putVerifiedEmailObject(dependencies, {
    key,
    value: exactArrayBuffer(part.fullBytes),
    expectedSize: part.size,
    messageId: part.emailId,
    objectType: "body",
  });
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
  bodyStates: BodyStates,
  sinkPromises: Promise<unknown>[],
): ActiveLeaf {
  const decoder = decoderForNode(node);
  const transcoder = new CharsetToUtf8(node.charset);
  const contentType =
    node.contentType === "text/html" ? "text/html" : "text/plain";
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
    upload = putVerifiedEmailObject(dependencies, {
      key,
      value: Readable.toWeb(sink) as ReadableStream,
      expectedSize: () => size,
      messageId,
      objectType: "body",
    });
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
            sinkPromises,
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
  transcoder.once("error", (error) => collector.destroy(error));
  decoder.pipe(transcoder).pipe(collector);
  return {
    node,
    decoder,
    abort(error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      decoder.destroy(failure);
      transcoder.destroy(failure);
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

function relatedRoot(node: MimeNode, children: MimeNode[]): MimeNode | null {
  if (children.length === 0) return null;
  const contentType = node.headers ? node.headers.getFirst("content-type") : "";
  const startMatch = /(?:^|;)\s*start\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(
    contentType,
  );
  const start = (startMatch?.[1] ?? startMatch?.[2] ?? "")
    .trim()
    .replace(/^<|>$/g, "");
  if (!start) return children[0];
  return (
    children.find((child) => {
      const contentId = child.headers
        ? child.headers.getFirst("content-id").trim().replace(/^<|>$/g, "")
        : "";
      return contentId === start;
    }) ?? children[0]
  );
}

function selectBody(
  textParts: TextPart[],
  nodes: MimeNode[],
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
      const root = relatedRoot(node, childNodes);
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
): Promise<Email> {
  const attachments: StoredAttachment[] = [];
  const attachmentNodes = new Map<string, MimeNode>();
  const objectKeys: string[] = [];
  const sinkPromises: Promise<unknown>[] = [];
  const textParts: TextPart[] = [];
  const nodes: MimeNode[] = [];
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

  try {
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
        nodes.push(chunk);
        if (chunk.root) rootNode = chunk;
        if (chunk.multipart) {
          if (!chunk._boundary) {
            throw permanentMimeError("MIME_MULTIPART_BOUNDARY_MISSING");
          }
          continue;
        }
        activeLeaf = isAttachment(chunk)
          ? startAttachment(
              dependencies,
              chunk,
              options.messageId,
              projectionAttemptId,
              attachmentIndex++,
              attachments,
              attachmentNodes,
              objectKeys,
              sinkPromises,
            )
          : startTextPart(
              dependencies,
              chunk,
              options.messageId,
              projectionAttemptId,
              textPartIndex++,
              textParts,
              objectKeys,
              bodyStates,
              sinkPromises,
            );
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
    const selected = selectBody(textParts, nodes);
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
        startBufferedBodyUpload(dependencies, part, objectKeys, sinkPromises);
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
    const projectionStatus = await storeEmailProjection(
      dependencies,
      parsed,
      options,
      selectedAttachments,
      bodyObjects,
    );
    const cleanupKeys =
      projectionStatus === "duplicate"
        ? objectKeys
        : [...discardedTextKeys, ...discardedAttachmentKeys];
    const cleanupResults = await Promise.allSettled(
      cleanupKeys.map((key) => dependencies.bucket.delete(key)),
    );
    const cleanupFailures = cleanupResults.filter(
      (result) => result.status === "rejected",
    ).length;
    if (cleanupFailures > 0) {
      console.error("[mail-store] projection staging cleanup degraded", {
        cleanupFailures,
        messageId: options.messageId,
        operation: "projection_staging_cleanup",
        status: "degraded",
      });
    }
    return parsed;
  } catch (error) {
    activeLeaf?.abort(error);
    await Promise.allSettled(sinkPromises);
    return removeUncommittedEmailObjects(
      dependencies,
      options.messageId,
      objectKeys,
      error,
    );
  }
}
