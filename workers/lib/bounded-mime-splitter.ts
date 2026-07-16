import { Transform, type TransformCallback } from "node:stream";
import {
  Splitter,
  type MimeNode,
  type SplitterChunk,
} from "@zone-eu/mailsplit";

const MAILSPLIT_HEAD_STATE = 0x01;
const MAILSPLIT_BODY_STATE = 0x02;
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const MAX_MIME_BOUNDARY_BYTES = 70;

type ProcessLineCallback = (
  error?: (Error & { code?: string }) | null,
  data?: SplitterChunk | false,
  flush?: boolean,
) => void;

type SplitterInternals = {
  state: number;
  node: MimeNode;
  processLine(
    line: Buffer | false,
    final: boolean,
    callback: ProcessLineCallback,
  ): void;
};

type BoundaryMatch = {
  boundary: Buffer;
  closing: boolean;
  normalizedLine: Buffer;
};

type BoundaryTrieNode = {
  boundary: BoundaryReference | null;
  children: Map<number, BoundaryTrieNode>;
};

type BoundaryReference = {
  value: Buffer;
  priority: number;
};

function boundaryTrieNode(): BoundaryTrieNode {
  return { boundary: null, children: new Map() };
}

class PackedPadding {
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
    if (byte === 0x09) this.#bits[byteIndex] |= 1 << (this.#length & 7);
    this.#length += 1;
  }

  clear(): void {
    this.#length = 0;
  }

  async drain(write: (value: Uint8Array) => Promise<void>): Promise<void> {
    let offset = 0;
    while (offset < this.#length) {
      const length = Math.min(OUTPUT_CHUNK_BYTES, this.#length - offset);
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

function boundaryBytes(value: Buffer | false): Buffer | null {
  if (!value || value.length === 0) return null;
  if (value.length > MAX_MIME_BOUNDARY_BYTES) {
    throw Object.assign(new Error("MIME_MULTIPART_BOUNDARY_INVALID"), {
      code: "MIME_MULTIPART_BOUNDARY_INVALID",
    });
  }
  return value;
}

/**
 * Version-pinned body scanner for mailsplit 5.4.14.
 *
 * Mailsplit's stock transform retains an unfinished physical line and repeatedly
 * concatenates it with later chunks. This subclass keeps its bounded header and
 * MIME-node interpretation, but scans body bytes itself. Only a possible MIME
 * boundary prefix is retained; ordinary body bytes are emitted in 64 KiB chunks.
 */
export class BoundedMimeSplitter extends Splitter {
  readonly #maxHeaderBytes: number;
  #headerLine = Buffer.alloc(0);
  #candidate = Buffer.allocUnsafe(256);
  #candidateLength = 0;
  #candidateTrieNode: BoundaryTrieNode | null = null;
  #candidateClosingBoundary: BoundaryReference | null = null;
  #candidateClosingDashes = 0;
  #candidateBoundary: BoundaryMatch | null = null;
  #candidatePadding = new PackedPadding();
  #candidateCarriageReturn = false;
  #pendingLineBreak = Buffer.alloc(0);
  #streamingBodyLine = false;
  #streamingCarriageReturn = false;
  #output = Buffer.allocUnsafe(OUTPUT_CHUNK_BYTES);
  #outputLength = 0;
  #outputNode: MimeNode | null = null;
  #resumeReadable: (() => void) | null = null;
  #boundaryCacheNode: MimeNode | null = null;
  #boundaryCache: Buffer[] = [];
  #boundaryTrie = boundaryTrieNode();

  constructor(options: {
    ignoreEmbedded: boolean;
    maxHeadSize: number;
    maxChildNodes: number;
  }) {
    super(options);
    this.#maxHeaderBytes = options.maxHeadSize;
  }

  #getInternals(): SplitterInternals {
    return this as unknown as SplitterInternals;
  }

  #candidateView(): Buffer {
    return this.#candidate.subarray(0, this.#candidateLength);
  }

  #resetCandidate(): void {
    this.#candidateLength = 0;
    this.#candidateTrieNode = null;
    this.#candidateClosingBoundary = null;
    this.#candidateClosingDashes = 0;
    this.#candidateBoundary = null;
    this.#candidatePadding.clear();
    this.#candidateCarriageReturn = false;
  }

  #appendCandidate(byte: number): void {
    if (this.#candidateLength === this.#candidate.length) {
      const grown = Buffer.allocUnsafe(this.#candidate.length * 2);
      this.#candidate.copy(grown, 0, 0, this.#candidateLength);
      this.#candidate = grown;
    }
    this.#candidate[this.#candidateLength] = byte;
    this.#candidateLength += 1;
  }

  #couldExtendBoundary(byte: number): boolean {
    if (this.#candidateTrieNode?.children.has(byte)) return true;
    return Boolean(
      byte === 0x2d &&
      (this.#candidateClosingDashes === 1 ||
        (this.#candidateClosingDashes === 0 &&
          this.#candidateTrieNode?.boundary)),
    );
  }

  #advanceBoundaryCandidates(byte: number): boolean {
    if (this.#candidateLength < 2) return byte === 0x2d;
    if (this.#candidateLength === 2) {
      this.#candidateTrieNode =
        this.#currentBoundaryTrie().children.get(byte) ?? null;
      return Boolean(this.#candidateTrieNode);
    }

    const nextTrieNode = this.#candidateTrieNode?.children.get(byte) ?? null;
    let closingBoundary: BoundaryReference | null = null;
    let closingDashes = 0;
    if (this.#candidateClosingDashes === 1 && byte === 0x2d) {
      closingBoundary = this.#candidateClosingBoundary;
      closingDashes = 2;
    } else if (
      this.#candidateClosingDashes === 0 &&
      this.#candidateTrieNode?.boundary &&
      byte === 0x2d
    ) {
      closingBoundary = this.#candidateTrieNode.boundary;
      closingDashes = 1;
    }

    this.#candidateTrieNode = nextTrieNode;
    this.#candidateClosingBoundary = closingBoundary;
    this.#candidateClosingDashes = closingDashes;
    return Boolean(this.#candidateTrieNode || closingBoundary);
  }

  override _read(size: number): void {
    const resume = this.#resumeReadable;
    this.#resumeReadable = null;
    super._read(size);
    resume?.();
  }

  async #pushWithBackpressure(data: SplitterChunk): Promise<void> {
    const resumed = new Promise<void>((resolve) => {
      this.#resumeReadable = resolve;
    });
    if (this.push(data)) {
      this.#resumeReadable = null;
      return;
    }
    await resumed;
  }

  async #processLine(line: Buffer | false, final: boolean): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#getInternals().processLine(line, final, (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        void (data ? this.#pushWithBackpressure(data) : Promise.resolve()).then(
          resolve,
          reject,
        );
      });
    });
  }

  async #flushOutput(): Promise<void> {
    if (this.#outputLength === 0 || !this.#outputNode) return;
    const data = {
      node: this.#outputNode,
      type: this.#outputNode.multipart ? "data" : "body",
      value: this.#output.subarray(0, this.#outputLength),
    } satisfies SplitterChunk;
    this.#output = Buffer.allocUnsafe(OUTPUT_CHUNK_BYTES);
    this.#outputLength = 0;
    this.#outputNode = null;
    await this.#pushWithBackpressure(data);
  }

  async #appendBody(value: Uint8Array): Promise<void> {
    if (value.byteLength === 0) return;
    const node = this.#getInternals().node;
    if (this.#outputNode && this.#outputNode !== node)
      await this.#flushOutput();
    let offset = 0;
    while (offset < value.byteLength) {
      this.#outputNode = node;
      const writable = Math.min(
        OUTPUT_CHUNK_BYTES - this.#outputLength,
        value.byteLength - offset,
      );
      this.#output.set(
        value.subarray(offset, offset + writable),
        this.#outputLength,
      );
      this.#outputLength += writable;
      offset += writable;
      if (this.#outputLength === OUTPUT_CHUNK_BYTES) await this.#flushOutput();
    }
  }

  #boundaries(): Buffer[] {
    const currentNode = this.#getInternals().node;
    if (this.#boundaryCacheNode === currentNode) return this.#boundaryCache;
    const boundaries: Buffer[] = [];
    const seen = new Set<string>();
    const trie = boundaryTrieNode();
    let node: MimeNode | false = currentNode;
    while (node) {
      const boundary = boundaryBytes(node._boundary);
      if (boundary) {
        const key = boundary.toString("hex");
        if (!seen.has(key)) {
          seen.add(key);
          boundaries.push(boundary);
          let trieNode = trie;
          for (const byte of boundary) {
            let child = trieNode.children.get(byte);
            if (!child) {
              child = boundaryTrieNode();
              trieNode.children.set(byte, child);
            }
            trieNode = child;
          }
          trieNode.boundary = {
            value: boundary,
            priority: boundaries.length - 1,
          };
        }
      }
      node = node.parentNode as MimeNode | false;
    }
    this.#boundaryCacheNode = currentNode;
    this.#boundaryCache = boundaries;
    this.#boundaryTrie = trie;
    return this.#boundaryCache;
  }

  #currentBoundaryTrie(): BoundaryTrieNode {
    this.#boundaries();
    return this.#boundaryTrie;
  }

  #matchedCandidateBoundary(): BoundaryMatch | null {
    const opening = this.#candidateTrieNode?.boundary ?? null;
    const closing =
      this.#candidateClosingDashes === 2
        ? this.#candidateClosingBoundary
        : null;
    const selected =
      opening && closing
        ? opening.priority <= closing.priority
          ? { reference: opening, closing: false }
          : { reference: closing, closing: true }
        : opening
          ? { reference: opening, closing: false }
          : closing
            ? { reference: closing, closing: true }
            : null;
    if (!selected) return null;
    return {
      boundary: selected.reference.value,
      closing: selected.closing,
      normalizedLine: this.#normalizedBoundary(
        selected.reference.value,
        selected.closing,
      ),
    };
  }

  #normalizedBoundary(boundary: Buffer, closing: boolean): Buffer {
    return Buffer.concat([
      Buffer.from("--"),
      boundary,
      ...(closing ? [Buffer.from("--")] : []),
      Buffer.from("\r\n"),
    ]);
  }

  async #processBoundary(match: BoundaryMatch, final: boolean): Promise<void> {
    const boundaries = this.#boundaries();
    const matchedIndex = boundaries.findIndex((boundary) =>
      boundary.equals(match.boundary),
    );
    for (let index = 0; index < matchedIndex; index += 1) {
      await this.#processLine(
        this.#normalizedBoundary(boundaries[index], true),
        false,
      );
    }
    await this.#processLine(match.normalizedLine, final);
  }

  async #startOrdinaryBodyLine(): Promise<void> {
    await this.#appendBody(this.#pendingLineBreak);
    this.#pendingLineBreak = Buffer.alloc(0);
    await this.#appendBody(this.#candidateView());
    await this.#candidatePadding.drain((value) => this.#appendBody(value));
    if (this.#candidateCarriageReturn)
      await this.#appendBody(Buffer.from("\r"));
    this.#resetCandidate();
    this.#streamingBodyLine = true;
  }

  async #finishCandidateLine(lineEnding: Buffer): Promise<void> {
    const boundary =
      this.#candidateBoundary ?? this.#matchedCandidateBoundary();
    if (boundary) {
      this.#resetCandidate();
      this.#pendingLineBreak = Buffer.alloc(0);
      await this.#flushOutput();
      await this.#processBoundary(boundary, false);
      return;
    }
    await this.#startOrdinaryBodyLine();
    this.#pendingLineBreak = Buffer.from(lineEnding);
    this.#streamingBodyLine = false;
  }

  async #consumeBody(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (!this.#streamingBodyLine) {
        if (chunk[offset] === 0x0a) {
          const ending =
            this.#candidateCarriageReturn ||
            (this.#candidateLength > 0 &&
              this.#candidate[this.#candidateLength - 1] === 0x0d)
              ? Buffer.from("\r\n")
              : Buffer.from("\n");
          if (
            !this.#candidateBoundary &&
            ending.length === 2 &&
            this.#candidateLength > 0
          )
            this.#candidateLength -= 1;
          offset += 1;
          await this.#finishCandidateLine(ending);
          if (this.#getInternals().state === MAILSPLIT_HEAD_STATE) {
            if (offset < chunk.length) {
              await this.#consume(chunk.subarray(offset));
            }
            return;
          }
          continue;
        }
        const byte = chunk[offset];
        if (this.#candidateBoundary) {
          if (this.#candidateCarriageReturn) {
            await this.#startOrdinaryBodyLine();
            continue;
          }
          if (byte === 0x20 || byte === 0x09) {
            this.#candidatePadding.push(byte);
            offset += 1;
            continue;
          }
          if (byte === 0x0d) {
            this.#candidateCarriageReturn = true;
            offset += 1;
            continue;
          }
          await this.#startOrdinaryBodyLine();
          continue;
        }

        if (this.#candidateLength === 0 && byte !== 0x2d && byte !== 0x0d) {
          this.#appendCandidate(byte);
          offset += 1;
          await this.#startOrdinaryBodyLine();
          continue;
        }

        if (byte === 0x20 || byte === 0x09) {
          const boundary = this.#matchedCandidateBoundary();
          if (boundary && !this.#couldExtendBoundary(byte)) {
            this.#candidateBoundary = boundary;
            this.#candidatePadding.push(byte);
            offset += 1;
            continue;
          }
        }
        if (byte === 0x0d) {
          const boundary = this.#matchedCandidateBoundary();
          if (boundary) {
            this.#candidateBoundary = boundary;
            this.#candidateCarriageReturn = true;
            offset += 1;
            continue;
          }
        }

        const remainsBoundaryPrefix = this.#advanceBoundaryCandidates(byte);
        this.#appendCandidate(byte);
        offset += 1;
        const awaitingEmptyLineFeed =
          this.#candidateLength === 1 && this.#candidate[0] === 0x0d;
        if (!awaitingEmptyLineFeed && !remainsBoundaryPrefix) {
          await this.#startOrdinaryBodyLine();
        }
        continue;
      }

      if (this.#streamingCarriageReturn) {
        this.#streamingCarriageReturn = false;
        if (chunk[offset] === 0x0a) {
          this.#pendingLineBreak = Buffer.from("\r\n");
          this.#streamingBodyLine = false;
          offset += 1;
          continue;
        }
        await this.#appendBody(Buffer.from("\r"));
      }

      const lineFeed = chunk.indexOf(0x0a, offset);
      if (lineFeed === -1) {
        const endsWithCarriageReturn = chunk[chunk.length - 1] === 0x0d;
        const end = endsWithCarriageReturn ? chunk.length - 1 : chunk.length;
        await this.#appendBody(chunk.subarray(offset, end));
        this.#streamingCarriageReturn = endsWithCarriageReturn;
        return;
      }
      const hasCarriageReturn =
        lineFeed > offset && chunk[lineFeed - 1] === 0x0d;
      await this.#appendBody(
        chunk.subarray(offset, hasCarriageReturn ? lineFeed - 1 : lineFeed),
      );
      this.#pendingLineBreak = Buffer.from(hasCarriageReturn ? "\r\n" : "\n");
      this.#streamingBodyLine = false;
      offset = lineFeed + 1;
    }
  }

  async #consume(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#getInternals().state === MAILSPLIT_HEAD_STATE) {
        const lineFeed = chunk.indexOf(0x0a, offset);
        const end = lineFeed === -1 ? chunk.length : lineFeed + 1;
        this.#headerLine = Buffer.concat([
          this.#headerLine,
          chunk.subarray(offset, end),
        ]);
        if (this.#headerLine.length > this.#maxHeaderBytes) {
          throw Object.assign(new Error("MIME_HEADER_SIZE_EXCEEDED"), {
            code: "MIME_HEADER_SIZE_EXCEEDED",
          });
        }
        offset = end;
        if (lineFeed === -1) return;
        const line = this.#headerLine;
        this.#headerLine = Buffer.alloc(0);
        await this.#processLine(line, false);
        continue;
      }
      if (this.#getInternals().state !== MAILSPLIT_BODY_STATE) {
        throw new Error("Unsupported mailsplit parser state");
      }
      await this.#consumeBody(chunk.subarray(offset));
      return;
    }
  }

  _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    void this.#consume(Buffer.from(chunk)).then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }

  _flush(callback: TransformCallback): void {
    void (async () => {
      if (this.#getInternals().state === MAILSPLIT_HEAD_STATE) {
        await this.#processLine(this.#headerLine || false, true);
        this.#headerLine = Buffer.alloc(0);
      } else {
        if (this.#streamingCarriageReturn) {
          await this.#appendBody(Buffer.from("\r"));
          this.#streamingCarriageReturn = false;
        }
        if (
          !this.#streamingBodyLine &&
          (this.#candidateLength > 0 || this.#candidateBoundary)
        ) {
          const boundary =
            this.#candidateBoundary ?? this.#matchedCandidateBoundary();
          if (boundary) {
            this.#resetCandidate();
            this.#pendingLineBreak = Buffer.alloc(0);
            await this.#flushOutput();
            await this.#processBoundary(boundary, true);
          } else {
            await this.#startOrdinaryBodyLine();
          }
        }
        await this.#appendBody(this.#pendingLineBreak);
        this.#pendingLineBreak = Buffer.alloc(0);
        await this.#flushOutput();
      }
    })().then(
      () => callback(),
      (error) => callback(error as Error),
    );
  }
}
