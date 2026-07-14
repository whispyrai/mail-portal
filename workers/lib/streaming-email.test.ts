import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  IncrementalQuotedPrintableDecoder,
  storeStreamingEmail,
} from "./streaming-email.ts";
import {
  boundedAttachmentStorageFilename,
  sanitizeFilename,
} from "./attachments.ts";
import { putVerifiedEmailObject } from "./store-email.ts";

function streamBytes(
  source: string,
  chunkSize = source.length,
): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, offset + chunkSize);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

async function decodeQuotedPrintable(
  source: string,
  chunkSize: number,
): Promise<string> {
  return decodeQuotedPrintableChunks(
    Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) =>
      source.slice(index * chunkSize, (index + 1) * chunkSize),
    ),
  );
}

async function decodeQuotedPrintableChunks(
  chunksToDecode: string[],
): Promise<string> {
  const decoder = new IncrementalQuotedPrintableDecoder();
  const chunks: Buffer[] = [];
  decoder.on("data", (chunk: Buffer) => chunks.push(chunk));
  Readable.from(chunksToDecode).pipe(decoder);
  await finished(decoder);
  return Buffer.concat(chunks).toString("utf8");
}

function storageHarness(
  options: {
    createStatus?: "duplicate" | "stored";
    putResult?: (
      key: string,
      value: ArrayBuffer | string | ReadableStream,
      actualSize: number,
    ) => unknown;
  } = {},
) {
  const objects = new Map<string, Uint8Array>();
  const deletedKeys: string[] = [];
  let createInput:
    | {
        email: Record<string, unknown>;
        attachments: Array<Record<string, unknown>>;
        bodyObjects: Array<Record<string, unknown>>;
      }
    | undefined;
  let puts = 0;
  return {
    objects,
    deletedKeys,
    get createInput() {
      return createInput;
    },
    get puts() {
      return puts;
    },
    dependencies: {
      bucket: {
        async put(key: string, value: ArrayBuffer | string | ReadableStream) {
          puts += 1;
          const bytes =
            value instanceof ReadableStream
              ? new Uint8Array(await new Response(value).arrayBuffer())
              : typeof value === "string"
                ? new TextEncoder().encode(value)
                : new Uint8Array(value);
          objects.set(key, bytes);
          return options.putResult
            ? options.putResult(key, value, bytes.byteLength)
            : { size: bytes.byteLength };
        },
        async delete(key: string) {
          deletedKeys.push(key);
          objects.delete(key);
        },
      },
      mailbox: {
        async findThreadBySubject() {
          return null;
        },
        async getEmail() {
          return null;
        },
        async createEmail(
          _folder: string,
          email: Record<string, unknown>,
          attachments: Array<Record<string, unknown>>,
          bodyObjects: Array<Record<string, unknown>>,
        ) {
          createInput = { email, attachments, bodyObjects };
          return { status: options.createStatus ?? "stored" };
        },
      },
    },
  };
}

test("incremental quoted-printable decoding is correct at every chunk boundary", async () => {
  const encoded = "alpha=3Dbeta=\r\nnext=20line=ZZtail=";
  for (let chunkSize = 1; chunkSize <= encoded.length; chunkSize += 1) {
    assert.equal(
      await decodeQuotedPrintable(encoded, chunkSize),
      "alpha=betanext line=ZZtail=",
    );
  }
});

test("quoted-printable accepts physical lines above the former limit", async () => {
  const spaces = " ".repeat(70 * 1024);
  assert.equal(await decodeQuotedPrintable(`${spaces}X`, 4093), `${spaces}X`);
  assert.equal(await decodeQuotedPrintable(`${spaces}\r\nX`, 4093), "\r\nX");
});

test("quoted-printable soft breaks accept RFC transport padding across every boundary", async () => {
  const cases = [
    { encoded: "hello=  \r\nworld", expected: "helloworld" },
    { encoded: "hello=\t \r\nworld", expected: "helloworld" },
    { encoded: "hello= \nworld", expected: "helloworld" },
  ];
  for (const { encoded, expected } of cases) {
    for (let first = 0; first <= encoded.length; first += 1) {
      for (let second = first; second <= encoded.length; second += 1) {
        assert.equal(
          await decodeQuotedPrintableChunks([
            encoded.slice(0, first),
            encoded.slice(first, second),
            encoded.slice(second),
          ]),
          expected,
        );
      }
    }
  }
});

test("quoted-printable preserves transport padding when no soft break follows", async () => {
  const encoded = "hello=  X";
  for (let first = 0; first <= encoded.length; first += 1) {
    for (let second = first; second <= encoded.length; second += 1) {
      assert.equal(
        await decodeQuotedPrintableChunks([
          encoded.slice(0, first),
          encoded.slice(first, second),
          encoded.slice(second),
        ]),
        encoded,
      );
    }
  }
});

test("duplicate projection removes attempt-scoped attachment objects", async () => {
  const harness = storageHarness({ createStatus: "duplicate" });
  const source = [
    "From: a@example.com",
    "To: b@example.com",
    "Content-Type: multipart/mixed; boundary=duplicate",
    "",
    "--duplicate",
    "Content-Type: text/plain",
    "",
    "hello",
    "--duplicate",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--duplicate--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 17), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "duplicate-attachment",
  });
  assert.equal(harness.objects.size, 0);
  assert.equal(harness.deletedKeys.length, 1);
  assert.match(harness.deletedKeys[0], /^attachments\/duplicate-attachment\//);
});

test("attachment projection rejects unverifiable R2 upload metadata", async () => {
  const harness = storageHarness({
    putResult: (_key, _value, actualSize) => ({ size: actualSize - 1 }),
  });
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    storeStreamingEmail(harness.dependencies, streamBytes(source, 2), {
      folder: "inbox",
      date: "2026-07-14T00:00:00.000Z",
      messageId: "attachment-integrity",
    }),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "R2_DERIVED_UPLOAD_INTEGRITY_FAILED",
      ),
  );
  assert.equal(harness.objects.size, 0);
});

test("derived object upload rejects missing R2 result metadata", async () => {
  await assert.rejects(
    putVerifiedEmailObject(
      {
        bucket: {
          async put() {},
          async delete() {},
        },
        mailbox: {
          async createEmail() {},
          async findThreadBySubject() {
            return null;
          },
          async getEmail() {
            return null;
          },
        },
      },
      {
        key: "attachments/missing-metadata/proof.bin",
        value: new Uint8Array([1, 2, 3]).buffer,
        expectedSize: 3,
        messageId: "missing-metadata",
        objectType: "attachment",
      },
    ),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "R2_DERIVED_UPLOAD_INTEGRITY_FAILED",
      ),
  );
});

test("unknown-length streams use bounded R2 multipart parts", async () => {
  const partSizes: number[] = [];
  let completedParts = 0;
  let singlePutCalls = 0;
  const bytes = new Uint8Array(5 * 1024 * 1024 + 3);
  bytes.fill(0x61);
  await putVerifiedEmailObject(
    {
      bucket: {
        async put() {
          singlePutCalls += 1;
          return { size: 0 };
        },
        async delete() {},
        async createMultipartUpload() {
          return {
            async uploadPart(partNumber: number, value: ArrayBuffer) {
              partSizes.push(value.byteLength);
              return { partNumber, etag: `part-${partNumber}` };
            },
            async abort() {},
            async complete(parts: Array<{ partNumber: number; etag: string }>) {
              completedParts = parts.length;
              return {
                size: partSizes.reduce((total, size) => total + size, 0),
              };
            },
          };
        },
      },
      mailbox: {
        async createEmail() {},
        async findThreadBySubject() {
          return null;
        },
        async getEmail() {
          return null;
        },
      },
    },
    {
      key: "attachments/multipart/proof.bin",
      value: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 3 * 1024 * 1024));
          controller.enqueue(bytes.subarray(3 * 1024 * 1024));
          controller.close();
        },
      }),
      expectedSize: bytes.byteLength,
      messageId: "multipart",
      objectType: "attachment",
    },
  );
  assert.equal(singlePutCalls, 0);
  assert.deepEqual(partSizes, [5 * 1024 * 1024, 3]);
  assert.equal(completedParts, 2);
});

test("failed multipart streams are aborted", async () => {
  let abortCalls = 0;
  await assert.rejects(
    putVerifiedEmailObject(
      {
        bucket: {
          async put() {
            return { size: 0 };
          },
          async delete() {},
          async createMultipartUpload() {
            return {
              async uploadPart() {
                throw new Error("simulated part failure");
              },
              async abort() {
                abortCalls += 1;
              },
              async complete() {
                return { size: 0 };
              },
            };
          },
        },
        mailbox: {
          async createEmail() {},
          async findThreadBySubject() {
            return null;
          },
          async getEmail() {
            return null;
          },
        },
      },
      {
        key: "attachments/multipart/failure.bin",
        value: streamBytes("a".repeat(5 * 1024 * 1024)),
        expectedSize: 5 * 1024 * 1024,
        messageId: "multipart-failure",
        objectType: "attachment",
      },
    ),
    /simulated part failure/,
  );
  assert.equal(abortCalls, 1);
});

test("buffered body projection rejects unverifiable R2 upload metadata", async () => {
  const harness = storageHarness({
    putResult: (_key, value, actualSize) =>
      value instanceof ArrayBuffer
        ? { size: actualSize + 1 }
        : { size: actualSize },
  });
  const first = Array.from({ length: 6_000 }, () => "a".repeat(50)).join(
    "\r\n",
  );
  const second = Array.from({ length: 6_000 }, () => "b".repeat(50)).join(
    "\r\n",
  );
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/mixed; boundary=buffered",
    "",
    "--buffered",
    "Content-Type: text/plain",
    "",
    first,
    "--buffered",
    "Content-Type: text/plain",
    "",
    second,
    "--buffered--",
    "",
  ].join("\r\n");
  await assert.rejects(
    storeStreamingEmail(harness.dependencies, streamBytes(source, 8192), {
      folder: "inbox",
      date: "2026-07-14T00:00:00.000Z",
      messageId: "buffered-body-integrity",
    }),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "R2_DERIVED_UPLOAD_INTEGRITY_FAILED",
      ),
  );
  assert.equal(harness.objects.size, 0);
});

test("quoted-printable drops only literal trailing line whitespace", async () => {
  const encoded = "keep \t\r\nencoded=20\r\nlf \t\nsoft \t=\r\nbare \rX";
  const expected = "keep\r\nencoded \r\nlf\nsoft \tbare \rX";
  for (let chunkSize = 1; chunkSize <= encoded.length; chunkSize += 1) {
    assert.equal(await decodeQuotedPrintable(encoded, chunkSize), expected);
  }
});

test("ordinary bodies do not add an R2 dependency", async () => {
  const harness = storageHarness();
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes("From: a@example.com\r\nTo: b@example.com\r\n\r\nhello"),
    {
      folder: "inbox",
      date: "2026-07-14T00:00:00.000Z",
      messageId: "small-body",
    },
  );
  assert.equal(harness.puts, 0);
  assert.equal(harness.createInput?.email.body, "hello");
});

test("a minified HTML body above 64 KiB is projected without line buffering", async () => {
  const harness = storageHarness();
  const body = `<html><body>${"content".repeat(11_000)}</body></html>`;
  const source = [
    "From: a@example.com",
    "To: b@example.com",
    "Content-Type: text/html; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 4093), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "long-html-line",
  });
  assert.equal(harness.createInput?.email.body, body);
});

test("more than 500,000 short body lines project successfully", async () => {
  const harness = storageHarness();
  const body = `${"x\n".repeat(500_001)}done`;
  const source = [
    "From: a@example.com",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes(source, 32 * 1024),
    {
      folder: "inbox",
      date: "2026-07-14T00:00:00.000Z",
      messageId: "many-lines",
    },
  );
  assert.equal(harness.createInput?.bodyObjects.length, 1);
  const key = String(harness.createInput?.bodyObjects[0].r2_key);
  assert.equal(new TextDecoder().decode(harness.objects.get(key)), body);
});

test("multipart alternative chooses the last supported representation once", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/alternative; boundary=choice",
    "",
    "--choice",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>basic</p>",
    "--choice",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>richer</p>",
    "--choice--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 7), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "same-type-alternative",
  });
  assert.equal(harness.createInput?.email.body, "<p>richer</p>");
});

test("a large unselected alternative cannot erase a later small selection", async () => {
  const harness = storageHarness();
  const largeUnselected = "x".repeat(512 * 1024);
  const chosen = "<p>chosen</p>";
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/alternative; boundary=choice",
    "",
    "--choice",
    "Content-Type: text/html; charset=utf-8",
    "",
    largeUnselected,
    "--choice",
    "Content-Type: text/html; charset=utf-8",
    "",
    chosen,
    "--choice--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes(source, 64 * 1024),
    {
      folder: "inbox",
      date: "2026-07-14T00:00:00.000Z",
      messageId: "large-unselected-alternative",
    },
  );
  assert.equal(harness.createInput?.email.body, chosen);
  assert.equal(harness.createInput?.bodyObjects.length, 1);
  const key = String(harness.createInput?.bodyObjects[0].r2_key);
  assert.equal(new TextDecoder().decode(harness.objects.get(key)), chosen);
});

test("multipart related honors its start content id and keeps CID resources separate", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    'Content-Type: multipart/related; boundary=related; start="<root-html>"',
    "",
    "--related",
    "Content-Type: text/plain; charset=utf-8",
    "Content-ID: <decoy>",
    "",
    "decoy",
    "--related",
    "Content-Type: text/html; charset=utf-8",
    "Content-ID: <root-html>",
    "",
    '<p>root<img src="cid:image-one" /></p>',
    "--related",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: inline; filename=image.png",
    "Content-ID: <image-one>",
    "",
    "AQID",
    "--related--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 5), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "related-root",
  });
  assert.equal(
    harness.createInput?.email.body,
    '<p>root<img src="cid:image-one" /></p>',
  );
  assert.equal(harness.objects.size, 1);
});

test("false boundary prefixes are preserved at every input-byte boundary", async () => {
  const harness = storageHarness();
  const body = "before\r\n--boundaryX\r\nafter";
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/mixed; boundary=boundary",
    "",
    "--boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "--boundary--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 1), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "false-boundary",
  });
  assert.equal(harness.createInput?.email.body, body);
});

test("outer boundaries recover from truncated nested multiparts", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/mixed; boundary=outer",
    "",
    "--outer",
    "Content-Type: multipart/mixed; boundary=middle",
    "",
    "--middle",
    "Content-Type: multipart/mixed; boundary=inner",
    "",
    "--inner",
    "Content-Type: text/plain",
    "",
    "deep",
    "--outer",
    "Content-Type: text/plain",
    "",
    "outer sibling",
    "--outer--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 11), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "truncated-nesting",
  });
  assert.equal(harness.createInput?.email.body, "deep\nouter sibling");
});

test("multipart boundaries accept arbitrarily long transport padding", async () => {
  const harness = storageHarness();
  const padding = " \t".repeat(128 * 1024);
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/mixed; boundary=padded",
    "",
    `--padded${padding}`,
    "Content-Type: text/plain",
    "",
    "preserved",
    `--padded--${padding}`,
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 4093), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "padded-boundary",
  });
  assert.equal(harness.createInput?.email.body, "preserved");
});

test("multipart mixed preserves independent plain and HTML parts in order", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/mixed; boundary=mixed",
    "",
    "--mixed",
    "Content-Type: text/plain",
    "",
    "plain <safe>",
    "--mixed",
    "Content-Type: text/html",
    "",
    "<p>html</p>",
    "--mixed--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 13), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "mixed-independent",
  });
  assert.equal(
    harness.createInput?.email.body,
    "<pre>plain &lt;safe&gt;</pre><br/>\n<p>html</p>",
  );
});

test("many selected text parts cannot overflow the bounded Mailbox body preview", async () => {
  const harness = storageHarness();
  const boundary = "many-selected-parts";
  const parts = Array.from({ length: 160 }, (_, index) =>
    [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      `${String(index).padStart(3, "0")}:${"x".repeat(4096)}`,
    ].join("\r\n"),
  );
  const source = [
    "From: sender@example.com",
    "To: hello@wiserchat.ai",
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    "",
    ...parts,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  await storeStreamingEmail(harness.dependencies, streamBytes(source, 8191), {
    folder: "inbox",
    date: "2026-07-13T09:30:00.000Z",
    messageId: "bounded-many-part-preview",
    read: false,
  });

  const storedBody = String(harness.createInput?.email.body ?? "");
  assert.ok(new TextEncoder().encode(storedBody).byteLength <= 512 * 1024);
  assert.equal(harness.createInput?.bodyObjects.length, 160);
});

test("attachments from unselected alternatives are discarded", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: multipart/alternative; boundary=alt",
    "",
    "--alt",
    "Content-Type: multipart/related; boundary=first",
    "",
    "--first",
    "Content-Type: text/html",
    "",
    '<p>first<img src="cid:first-image" /></p>',
    "--first",
    "Content-Type: image/png",
    "Content-Disposition: inline; filename=first.png",
    "Content-ID: <first-image>",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--first--",
    "--alt",
    "Content-Type: multipart/related; boundary=second",
    "",
    "--second",
    "Content-Type: text/html",
    "",
    '<p>second<img src="cid:second-image" /></p>',
    "--second",
    "Content-Type: image/png",
    "Content-Disposition: inline; filename=second.png",
    "Content-ID: <second-image>",
    "Content-Transfer-Encoding: base64",
    "",
    "BAUG",
    "--second--",
    "--alt--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 19), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "selected-resources",
  });
  assert.deepEqual(
    harness.createInput?.attachments.map((attachment) => attachment.filename),
    ["second.png"],
  );
  assert.equal(harness.deletedKeys.length, 1);
  assert.match(harness.deletedKeys[0], /first\.png$/);
});

test("oversized Unicode filenames stay inside the R2 key budget", () => {
  const original = `${"📨".repeat(400)}.verylongextension`;
  const displayFilename = sanitizeFilename(original);
  const storageFilename = boundedAttachmentStorageFilename(displayFilename);
  assert.equal(displayFilename, original);
  assert.ok(new TextEncoder().encode(storageFilename).byteLength <= 240);
  assert.ok(storageFilename.endsWith(".verylongextension"));
});

test("missing multipart boundaries are quarantinable instead of becoming blank mail", async () => {
  const harness = storageHarness();
  await assert.rejects(
    storeStreamingEmail(
      harness.dependencies,
      streamBytes(
        "From: a@example.com\r\nContent-Type: multipart/mixed\r\n\r\nbody",
      ),
      {
        folder: "inbox",
        date: "2026-07-14T00:00:00.000Z",
        messageId: "missing-boundary",
      },
    ),
    (error: unknown) =>
      Boolean(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "MIME_MULTIPART_BOUNDARY_MISSING",
      ),
  );
});

test("an empty HTML alternative cannot discard a large plain-text body", async () => {
  const harness = storageHarness();
  const plainBody = Array.from({ length: 10_600 }, () => "p".repeat(50)).join(
    "\r\n",
  );
  const source = [
    "From: a@example.com",
    "To: b@example.com",
    "Content-Type: multipart/alternative; boundary=choice",
    "",
    "--choice",
    "Content-Type: text/plain; charset=utf-8",
    "",
    plainBody,
    "--choice",
    "Content-Type: text/html; charset=utf-8",
    "",
    "",
    "--choice--",
    "",
  ].join("\r\n");
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 8192), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "plain-fallback",
  });
  assert.equal(harness.createInput?.bodyObjects.length, 1);
  assert.equal(harness.createInput?.bodyObjects[0].content_type, "text/plain");
  const key = String(harness.createInput?.bodyObjects[0].r2_key);
  assert.match(key, /^email-bodies\/plain-fallback\/[^/]+\/0\.body$/);
  assert.equal(new TextDecoder().decode(harness.objects.get(key)), plainBody);
});
