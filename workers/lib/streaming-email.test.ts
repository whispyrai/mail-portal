import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  DerivedEmailConsumerError,
  deriveStreamingEmail,
  IncrementalFlowedDecoder,
  IncrementalQuotedPrintableDecoder,
  storeStreamingEmail as storeStreamingEmailProduction,
} from "./streaming-email.ts";
import {
  boundedAttachmentStorageFilename,
  sanitizeFilename,
} from "./attachments.ts";
import { putVerifiedEmailObject } from "./store-email.ts";
import { liveInboundProjectionOptions } from "./live-inbound-projection.ts";
import {
  INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
  persistPendingRepairAttempt,
} from "./inbound-derived-content-repair-attempt.ts";
import type { InboundCleanupIntentBucket } from "./inbound-derived-content-cleanup-intent.ts";

async function storeStreamingEmail(
  dependencies: Parameters<typeof storeStreamingEmailProduction>[0] & {
    cleanupIntentBucket: InboundCleanupIntentBucket;
  },
  raw: Parameters<typeof storeStreamingEmailProduction>[1],
  options: Parameters<typeof storeStreamingEmailProduction>[2],
) {
  return storeStreamingEmailProduction(dependencies, raw, {
    ...liveInboundProjectionOptions({
      mailboxId: "hello@wiserchat.ai",
      messageId: options.messageId,
      date: options.date,
    }),
    ...options,
  }, dependencies.cleanupIntentBucket);
}

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

function alternativeAttachmentSource(): string {
  return [
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
}

function singleAttachmentSource(): string {
  return [
    "From: a@example.com",
    "To: b@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
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

async function decodeFlowed(
  source: string,
  delSp: boolean,
  chunkSize: number,
): Promise<string> {
  const decoder = new IncrementalFlowedDecoder(delSp);
  const chunks: Buffer[] = [];
  decoder.on("data", (chunk: Buffer) => chunks.push(chunk));
  Readable.from(
    Array.from({ length: Math.ceil(source.length / chunkSize) }, (_, index) =>
      source.slice(index * chunkSize, (index + 1) * chunkSize),
    ),
  ).pipe(decoder);
  await finished(decoder);
  return Buffer.concat(chunks).toString("utf8");
}

function cleanupIntentHarness(input?: {
  events?: string[];
  loseFenceOnRead?: number;
  rejectResolvedTransition?: boolean;
}) {
  const objects = new Map<string, { value: string; etag: string }>();
  let revision = 0;
  let reads = 0;
  const bucket: InboundCleanupIntentBucket = {
    async get(key) {
      input?.events?.push("intent:get");
      reads += 1;
      const stored = objects.get(key);
      if (stored && reads === input?.loseFenceOnRead) {
        const current = JSON.parse(stored.value);
        const abandonedAt = "2026-07-15T00:20:01.000Z";
        revision += 1;
        objects.set(key, {
          etag: `cleanup-etag-${revision}`,
          value: JSON.stringify({
            ...current,
            status: "abandoned",
            revision: current.revision + 1,
            leaseUntil: abandonedAt,
            abandonedAt,
          }),
        });
      }
      const current = objects.get(key);
      return current
        ? {
            etag: current.etag,
            async text() {
              return current.value;
            },
          }
        : null;
    },
    async put(key, value, options) {
      input?.events?.push("intent:put");
      const current = objects.get(key);
      if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
      if (
        options?.onlyIf?.etagMatches &&
        current?.etag !== options.onlyIf.etagMatches
      )
        return null;
      if (
        input?.rejectResolvedTransition &&
        options?.onlyIf?.etagMatches &&
        JSON.parse(value).status === "projection_resolved"
      ) {
        return null;
      }
      revision += 1;
      objects.set(key, { value, etag: `cleanup-etag-${revision}` });
      return {};
    },
    async delete(key) {
      input?.events?.push("intent:delete");
      objects.delete(key);
    },
  };
  return { bucket, objects };
}

function storageHarness(
  options: {
    createStatus?:
      | "cleanup_conflict"
      | "deleted"
      | "duplicate"
      | "stored"
      | "terminal";
    createResult?: unknown;
    createError?: Error;
    cleanupKeySuffixes?: string[];
    events?: string[];
    rejectResolvedTransition?: boolean;
    deleteResult?: (key: string) => void;
    enqueueCleanup?: (input: {
      emailId: string;
      projectionAttemptId: string;
      keys: string[];
    }) => Promise<{ queued: number }>;
    putResult?: (
      key: string,
      value: ArrayBuffer | string | ReadableStream,
      actualSize: number,
    ) => unknown;
  } = {},
) {
  const objects = new Map<string, Uint8Array>();
  const cleanup = cleanupIntentHarness({
    events: options.events,
    rejectResolvedTransition: options.rejectResolvedTransition,
  });
  const deletedKeys: string[] = [];
  const deleteBatches: Array<{ bulk: boolean; keys: string[] }> = [];
  let createInput:
    | {
        email: Record<string, unknown>;
        attachments: Array<Record<string, unknown>>;
        bodyObjects: Array<Record<string, unknown>>;
        projectionAttemptId?: string;
        derivedContentProof?: Array<{ r2Key: string; byteLength: number }>;
      }
    | undefined;
  let puts = 0;
  return {
    objects,
    cleanupIntentBucket: cleanup.bucket,
    cleanupIntentObjects: cleanup.objects,
    deletedKeys,
    deleteBatches,
    get createInput() {
      return createInput;
    },
    get puts() {
      return puts;
    },
    dependencies: {
      cleanupIntentBucket: cleanup.bucket,
      bucket: {
        async put(key: string, value: ArrayBuffer | string | ReadableStream) {
          options.events?.push("derived:put");
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
        async delete(input: string | string[]) {
          options.events?.push("derived:delete");
          const keys = Array.isArray(input) ? input : [input];
          deleteBatches.push({ bulk: Array.isArray(input), keys });
          for (const key of keys) {
            deletedKeys.push(key);
            options.deleteResult?.(key);
            objects.delete(key);
          }
        },
      },
      mailbox: {
        async findThreadBySubject() {
          return null;
        },
        async getEmail() {
          options.events?.push("mailbox:getEmail");
          return null;
        },
        ...(options.enqueueCleanup
          ? {
              async enqueueUnownedInboundDerivedContentCleanup(input: {
                emailId: string;
                projectionAttemptId: string;
                keys: string[];
              }) {
                options.events?.push("mailbox:cleanup");
                return options.enqueueCleanup!(input);
              },
            }
          : {}),
        async createEmail(
          _folder: string,
          email: Record<string, unknown>,
          attachments: Array<Record<string, unknown>>,
          bodyObjects: Array<Record<string, unknown>>,
        ) {
          createInput = { email, attachments, bodyObjects };
          return { status: options.createStatus ?? "stored" };
        },
        async createInboundEmail(command: {
          email: Record<string, unknown>;
          attachments: Array<Record<string, unknown>>;
          bodyObjects: Array<Record<string, unknown>>;
          projectionAttemptId?: string;
          derivedContentProof?: Array<{ r2Key: string; byteLength: number }>;
        }) {
          options.events?.push("mailbox:create");
          if (options.createError) throw options.createError;
          if (options.createResult !== undefined) return options.createResult as never;
          createInput = {
            email: command.email,
            attachments: command.attachments,
            bodyObjects: command.bodyObjects,
            projectionAttemptId: command.projectionAttemptId,
            derivedContentProof: command.derivedContentProof,
          };
          const ownedKeys = new Set([
            ...command.attachments.flatMap((attachment) =>
              typeof attachment.r2_key === "string" ? [attachment.r2_key] : [],
            ),
            ...command.bodyObjects.flatMap((bodyObject) =>
              typeof bodyObject.r2_key === "string" ? [bodyObject.r2_key] : [],
            ),
          ]);
          return {
            status: options.createStatus ?? "stored",
            cleanupKeys: command.derivedContentProof
              ?.filter(({ r2Key }) => {
                if (options.cleanupKeySuffixes) {
                  return options.cleanupKeySuffixes.some((suffix) =>
                    r2Key.endsWith(suffix),
                  );
                }
                return (
                  options.createStatus === "duplicate" || !ownedKeys.has(r2Key)
                );
              })
              .map(({ r2Key }) => r2Key),
          };
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

test("format=flowed obeys DelSp, stuffing, quoting, and signature boundaries", async () => {
  const source = [
    " alpha ",
    "beta",
    "> quoted ",
    "> continuation",
    ">> deeper ",
    "-- ",
    "signature",
  ].join("\r\n");
  const withoutDeletedSpaces =
    "alpha beta\r\n>quoted continuation\r\n>>deeper \r\n-- \r\nsignature";
  const withDeletedSpaces =
    "alphabeta\r\n>quotedcontinuation\r\n>>deeper\r\n-- \r\nsignature";

  for (let chunkSize = 1; chunkSize <= 32; chunkSize += 1) {
    assert.equal(
      await decodeFlowed(source, false, chunkSize),
      withoutDeletedSpaces,
    );
    assert.equal(
      await decodeFlowed(source, true, chunkSize),
      withDeletedSpaces,
    );
  }
});

test("format=flowed preserves a non-conforming overlong line without buffering it", async () => {
  const source = `${"x".repeat(9 * 1024)} \r\nnext`;
  assert.equal(await decodeFlowed(source, false, 17), source);
});

test("streaming projection applies format=flowed after transfer and charset decoding", async () => {
  const harness = storageHarness();
  const source = [
    "From: flowed@example.com",
    "Content-Type: text/plain; charset=utf-8; format=flowed; delsp=yes",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "joined=20",
    "without-gap",
  ].join("\r\n");

  await storeStreamingEmail(harness.dependencies, streamBytes(source, 1), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "flowed-pipeline",
  });

  assert.equal(harness.createInput?.email.body, "joinedwithout-gap");
});

test("duplicate projection leaves attempt-scoped cleanup to the durable outbox", async () => {
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
  assert.equal(harness.objects.size, 1);
  assert.equal(harness.deletedKeys.length, 0);
  const [intent] = harness.cleanupIntentObjects.values();
  assert.equal(JSON.parse(intent.value).status, "projection_resolved");
});

test("repair derivation deletes attempt objects when the consumer proves no commit", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-not-committed",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        throw new DerivedEmailConsumerError(
          "not_committed",
          new Error("simulated RPC failure"),
        );
      },
      harness.cleanupIntentBucket,
    ),
    /simulated RPC failure/,
  );
  assert.equal(harness.objects.size, 0);
  assert.equal(harness.deletedKeys.length, 1);
});

test("repair derivation preserves attempt objects when commit verification is unavailable", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-unverified",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        throw new DerivedEmailConsumerError(
          "unverified",
          new Error("simulated verification outage"),
        );
      },
      harness.cleanupIntentBucket,
    ),
    /simulated verification outage/,
  );
  assert.equal(harness.objects.size, 1);
  assert.equal(harness.deletedKeys.length, 0);
});

test("repair derivation cleans attempt objects when upload verification fails before consumption", async () => {
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
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-upload-failure",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        assert.fail("consumer must not run after upload verification failure");
      },
      harness.cleanupIntentBucket,
    ),
    /R2 stored 2 bytes; expected 3/,
  );
  assert.equal(harness.objects.size, 0);
  assert.equal(harness.deletedKeys.length, 1);
});

test("repair derivation durably queues only failed pre-consumer deletions after bounded RPC retries", async () => {
  let enqueueAttempts = 0;
  const queued: Array<{
    emailId: string;
    projectionAttemptId: string;
    keys: string[];
  }> = [];
  const harness = storageHarness({
    deleteResult(key) {
      if (key.endsWith("proof.bin"))
        throw new Error(`delete failed for ${key}`);
    },
    async enqueueCleanup(input) {
      enqueueAttempts += 1;
      if (enqueueAttempts < 3) throw new Error("transient RPC failure");
      queued.push(input);
      return { queued: input.keys.length };
    },
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
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-delete-failure",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        throw new DerivedEmailConsumerError(
          "not_committed",
          new Error("consumer rejected repair"),
        );
      },
      harness.cleanupIntentBucket,
    ),
    /consumer rejected repair/,
  );
  assert.equal(enqueueAttempts, 3);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].emailId, "repair-delete-failure");
  assert.match(
    queued[0].projectionAttemptId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(queued[0].keys.length, 1);
  assert.equal(queued[0].keys[0], harness.deletedKeys[0]);
});

test("repair preflight is durable before the first upload and abandoned after a proven failure", async () => {
  let sawPreflightBeforeUpload = false;
  let harness: ReturnType<typeof storageHarness>;
  harness = storageHarness({
    putResult(_key, _value, actualSize) {
      sawPreflightBeforeUpload = harness.cleanupIntentObjects.size === 1;
      return { size: actualSize };
    },
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
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-intent-order",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        throw new DerivedEmailConsumerError("not_committed", new Error("stop"));
      },
      harness.cleanupIntentBucket,
    ),
    /stop/,
  );
  assert.equal(sawPreflightBeforeUpload, true);
  assert.equal(harness.cleanupIntentObjects.size, 1);
  const [stored] = harness.cleanupIntentObjects.values();
  assert.equal(JSON.parse(stored.value).status, "abandoned");
});

test("a post-upload fence loss guards the exact late key and never reaches the repair consumer", async () => {
  const queued: Array<{
    emailId: string;
    projectionAttemptId: string;
    keys: string[];
  }> = [];
  const harness = storageHarness({
    async enqueueCleanup(input) {
      queued.push(input);
      return { queued: input.keys.length };
    },
  });
  const cleanup = cleanupIntentHarness({ loseFenceOnRead: 4 });
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=late.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-fence-loss",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        assert.fail("consumer must not run after the preflight fence is lost");
      },
      cleanup.bucket,
    ),
    /fence was lost/,
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0].emailId, "repair-fence-loss");
  assert.equal(queued[0].keys.length, 1);
  assert.match(queued[0].keys[0], /\/late\.bin$/);
});

test("unverifiable cleanup preflight prevents every derived upload", async () => {
  const events: string[] = [];
  const harness = storageHarness({
    async enqueueCleanup() {
      events.push("outbox-attempt");
      throw new Error("Mailbox outbox unavailable");
    },
  });
  const cleanupIntentBucket = {
    async put() {
      events.push("intent-put");
      throw new Error("RAW unavailable");
    },
    async get() {
      events.push("intent-reread");
      throw new Error("RAW unavailable");
    },
    async delete() {
      assert.fail("unproven intent must not be deleted");
    },
  };
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-dual-cleanup-outage",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async () => {
        throw new DerivedEmailConsumerError("not_committed", new Error("stop"));
      },
      cleanupIntentBucket,
    ),
    (error: unknown) =>
      error instanceof DerivedEmailConsumerError &&
      error.commitState === "unverified",
  );
  assert.deepEqual(events, ["intent-put", "intent-reread"]);
  assert.equal(harness.objects.size, 0);
});

test("repair derivation cleans attempt objects when pending intent cannot be proven", async () => {
  const harness = storageHarness();
  const source = [
    "From: a@example.com",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
  ].join("\r\n");
  await assert.rejects(
    deriveStreamingEmail(
      harness.dependencies,
      streamBytes(source, 3),
      liveInboundProjectionOptions({
        mailboxId: "hello@wiserchat.ai",
        messageId: "repair-pending-failure",
        date: "2026-07-15T00:00:00.000Z",
      }),
      async (derived) => {
        const persisted = await persistPendingRepairAttempt(
          {
            async put() {
              throw new Error("pending ledger unavailable");
            },
            async get() {
              return null;
            },
          } as never,
          {
            schemaVersion: INBOUND_REPAIR_ATTEMPT_SCHEMA_VERSION,
            kind: "inbound_derived_content_repair_attempt",
            status: "pending",
            attemptId: derived.projectionAttemptId,
            ingressId: "repair-pending-failure",
            mailboxId: "hello@wiserchat.ai",
            expectedGeneration: 1,
            markerId: "marker_12345678",
            commandFingerprint: "a".repeat(64),
            createdAt: "2026-07-15T00:00:00.000Z",
            proof: {
              attachments: derived.attachments.map((attachment) => ({
                r2Key: attachment.r2_key!,
                byteLength: attachment.size,
              })),
              bodyObjects: [],
            },
          },
        );
        if (!persisted) {
          throw new DerivedEmailConsumerError(
            "not_committed",
            new Error("pending intent unproven"),
          );
        }
        return { keepDerivedObjects: true };
      },
      harness.cleanupIntentBucket,
    ),
    /pending intent unproven/,
  );
  assert.equal(harness.objects.size, 0);
  assert.equal(harness.deletedKeys.length, 1);
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

test("derived upload and multipart abort logs never expose exact object keys or raw errors", async () => {
  const secretKey =
    "attachments/private-message/private-attempt/private-object.bin";
  const logged: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
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
                  throw new Error(`upload failed for ${secretKey}`);
                },
                async abort() {
                  throw new Error(`abort failed for ${secretKey}`);
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
          key: secretKey,
          value: streamBytes("a".repeat(5 * 1024 * 1024)),
          expectedSize: 5 * 1024 * 1024,
          messageId: "private-message",
          objectType: "attachment",
        },
      ),
    );
  } finally {
    console.error = originalError;
  }
  const serializedLogs = JSON.stringify(logged);
  assert.equal(serializedLogs.includes(secretKey), false);
  assert.equal(serializedLogs.includes("upload failed for"), false);
  assert.equal(serializedLogs.includes("abort failed for"), false);
  assert.equal(serializedLogs.includes("R2_MULTIPART_ABORT_FAILED"), true);
  assert.equal(serializedLogs.includes("R2_DERIVED_UPLOAD_FAILED"), true);
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

test(
  "false boundary prefixes stay linear under deeply nested multipart boundaries",
  { timeout: 15_000 },
  async () => {
    const harness = storageHarness();
    const depth = 480;
    const body = Array.from(
      { length: 20_000 },
      () => "--b\r\n--b \r\n--bX\r\nordinary",
    ).join("\r\n");
    const sourceParts = [
      "From: nested@example.com",
      "Content-Type: multipart/mixed; boundary=b0",
      "",
    ];
    for (let index = 0; index < depth - 1; index += 1) {
      sourceParts.push(
        `--b${index}`,
        `Content-Type: multipart/mixed; boundary=b${index + 1}`,
        "",
      );
    }
    sourceParts.push(
      `--b${depth - 1}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    );
    for (let index = depth - 1; index >= 0; index -= 1)
      sourceParts.push(`--b${index}--`);
    sourceParts.push("");

    await storeStreamingEmail(
      harness.dependencies,
      streamBytes(sourceParts.join("\r\n"), 8191),
      {
        folder: "inbox",
        date: "2026-07-14T00:00:00.000Z",
        messageId: "deep-linear-boundaries",
      },
    );

    const bodyKey = String(harness.createInput?.bodyObjects[0].r2_key);
    const projectedBody = new TextDecoder().decode(
      harness.objects.get(bodyKey),
    );
    assert.equal(projectedBody.length, body.length);
    let mismatch = -1;
    for (let index = 0; index < body.length; index += 1) {
      if (projectedBody[index] !== body[index]) {
        mismatch = index;
        break;
      }
    }
    assert.equal(
      mismatch,
      -1,
      `body mismatch near ${JSON.stringify(projectedBody.slice(Math.max(0, mismatch - 20), mismatch + 40))}`,
    );
  },
);

test("multipart boundaries longer than RFC 2046 permits are rejected before trie construction", async () => {
  const boundary = "b".repeat(71);
  for (const [messageId, body] of [
    ["oversized-boundary-delimited", `--${boundary}\r\nbody`],
    ["oversized-boundary-ordinary", "ordinary body"],
  ] as const) {
    const harness = storageHarness();
    await assert.rejects(
      storeStreamingEmail(
        harness.dependencies,
        streamBytes(
          [
            "From: a@example.com",
            `Content-Type: multipart/mixed; boundary=${boundary}`,
            "",
            body,
          ].join("\r\n"),
          17,
        ),
        {
          folder: "inbox",
          date: "2026-07-14T00:00:00.000Z",
          messageId,
        },
      ),
      (error: unknown) =>
        Boolean(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "MIME_MULTIPART_BOUNDARY_INVALID",
        ),
    );
  }
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

test("multipart digest defaults children without Content-Type to message/rfc822", async () => {
  const harness = storageHarness();
  const embedded = [
    "From: nested@example.com",
    "To: recipient@example.com",
    "Subject: preserved embedded message",
    "",
    "embedded body",
  ].join("\r\n");
  const source = [
    "From: digest@example.com",
    "Content-Type: multipart/digest; boundary=digest",
    "",
    "--digest",
    "",
    embedded,
    "--digest--",
    "",
  ].join("\r\n");

  await storeStreamingEmail(harness.dependencies, streamBytes(source, 7), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "implicit-digest-message",
  });

  assert.equal(harness.createInput?.email.body, "");
  assert.equal(harness.createInput?.attachments.length, 1);
  assert.equal(harness.createInput?.attachments[0].mimetype, "message/rfc822");
  assert.equal(harness.createInput?.attachments[0].filename, "message.eml");
  const key = String(harness.createInput?.attachments[0].r2_key);
  assert.equal(new TextDecoder().decode(harness.objects.get(key)), embedded);
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

test("unselected alternatives are delegated to the durable cleanup outbox", async () => {
  const harness = storageHarness();
  const source = alternativeAttachmentSource();
  await storeStreamingEmail(harness.dependencies, streamBytes(source, 19), {
    folder: "inbox",
    date: "2026-07-14T00:00:00.000Z",
    messageId: "selected-resources",
  });
  assert.deepEqual(
    harness.createInput?.attachments.map((attachment) => attachment.filename),
    ["second.png"],
  );
  assert.equal(harness.deletedKeys.length, 0);
});

test("normal streaming proves every verified attempt object before Mailbox acceptance", async () => {
  const harness = storageHarness();
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes(alternativeAttachmentSource(), 19),
    {
      folder: "inbox",
      date: "2026-07-15T00:00:00.000Z",
      messageId: "normal-attempt-proof",
    },
  );

  assert.match(
    harness.createInput?.projectionAttemptId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(
    harness.createInput?.derivedContentProof?.map(({ r2Key, byteLength }) => ({
      filename: r2Key.split("/").at(-1),
      byteLength,
    })),
    [
      { filename: "first.png", byteLength: 3 },
      { filename: "second.png", byteLength: 3 },
    ],
  );
  assert.equal(
    new Set(harness.createInput?.derivedContentProof?.map(({ r2Key }) => r2Key))
      .size,
    harness.createInput?.derivedContentProof?.length,
  );
});

test("inline-only normal projection never creates a cleanup intent", async () => {
  const events: string[] = [];
  const harness = storageHarness({ events });
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes("From: a@example.com\r\nTo: b@example.com\r\n\r\ninline"),
    {
      folder: "inbox",
      date: "2026-07-15T00:00:00.000Z",
      messageId: "normal-inline-only",
    },
  );
  assert.equal(harness.cleanupIntentObjects.size, 0);
  assert.equal(harness.puts, 0);
  assert.deepEqual(events, ["mailbox:create"]);
});

test("normal projection persists intent before the first put and uses exactly 2n+6 service calls", async () => {
  const events: string[] = [];
  const harness = storageHarness({ events });
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes(alternativeAttachmentSource(), 19),
    {
      folder: "inbox",
      date: "2026-07-15T00:00:00.000Z",
      messageId: "normal-call-budget",
    },
  );
  assert.deepEqual(events, [
    "intent:put",
    "intent:get",
    "derived:put",
    "intent:get",
    "derived:put",
    "intent:get",
    "mailbox:create",
    "intent:get",
    "intent:put",
    "intent:get",
  ]);
  const derivedPuts = events.filter((event) => event === "derived:put").length;
  assert.equal(derivedPuts, 2);
  assert.equal(events.length - derivedPuts, derivedPuts + 6);
  assert.equal(events.length, 2 * derivedPuts + 6);
});

test("all structurally valid normal Mailbox outcomes resolve the cleanup intent", async () => {
  for (const status of [
    "stored",
    "duplicate",
    "deleted",
    "terminal",
    "cleanup_conflict",
  ] as const) {
    const harness = storageHarness(
      status === "cleanup_conflict"
        ? { createResult: { status } }
        : { createStatus: status },
    );
    const operation = storeStreamingEmail(
      harness.dependencies,
      streamBytes(singleAttachmentSource(), 3),
      {
        folder: "inbox",
        date: "2026-07-15T00:00:00.000Z",
        messageId: `normal-valid-${status}`,
      },
    );
    if (["cleanup_conflict", "deleted", "terminal"].includes(status)) {
      await assert.rejects(operation);
    } else {
      await operation;
    }
    const [stored] = harness.cleanupIntentObjects.values();
    assert.equal(JSON.parse(stored.value).status, "projection_resolved", status);
    assert.equal(harness.deleteBatches.length, 0, status);
  }
});

test("thrown and malformed normal Mailbox outcomes remain building without cleanup", async () => {
  for (const [name, options] of [
    ["throw", { createError: new Error("ambiguous transport") }],
    ["null", { createResult: null }],
    ["unknown-status", { createResult: { status: "other" } }],
    ["missing-cleanup", { createResult: { status: "stored" } }],
    [
      "duplicate-cleanup",
      { createResult: { status: "stored", cleanupKeys: ["x", "x"] } },
    ],
  ] as const) {
    const events: string[] = [];
    const harness = storageHarness({ ...options, events });
    await assert.rejects(
      storeStreamingEmail(
        harness.dependencies,
        streamBytes(singleAttachmentSource(), 3),
        {
          folder: "inbox",
          date: "2026-07-15T00:00:00.000Z",
          messageId: `normal-malformed-${name}`,
        },
      ),
    );
    const [stored] = harness.cleanupIntentObjects.values();
    assert.equal(JSON.parse(stored.value).status, "building", name);
    assert.equal(harness.deleteBatches.length, 0, name);
    assert.equal(events.includes("mailbox:getEmail"), false, name);
  }
});

test("failed projection-resolution CAS remains building without speculative cleanup", async () => {
  const events: string[] = [];
  const harness = storageHarness({ events, rejectResolvedTransition: true });
  await assert.rejects(
    storeStreamingEmail(
      harness.dependencies,
      streamBytes(singleAttachmentSource(), 3),
      {
        folder: "inbox",
        date: "2026-07-15T00:00:00.000Z",
        messageId: "normal-resolution-cas-failure",
      },
    ),
    /transition was not committed/,
  );
  const [stored] = harness.cleanupIntentObjects.values();
  assert.equal(JSON.parse(stored.value).status, "building");
  assert.equal(harness.deleteBatches.length, 0);
  assert.equal(events.includes("mailbox:getEmail"), false);
});

test("known pre-projection failure uses exactly 2n+9 bounded service calls", async () => {
  const events: string[] = [];
  const harness = storageHarness({
    events,
    async enqueueCleanup() {
      throw new Error("guarded cleanup unavailable");
    },
  });
  const source = [
    "From: a@example.com",
    "To: b@example.com",
    "Content-Type: multipart/mixed; boundary=root",
    "",
    "--root",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=proof.bin",
    "Content-Transfer-Encoding: base64",
    "",
    "AQID",
    "--root",
    "Content-Type: multipart/mixed",
    "",
    "invalid child",
    "--root--",
    "",
  ].join("\r\n");
  await assert.rejects(
    storeStreamingEmail(harness.dependencies, streamBytes(source, 3), {
      folder: "inbox",
      date: "2026-07-15T00:00:00.000Z",
      messageId: "normal-pre-projection-failure",
    }),
    /MIME_MULTIPART_BOUNDARY_MISSING/,
  );
  const derivedPuts = events.filter((event) => event === "derived:put").length;
  assert.equal(derivedPuts, 1);
  assert.equal(events.filter((event) => event === "derived:delete").length, 1);
  assert.equal(events.filter((event) => event === "mailbox:cleanup").length, 3);
  assert.equal(events.length - derivedPuts, derivedPuts + 9);
  assert.equal(events.length, 2 * derivedPuts + 9);
  const [stored] = harness.cleanupIntentObjects.values();
  assert.equal(JSON.parse(stored.value).status, "abandoned");
});

test("unverified normal preflight performs no derived put, delete, or guarded cleanup", async () => {
  let guardedCleanupCalls = 0;
  const harness = storageHarness({
    async enqueueCleanup(input) {
      guardedCleanupCalls += 1;
      return { queued: input.keys.length };
    },
  });
  harness.dependencies.cleanupIntentBucket = {
    async put() {
      throw new Error("RAW unavailable");
    },
    async get() {
      throw new Error("RAW unavailable");
    },
    async delete() {
      assert.fail("unverified preflight must remain durable if it exists");
    },
  };
  await assert.rejects(
    storeStreamingEmail(
      harness.dependencies,
      streamBytes(singleAttachmentSource(), 3),
      {
        folder: "inbox",
        date: "2026-07-15T00:00:00.000Z",
        messageId: "normal-unverified-preflight",
      },
    ),
  );
  assert.equal(harness.puts, 0);
  assert.equal(harness.deleteBatches.length, 0);
  assert.equal(guardedCleanupCalls, 0);
});

test("normal late fence loss guards only the exact late key", async () => {
  const events: string[] = [];
  const guarded: string[][] = [];
  const cleanup = cleanupIntentHarness({ events, loseFenceOnRead: 2 });
  const harness = storageHarness({
    events,
    async enqueueCleanup(input) {
      guarded.push(input.keys);
      return { queued: input.keys.length };
    },
  });
  harness.dependencies.cleanupIntentBucket = cleanup.bucket;
  await assert.rejects(
    storeStreamingEmail(
      harness.dependencies,
      streamBytes(singleAttachmentSource(), 3),
      {
        folder: "inbox",
        date: "2026-07-15T00:00:00.000Z",
        messageId: "normal-late-fence-loss",
      },
    ),
    /fence was lost after upload/,
  );
  assert.equal(harness.deleteBatches.length, 0);
  assert.equal(guarded.length, 1);
  assert.equal(guarded[0]?.length, 1);
  assert.match(guarded[0]?.[0] ?? "", /proof\.bin$/);
  assert.equal(events.filter((event) => event === "mailbox:cleanup").length, 1);
});

test("normal streaming never races the Mailbox cleanup outbox with a direct delete", async () => {
  const harness = storageHarness({ cleanupKeySuffixes: ["first.png"] });
  await storeStreamingEmail(
    harness.dependencies,
    streamBytes(alternativeAttachmentSource(), 19),
    {
      folder: "inbox",
      date: "2026-07-15T00:00:00.000Z",
      messageId: "normal-durable-cleanup",
    },
  );

  assert.equal(harness.deleteBatches.length, 0);
});

test("repair derivation durably queues a failed discarded-object deletion", async () => {
  const queued: Array<{
    emailId: string;
    projectionAttemptId: string;
    keys: string[];
  }> = [];
  const harness = storageHarness({
    deleteResult(key) {
      if (key.endsWith("first.png")) throw new Error(`cannot delete ${key}`);
    },
    async enqueueCleanup(input) {
      queued.push(input);
      return { queued: input.keys.length };
    },
  });
  const derived = await deriveStreamingEmail(
    harness.dependencies,
    streamBytes(alternativeAttachmentSource(), 19),
    liveInboundProjectionOptions({
      mailboxId: "hello@wiserchat.ai",
      messageId: "repair-selected-resources",
      date: "2026-07-15T00:00:00.000Z",
    }),
    async (projection) => {
      await projection.activateCommand("a".repeat(64));
      return { keepDerivedObjects: true };
    },
    harness.cleanupIntentBucket,
  );

  assert.equal(derived.parsed.html?.includes("second"), true);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].keys.length, 1);
  assert.match(queued[0].keys[0], /first\.png$/);
  assert.equal(queued[0].keys[0], harness.deletedKeys[0]);
});

test("normal streaming relies solely on the cleanup scheduled by Mailbox acceptance", async () => {
  let enqueueAttempts = 0;
  const logged: unknown[][] = [];
  const originalError = console.error;
  const harness = storageHarness({
    deleteResult(key) {
      if (key.endsWith("first.png")) throw new Error(`cannot delete ${key}`);
    },
    async enqueueCleanup(input) {
      enqueueAttempts += 1;
      return { queued: input.keys.length };
    },
  });
  console.error = (...args: unknown[]) => logged.push(args);
  try {
    await storeStreamingEmail(
      harness.dependencies,
      streamBytes(alternativeAttachmentSource(), 19),
      {
        folder: "inbox",
        date: "2026-07-15T00:00:00.000Z",
        messageId: "normal-selected-resources",
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.equal(enqueueAttempts, 0);
  assert.equal(harness.deleteBatches.length, 0);
  const serializedLogs = JSON.stringify(logged);
  assert.equal(serializedLogs.includes("cannot delete"), false);
  assert.equal(serializedLogs.includes('"cleanupFailures":1'), false);
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
