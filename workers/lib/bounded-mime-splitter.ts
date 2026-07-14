import { Transform, type TransformCallback } from "node:stream";
import {
  Splitter,
  type MimeNode,
  type SplitterChunk,
} from "@zone-eu/mailsplit";

const MAILSPLIT_HEAD_STATE = 0x01;
const MAILSPLIT_BODY_STATE = 0x02;
const OUTPUT_CHUNK_BYTES = 64 * 1024;

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

function withoutLineEnding(line: Uint8Array): {
  content: Uint8Array;
  lineEnding: Buffer;
} {
  if (line.length === 0 || line[line.length - 1] !== 0x0a) {
    return { content: line, lineEnding: Buffer.alloc(0) };
  }
  if (line.length > 1 && line[line.length - 2] === 0x0d) {
    return {
      content: line.subarray(0, line.length - 2),
      lineEnding: Buffer.from("\r\n"),
    };
  }
  return {
    content: line.subarray(0, line.length - 1),
    lineEnding: Buffer.from("\n"),
  };
}

function boundaryBytes(value: Buffer | false): Buffer | null {
  return value && value.length > 0 ? value : null;
}

function matchBoundaryFor(
  value: Uint8Array,
  boundary: Buffer,
): { closing: boolean } | null {
  const baseLength = boundary.length + 2;
  if (value.length < baseLength) return null;
  for (let index = 0; index < baseLength; index += 1) {
    const expected = index < 2 ? 0x2d : boundary[index - 2];
    if (value[index] !== expected) return null;
  }

  let index = baseLength;
  let closing = false;
  if (value[index] === 0x2d) {
    if (value[index + 1] !== 0x2d) return null;
    closing = true;
    index += 2;
  }
  for (; index < value.length; index += 1) {
    if (value[index] !== 0x20 && value[index] !== 0x09) return null;
  }
  return { closing };
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
  #candidateBoundaries: Buffer[] | null = null;
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
    this.#candidateBoundaries = null;
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

  #boundaryAcceptsByte(
    boundary: Buffer,
    position: number,
    byte: number,
  ): boolean {
    if (position < 2) return byte === 0x2d;
    if (position < boundary.length + 2) return byte === boundary[position - 2];
    if (position === boundary.length + 2) return byte === 0x2d;
    if (position === boundary.length + 3)
      return this.#candidate[position - 1] === 0x2d && byte === 0x2d;
    return false;
  }

  #couldExtendBoundary(byte: number): boolean {
    const boundaries = this.#candidateBoundaries ?? this.#boundaries();
    return boundaries.some((boundary) =>
      this.#boundaryAcceptsByte(boundary, this.#candidateLength, byte),
    );
  }

  #advanceBoundaryCandidates(byte: number): boolean {
    const boundaries = this.#candidateBoundaries ?? this.#boundaries();
    this.#candidateBoundaries = boundaries.filter((boundary) =>
      this.#boundaryAcceptsByte(boundary, this.#candidateLength, byte),
    );
    return this.#candidateBoundaries.length > 0;
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
    const boundaries: Buffer[] = [];
    const seen = new Set<string>();
    let node: MimeNode | false = this.#getInternals().node;
    while (node) {
      const boundary = boundaryBytes(node._boundary);
      if (boundary) {
        const key = boundary.toString("hex");
        if (!seen.has(key)) {
          seen.add(key);
          boundaries.push(boundary);
        }
      }
      node = node.parentNode as MimeNode | false;
    }
    return boundaries;
  }

  #matchBoundary(line: Uint8Array): BoundaryMatch | null {
    const { content } = withoutLineEnding(line);
    const value =
      content.length > 0 && content[content.length - 1] === 0x0d
        ? content.subarray(0, content.length - 1)
        : content;
    for (const boundary of this.#boundaries()) {
      const match = matchBoundaryFor(value, boundary);
      if (!match) continue;
      return {
        boundary,
        closing: match.closing,
        normalizedLine: Buffer.concat([
          Buffer.from("--"),
          boundary,
          ...(match.closing ? [Buffer.from("--")] : []),
          Buffer.from("\r\n"),
        ]),
      };
    }
    return null;
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
      this.#candidateBoundary ??
      this.#matchBoundary(Buffer.concat([this.#candidateView(), lineEnding]));
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

        if (byte === 0x20 || byte === 0x09) {
          const boundary = this.#matchBoundary(this.#candidateView());
          if (boundary && !this.#couldExtendBoundary(byte)) {
            this.#candidateBoundary = boundary;
            this.#candidatePadding.push(byte);
            offset += 1;
            continue;
          }
        }
        if (byte === 0x0d) {
          const boundary = this.#matchBoundary(this.#candidateView());
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
            this.#candidateBoundary ??
            this.#matchBoundary(this.#candidateView());
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
