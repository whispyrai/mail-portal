import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import PostalMime from "postal-mime";
import type { InboundArchivePointer } from "./inbound-email.ts";
import type { InboundProjectionCommand } from "./lib/inbound-projection-contract.ts";
import {
  processInboundBatch,
  processInboundDeadLetterBatch,
  processInboundMessage as processInboundMessageProduction,
} from "./inbound-queue.ts";

function assertTelemetryRef(value: unknown): void {
  assert.match(String(value), /^(?:[a-f0-9]{16}|unavailable)$/);
}

function acceptedProjectionResult<T extends "duplicate" | "stored">(
  command: InboundProjectionCommand,
  status: T,
) {
  const ownedKeys = new Set([
    ...command.attachments.flatMap((attachment) =>
      attachment.r2_key ? [attachment.r2_key] : [],
    ),
    ...command.bodyObjects.map((bodyObject) => bodyObject.r2_key),
  ]);
  return {
    status,
    cleanupKeys: (command.derivedContentProof ?? [])
      .filter(({ r2Key }) => status === "duplicate" || !ownedKeys.has(r2Key))
      .map(({ r2Key }) => r2Key),
  };
}

function mailboxDb(
  state: "active" | "inactive" | "unavailable" = "active",
) {
  return {
    prepare(query: string) {
      assert.match(query, /FROM mailboxes/);
      return {
        bind(mailboxId: string) {
          return {
            async first() {
              if (state === "unavailable")
                throw new Error("simulated active mailbox lookup outage");
              return state === "active" ? { id: mailboxId } : null;
            },
          };
        },
      };
    },
  };
}

async function processInboundMessage(
  message: Parameters<typeof processInboundMessageProduction>[0],
  env: Parameters<typeof processInboundMessageProduction>[1] & {
    DB?: ReturnType<typeof mailboxDb>;
  },
  runtime?: Parameters<typeof processInboundMessageProduction>[2],
) {
  const get = env.MAILBOX.get.bind(env.MAILBOX);
  const rawBucket = env.RAW_MAIL_BUCKET;
  const cleanupIntents = new Map<string, { value: string; etag: string }>();
  let cleanupRevision = 0;
  const cleanupAwareRawBucket = {
    ...rawBucket,
    async get(key: string) {
      if (key.startsWith("system/derived-content-cleanup-intents/pending/")) {
        const stored = cleanupIntents.get(key);
        return stored
          ? {
              etag: stored.etag,
              async text() {
                return stored.value;
              },
            }
          : null;
      }
      return rawBucket.get(key);
    },
    async put(
      key: string,
      value: string,
      options?: {
        onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
      },
    ) {
      if (key.startsWith("system/derived-content-cleanup-intents/pending/")) {
        const current = cleanupIntents.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (
          options?.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== current?.etag
        ) {
          return null;
        }
        cleanupRevision += 1;
        const etag = `cleanup-etag-${cleanupRevision}`;
        cleanupIntents.set(key, { value, etag });
        return { etag };
      }
      return rawBucket.put(key, value, options as never);
    },
    async delete(key: string) {
      if (key.startsWith("system/derived-content-cleanup-intents/pending/")) {
        cleanupIntents.delete(key);
        return;
      }
      if ("delete" in rawBucket && typeof rawBucket.delete === "function") {
        return rawBucket.delete(key);
      }
    },
  };
  return processInboundMessageProduction(
    message,
    {
      ...env,
      DB: env.DB ?? mailboxDb(),
      RAW_MAIL_BUCKET: cleanupAwareRawBucket as never,
      MAILBOX: {
        ...env.MAILBOX,
        get(id: unknown) {
          return get(id);
        },
      },
    },
    runtime,
  );
}

function archivedEmail(
  rawKey: string,
  source: string,
  pointer: InboundArchivePointer,
) {
  const bytes = new TextEncoder().encode(source);
  const calculatedSha256 = Uint8Array.from(
    createHash("sha256").update(bytes).digest(),
  ).buffer;
  return {
    key: rawKey,
    version: pointer.version,
    size: bytes.byteLength,
    etag: pointer.etag,
    customMetadata: {
      archivedAt: pointer.archivedAt,
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      rawSize: String(pointer.rawSize),
      ...(pointer.rawSha256 ? { rawSha256: pointer.rawSha256 } : {}),
      schemaVersion: String(pointer.schemaVersion),
    },
    ...(pointer.rawSha256 ? { checksums: { sha256: calculatedSha256 } } : {}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    async text() {
      return source;
    },
  };
}

test("Queue consumption projects the archived Message idempotently before acknowledging", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const rawSource = [
    "From: Sender <sender@example.com>",
    `To: ${mailboxAddress}`,
    "Subject: Projection proof",
    "Message-ID: <projection-proof@example.com>",
    "",
    "The durable source is R2.",
  ].join("\r\n");
  const rawSha256 = createHash("sha256").update(rawSource).digest("hex");
  const pointer: InboundArchivePointer & { privatePayload: string } = {
    schemaVersion: 1,
    ingressId: "projection-test",
    rawKey: "raw/2026/07/13/projection-test.eml",
    mailboxId: mailboxAddress,
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    rawSha256,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
    privatePayload: "poison",
  };
  let acknowledged = false;
  let retried = false;
  const stored: InboundProjectionCommand[] = [];
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createInboundEmail(command: InboundProjectionCommand) {
      stored.push(command);
      return acceptedProjectionResult(command, "stored");
    },
    async getEmail(id: string) {
      return stored.find((entry) => entry.email.id === id)?.email ?? null;
    },
  };
  const receiptWrites: string[] = [];
  const env = {
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        assert.equal(key, pointer.rawKey);
        return archivedEmail(pointer.rawKey, rawSource, pointer);
      },
      async put(key: string, value: string) {
        receiptWrites.push(`${key}:${value}`);
        return {
          key,
          size: value.length,
          etag: "receipt-etag",
          version: "receipt-version",
        };
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get(mailboxId: string) {
        assert.equal(mailboxId, mailboxAddress);
        return mailbox;
      },
    },
  };
  const message = {
    id: "queue-message-1",
    timestamp: new Date("2026-07-13T09:30:01.000Z"),
    body: pointer,
    attempts: 1,
    ack() {
      acknowledged = true;
    },
    retry() {
      retried = true;
    },
  };

  await processInboundMessage(message, env);

  assert.equal(acknowledged, true);
  assert.equal(retried, false);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].folder, "inbox");
  assert.equal(stored[0].email.id, pointer.ingressId);
  assert.equal(stored[0].email.subject, "Projection proof");
  assert.equal(stored[0].email.date, pointer.archivedAt);
  assert.equal(stored[0].mailboxAddress, mailboxAddress);
  assert.equal(stored[0].email.automation_trigger, "live_inbound");
  assert.equal(receiptWrites.length, 1);
  assert.match(receiptWrites[0], /"state":"stored"/);
  const receipt = JSON.parse(
    receiptWrites[0].slice(receiptWrites[0].indexOf(":") + 1),
  ) as Record<string, unknown>;
  assert.equal(receipt.rawSha256, rawSha256);
  assert.equal("privatePayload" in receipt, false);
});

test("Queue consumption streams decoded attachments to R2 before acknowledging", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const rawSource = [
    "From: Sender <sender@example.com>",
    `To: ${mailboxAddress}`,
    "Subject: Streaming attachment proof",
    "Message-ID: <streaming-attachment@example.com>",
    'Content-Type: multipart/mixed; boundary="attachment-boundary"',
    "",
    "--attachment-boundary",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    "The attachment must never become a whole in-memory buffer.",
    "--attachment-boundary",
    'Content-Type: application/octet-stream; name="proof.txt"',
    'Content-Disposition: attachment; filename="proof.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8gYXR0YWNobWVudA==",
    "--attachment-boundary--",
    "",
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "streaming-attachment",
    rawKey: "raw/2026/07/13/streaming-attachment.eml",
    mailboxId: mailboxAddress,
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let storedAttachments: Array<Record<string, unknown>> = [];
  const uploadedBytes: Uint8Array[] = [];
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createInboundEmail(command: InboundProjectionCommand) {
      storedAttachments = command.attachments;
      return acceptedProjectionResult(command, "stored");
    },
    async getEmail() {
      return null;
    },
  };
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        return archivedEmail(pointer.rawKey, rawSource, pointer);
      },
      async put(key: string, value: string) {
        return {
          key,
          size: value.length,
          etag: "receipt-etag",
          version: "receipt-version",
        };
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put(key: string, value: unknown) {
        assert.ok(
          value instanceof ReadableStream,
          "decoded attachment must cross the R2 boundary as a stream",
        );
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        if (key.startsWith("attachments/")) uploadedBytes.push(bytes);
        return { size: bytes.byteLength };
      },
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return mailbox;
      },
    },
  };

  await processInboundMessage(
    {
      id: "queue-streaming-attachment",
      timestamp: new Date("2026-07-13T09:30:01.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("streaming attachment projection must not retry");
      },
    },
    env,
  );

  assert.equal(acknowledged, true);
  assert.equal(uploadedBytes.length, 1);
  assert.equal(new TextDecoder().decode(uploadedBytes[0]), "Hello attachment");
  assert.equal(storedAttachments.length, 1);
  assert.equal(storedAttachments[0].filename, "proof.txt");
  assert.equal(storedAttachments[0].size, 16);
});

test("Queue consumption externalizes a large decoded body without losing its full content", async () => {
  const body = Array.from({ length: 12_000 }, () => "x".repeat(50)).join(
    "\r\n",
  );
  const rawSource = [
    "From: sender@example.com",
    "To: hello@wiserchat.ai",
    "Subject: Large body",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "large-body",
    rawKey: "raw/2026/07/13/large-body.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let bodyObjectBytes: Uint8Array | undefined;
  let storedBody = "";
  let storedBodyObjects: Array<Record<string, unknown>> | undefined;

  await processInboundMessage(
    {
      id: "queue-large-body",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a valid large body must project successfully");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put() {
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put(key: string, value: unknown) {
          assert.match(key, /^email-bodies\/large-body\//);
          assert.ok(value instanceof ReadableStream);
          bodyObjectBytes = new Uint8Array(
            await new Response(value).arrayBuffer(),
          );
          return { size: bodyObjectBytes.byteLength };
        },
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async isEmailDeleted() {
              return false;
            },
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: InboundProjectionCommand) {
              storedBody = String(command.email.body);
              storedBodyObjects = command.bodyObjects;
              return acceptedProjectionResult(command, "stored");
            },
          };
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(new TextDecoder().decode(bodyObjectBytes), body);
  assert.ok(storedBody.length < body.length);
  assert.equal(storedBodyObjects?.length, 1);
  assert.equal(storedBodyObjects?.[0]?.byte_length, body.length);
});

test("Queue redelivery acknowledges an already projected ingress without creating a duplicate", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "already-stored",
    rawKey: "raw/2026/07/13/already-stored.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let createCalls = 0;
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const originalConsoleLog = console.log;
  console.log = (message: string, fields?: Record<string, unknown>) => {
    logs.push({ message, fields });
  };
  try {
    const mailbox = {
      async findThreadBySubject() {
        return null;
      },
      async createInboundEmail(_command: InboundProjectionCommand) {
        createCalls += 1;
      },
      async getEmail() {
        return { id: pointer.ingressId };
      },
    };
    const env = {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail(
            "a redelivery must not reread raw MIME after finding the Message",
          );
        },
        async put() {
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return mailbox;
        },
      },
    };
    const message = {
      id: "queue-message-redelivery",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 2,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("an already projected ingress must not retry");
      },
    };

    await processInboundMessage(message, env);

    assert.equal(acknowledged, true);
    assert.equal(createCalls, 0);
    const duplicateLog = logs.find(
      (entry) => entry.message === "[mail-projection] duplicate acknowledged",
    );
    assert.equal(duplicateLog?.fields?.attempt, 2);
    assertTelemetryRef(duplicateLog?.fields?.ingressRef);
    assertTelemetryRef(duplicateLog?.fields?.queueRef);
    assert.equal(duplicateLog?.fields?.operation, "mailbox_projection");
    assert.equal(duplicateLog?.fields?.status, "duplicate");
    assert.equal(typeof duplicateLog?.fields?.durationMs, "number");
  } finally {
    console.log = originalConsoleLog;
  }
});

test("Queue redelivery honors a durable user-deletion tombstone", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "deleted-inbound",
    rawKey: "raw/2026/07/13/deleted-inbound.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receiptState: string | undefined;
  await processInboundMessage(
    {
      id: "queue-message-deleted",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 2,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a deleted projection must not retry");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail("a deleted projection must not reread raw MIME");
        },
        async head() {
          return {
            etag: "admitted-receipt",
            customMetadata: { state: "admitted" },
          };
        },
        async put(_key: string, value: string) {
          receiptState = JSON.parse(value).state;
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async isEmailDeleted() {
              return true;
            },
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              assert.fail("a deleted projection must not be stored");
            },
            async createInboundEmail(_command: InboundProjectionCommand) {
              assert.fail("a deleted projection must not be stored");
            },
          };
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(receiptState, "deleted");
});

test("Queue projection cannot resurrect an email deleted after the initial idempotency check", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const rawSource = [
    "From: sender@example.com",
    `To: ${mailboxAddress}`,
    "Subject: Tombstone race",
    "",
    "Must remain deleted.",
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "tombstone-race",
    rawKey: "raw/2026/07/13/tombstone-race.eml",
    mailboxId: mailboxAddress,
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receiptState: string | undefined;
  const mailbox = {
    async isEmailDeleted() {
      return false;
    },
    async getEmail() {
      return null;
    },
    async findThreadBySubject() {
      return null;
    },
    async createInboundEmail() {
      return { status: "deleted", cleanupKeys: [] };
    },
  };

  await processInboundMessage(
    {
      id: "queue-tombstone-race",
      timestamp: new Date("2026-07-13T09:30:01.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a concurrent deletion must be terminal, not retried");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put(_key: string, value: string) {
          receiptState = JSON.parse(value).state;
          return { etag: "receipt-etag" };
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return mailbox;
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(receiptState, "deleted");
});

test("Queue consumption resolves an ambiguous Mailbox error by stable ingress identity", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const rawSource = [
    "From: sender@example.com",
    `To: ${mailboxAddress}`,
    "Subject: Ambiguous commit",
    "",
    "Stored before the RPC error.",
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "ambiguous-commit",
    rawKey: "raw/2026/07/13/ambiguous-commit.eml",
    mailboxId: mailboxAddress,
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let storedEmail: Record<string, unknown> | null = null;
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const originalConsoleLog = console.log;
  console.log = (message: string, fields?: Record<string, unknown>) => {
    logs.push({ message, fields });
  };
  try {
    const mailbox = {
      async findThreadBySubject() {
        return null;
      },
      async createInboundEmail(command: InboundProjectionCommand) {
        storedEmail = command.email;
        throw new Error("simulated response loss after commit");
      },
      async getEmail() {
        return storedEmail;
      },
    };
    const env = {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put() {
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete(key: string) {
          assert.match(key, /^email-bodies\//);
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return mailbox;
        },
      },
    };
    const message = {
      id: "queue-message-ambiguous",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a proven Mailbox commit must not retry");
      },
    };

    await processInboundMessage(message, env);

    assert.equal(acknowledged, true);
    assert.equal(storedEmail?.id, pointer.ingressId);
    const recoveredLog = logs.find(
      (entry) =>
        entry.message === "[mail-projection] ambiguous commit recovered",
    );
    assert.equal(recoveredLog?.fields?.attempt, 1);
    assertTelemetryRef(recoveredLog?.fields?.ingressRef);
    assertTelemetryRef(recoveredLog?.fields?.queueRef);
    assert.equal(recoveredLog?.fields?.operation, "mailbox_projection");
    assert.equal(recoveredLog?.fields?.status, "recovered");
    assert.equal(typeof recoveredLog?.fields?.durationMs, "number");
  } finally {
    console.log = originalConsoleLog;
  }
});

test("Queue consumption quarantines an unparseable archive without deleting raw MIME", async () => {
  const rawSource = "not parseable in this test";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "parse-failure",
    rawKey: "raw/2026/07/13/parse-failure.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receipt: Record<string, unknown> | undefined;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const mailbox = {
      async findThreadBySubject() {
        return null;
      },
      async createInboundEmail(_command: InboundProjectionCommand) {
        assert.fail("unparseable raw MIME must not reach Mailbox storage");
      },
      async getEmail() {
        return null;
      },
    };
    const env = {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put(key: string, value: string) {
          assert.equal(key, `receipts/${pointer.ingressId}.json`);
          receipt = JSON.parse(value);
          return {};
        },
        async delete() {
          assert.fail(
            "raw MIME must never be deleted by projection failure handling",
          );
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return mailbox;
        },
      },
    };
    const message = {
      id: "queue-message-parse-failure",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail(
          "deterministic parse failure must quarantine instead of retrying",
        );
      },
    };

    await processInboundMessage(message, env, {
      async parse() {
        throw new Error("simulated malformed MIME");
      },
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    });

    assert.equal(acknowledged, true);
    assert.deepEqual(receipt, {
      ...pointer,
      state: "quarantined",
      updatedAt: "2026-07-13T09:31:00.000Z",
      errorCode: "MIME_PARSE_FAILED",
    });
    assert.deepEqual(errors, [
      {
        message: "[mail-projection] quarantined",
        fields: {
          attempt: 1,
          durationMs: 0,
          errorCode: "MIME_PARSE_FAILED",
          ingressRef: errors[0]?.fields?.ingressRef,
          objectRef: errors[0]?.fields?.objectRef,
          operation: "mime_parse",
          queueRef: errors[0]?.fields?.queueRef,
          status: "quarantined",
        },
      },
    ]);
    assertTelemetryRef(errors[0]?.fields?.ingressRef);
    assertTelemetryRef(errors[0]?.fields?.objectRef);
    assertTelemetryRef(errors[0]?.fields?.queueRef);
    assert.doesNotMatch(
      JSON.stringify(errors),
      /simulated malformed MIME|queue-message-parse-failure|parse-failure\.eml|hello@wiserchat\.ai/,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("Queue consumption projects a newline-free MIME body above 64 KiB", async () => {
  const rawSource = [
    "From: sender@example.com",
    "To: hello@wiserchat.ai",
    "Subject: Pathological body",
    "Content-Type: text/plain",
    "",
    "x".repeat(70 * 1024),
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "mime-line-limit",
    rawKey: "raw/2026/07/13/mime-line-limit.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receipt: Record<string, unknown> | undefined;
  let storedBody = "";

  await processInboundMessage(
    {
      id: "queue-mime-line-limit",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a valid long-line body must not retry");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put(_key: string, value: string) {
          receipt = JSON.parse(value);
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {
          assert.fail("an inline body must not create projection objects");
        },
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async isEmailDeleted() {
              return false;
            },
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: InboundProjectionCommand) {
              storedBody = String(command.email.body);
              return acceptedProjectionResult(command, "stored");
            },
          };
        },
      },
    },
  );

  assert.equal(receipt?.state, "stored");
  assert.equal(storedBody, "x".repeat(70 * 1024));
  assert.equal(acknowledged, true);
});

test("Queue consumption quarantines an archive when its Mailbox no longer exists", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "missing-mailbox",
    rawKey: "raw/2026/07/13/missing-mailbox.eml",
    mailboxId: "removed@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receipt: Record<string, unknown> | undefined;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        assert.fail(
          "a removed Mailbox should quarantine from durable metadata alone",
        );
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head(key: string) {
        assert.equal(key, `mailboxes/${pointer.mailboxId}.json`);
        return null;
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName() {
        assert.fail("a removed Mailbox must not resolve a Durable Object");
      },
      get() {
        assert.fail("a removed Mailbox must not resolve a Durable Object");
      },
    },
  };
  const message = {
    id: "queue-message-missing-mailbox",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 1,
    ack() {
      acknowledged = true;
    },
    retry() {
      assert.fail(
        "a removed Mailbox is a quarantine outcome, not a retry storm",
      );
    },
  };

  await processInboundMessage(message, env, {
    parse() {
      assert.fail("a removed Mailbox must quarantine before parsing");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(acknowledged, true);
  assert.equal(receipt?.state, "quarantined");
  assert.equal(receipt?.errorCode, "MAILBOX_UNAVAILABLE");
});

test("Queue consumption records and schedules a bounded retry when the raw archive cannot be read", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "raw-read-retry",
    rawKey: "raw/2026/07/13/raw-read-retry.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let retryDelay: number | undefined;
  let acknowledged = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        throw new Error("simulated R2 timeout");
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return {
          async getEmail() {
            return null;
          },
          async findThreadBySubject() {
            return null;
          },
          async createInboundEmail(_command: InboundProjectionCommand) {
            assert.fail("unavailable raw MIME must not be projected");
          },
        };
      },
    },
  };
  const message = {
    id: "queue-message-raw-read-retry",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 2,
    ack() {
      acknowledged = true;
    },
    retry(options?: { delaySeconds?: number }) {
      retryDelay = options?.delaySeconds;
    },
  };

  await processInboundMessage(message, env, {
    parse() {
      assert.fail("unavailable raw MIME must not be parsed");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(receipt?.state, "retrying");
  assert.equal(receipt?.errorCode, "RAW_ARCHIVE_READ_FAILED");
  assert.equal(receipt?.attempt, 2);
  assert.equal(retryDelay, 4);
  assert.equal(acknowledged, false);
});

test("Queue delivery acknowledges a terminal receipt before touching projection dependencies", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "terminal-receipt-race",
    rawKey: "raw/2026/07/13/terminal-receipt-race.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let retried = false;
  let acknowledged = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        assert.fail("mailbox marker failure must occur before the raw read");
      },
      async head(key: string) {
        assert.equal(key, `receipts/${pointer.ingressId}.json`);
        return { etag: "stored-etag", customMetadata: { state: "stored" } };
      },
      async put() {
        assert.fail("a terminal stored receipt must not regress to retrying");
      },
    },
    BUCKET: {
      async head() {
        assert.fail("terminal receipt must short-circuit the mailbox marker");
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName() {
        assert.fail("marker failure must precede Mailbox resolution");
      },
      get() {
        assert.fail("marker failure must precede Mailbox resolution");
      },
    },
  };

  await processInboundMessage(
    {
      id: "queue-terminal-receipt-race",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 2,
      ack() {
        acknowledged = true;
      },
      retry() {
        retried = true;
      },
    },
    env,
    {
      parse() {
        assert.fail("marker failure must precede parsing");
      },
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    },
  );

  assert.equal(retried, false);
  assert.equal(acknowledged, true);
});

test("Queue consumption retries when the Mailbox marker cannot be read", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "marker-read-retry",
    rawKey: "raw/2026/07/13/marker-read-retry.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let retried = false;
  let acknowledged = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        assert.fail("marker lookup must complete before raw read");
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head() {
        throw new Error("simulated marker read timeout");
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName() {
        assert.fail(
          "marker lookup must complete before Durable Object resolution",
        );
      },
      get() {
        assert.fail(
          "marker lookup must complete before Durable Object resolution",
        );
      },
    },
  };
  const message = {
    id: "queue-message-marker-read-retry",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 2,
    ack() {
      acknowledged = true;
    },
    retry() {
      retried = true;
    },
  };

  await processInboundMessage(message, env, {
    parse() {
      assert.fail("marker lookup must complete before MIME parse");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(retried, true);
  assert.equal(acknowledged, false);
  assert.equal(receipt?.state, "retrying");
  assert.equal(receipt?.errorCode, "MAILBOX_MARKER_READ_FAILED");
});

test("Queue consumption quarantines a same-size archive whose checksum does not match its pointer", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\n\r\nIntegrity";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "integrity-mismatch",
    rawKey: "raw/2026/07/13/integrity-mismatch.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "expected-etag",
    version: "expected-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let acknowledged = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        return {
          ...archivedEmail(pointer.rawKey, rawSource, pointer),
          checksums: { sha256: new ArrayBuffer(32) },
        };
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return {
          async getEmail() {
            return null;
          },
          async findThreadBySubject() {
            return null;
          },
          async createInboundEmail(_command: InboundProjectionCommand) {
            assert.fail("integrity mismatch must not be projected");
          },
        };
      },
    },
  };
  const message = {
    id: "queue-message-integrity-mismatch",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 1,
    ack() {
      acknowledged = true;
    },
    retry() {
      assert.fail("an immutable metadata mismatch must quarantine");
    },
  };

  await processInboundMessage(message, env, {
    parse() {
      assert.fail("integrity mismatch must be detected before parsing");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(acknowledged, true);
  assert.equal(receipt?.state, "quarantined");
  assert.equal(receipt?.errorCode, "RAW_ARCHIVE_INTEGRITY_MISMATCH");
});

test("Queue consumption retries a Mailbox projection failure that cannot be proven committed", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Retry me\r\n\r\nBody";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "mailbox-retry",
    rawKey: "raw/2026/07/13/mailbox-retry.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let retryDelay: number | undefined;
  let acknowledged = false;
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createInboundEmail(_command: InboundProjectionCommand) {
      throw new Error("simulated Durable Object outage");
    },
    async getEmail() {
      return null;
    },
  };
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        return archivedEmail(pointer.rawKey, rawSource, pointer);
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return mailbox;
      },
    },
  };
  const message = {
    id: "queue-message-mailbox-retry",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 3,
    ack() {
      acknowledged = true;
    },
    retry(options?: { delaySeconds?: number }) {
      retryDelay = options?.delaySeconds;
    },
  };

  await processInboundMessage(message, env, {
    parse: (stream) => PostalMime.parse(stream),
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(receipt?.state, "retrying");
  assert.equal(receipt?.errorCode, "MAILBOX_PROJECTION_FAILED");
  assert.equal(receipt?.attempt, 3);
  assert.equal(retryDelay, 8);
  assert.equal(acknowledged, false);
});

test("Queue consumption records dead-letter intent on the final configured attempt", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-intent",
    rawKey: "raw/2026/07/13/dead-letter-intent.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let retried = false;
  let acknowledged = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get() {
        return null;
      },
      async put(_key: string, value: string) {
        receipt = JSON.parse(value);
        return {};
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return {
          async getEmail() {
            return null;
          },
          async findThreadBySubject() {
            return null;
          },
          async createInboundEmail(_command: InboundProjectionCommand) {},
        };
      },
    },
  };
  const message = {
    id: "queue-message-dead-letter-intent",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 11,
    ack() {
      acknowledged = true;
    },
    retry() {
      retried = true;
    },
  };

  await processInboundMessage(message, env, {
    parse() {
      assert.fail("missing raw MIME must not be parsed");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(retried, true);
  assert.equal(acknowledged, false);
  assert.equal(receipt?.state, "dead_letter_pending");
  assert.equal(receipt?.errorCode, "RAW_ARCHIVE_READ_FAILED");
  assert.equal(receipt?.attempt, 11);
});

test("Queue consumption acknowledges a stored Message even when its receipt sidecar write fails", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Stored\r\n\r\nBody";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "receipt-write-failure",
    rawKey: "raw/2026/07/13/receipt-write-failure.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let stored: Record<string, unknown> | null = null;
  let acknowledged = false;
  let retried = false;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const mailbox = {
      async findThreadBySubject() {
        return null;
      },
      async createInboundEmail(command: InboundProjectionCommand) {
        stored = command.email;
        return acceptedProjectionResult(command, "stored");
      },
      async getEmail() {
        return stored;
      },
    };
    const env = {
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put() {
          throw new Error("simulated receipt write outage");
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return mailbox;
        },
      },
    };
    const message = {
      id: "queue-message-receipt-write-failure",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        retried = true;
      },
    };

    await processInboundMessage(message, env, {
      parse: (stream) => PostalMime.parse(stream),
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    });

    assert.equal(stored?.id, pointer.ingressId);
    assert.equal(acknowledged, true);
    assert.equal(retried, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fields?.errorCode, "RECEIPT_WRITE_FAILED");
    assert.equal(errors[0].fields?.status, "degraded");
  } finally {
    console.error = originalConsoleError;
  }
});

test("Queue consumption includes branded push work in the atomic Mailbox projection", async () => {
  const rawSource = [
    "From: Sender Name <sender@example.com>",
    "To: hello@wiserchat.ai",
    "Subject: Branded projection",
    "",
    "The message body.",
  ].join("\r\n");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "branded-push",
    rawKey: "raw/2026/07/13/branded-push.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let command: InboundProjectionCommand | undefined;
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createInboundEmail(input: InboundProjectionCommand) {
      command = input;
      return acceptedProjectionResult(input, "stored");
    },
    async getEmail() {
      return null;
    },
  };
  const env = {
    BRAND: "wiser",
    RAW_MAIL_BUCKET: {
      async get() {
        return archivedEmail(pointer.rawKey, rawSource, pointer);
      },
      async put() {
        return {};
      },
    },
    BUCKET: {
      async head() {
        return {};
      },
      async put() {},
      async delete() {},
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return mailbox;
      },
    },
  };
  const message = {
    id: "queue-message-branded-push",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: pointer,
    attempts: 1,
    ack() {},
    retry() {
      assert.fail("a stored message must not retry");
    },
  };

  await processInboundMessage(message, env, {
    parse: (stream) => PostalMime.parse(stream),
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(command?.folder, "inbox");
  assert.equal(command?.mailboxAddress, pointer.mailboxId);
  assert.equal(command?.allowTerminalRecovery, false);
  assert.equal(command?.email.read, false);
  assert.equal(command?.email.recipient_memory_origin, "live_inbound");
  assert.equal(command?.email.automation_trigger, "live_inbound");
  const pushPayload = command?.email.push_notification as
    | Record<string, unknown>
    | undefined;
  assert.equal(pushPayload?.icon, "/wiser-icon-192.png");
  assert.equal(pushPayload?.badge, "/wiser-badge-96.png");
  assert.deepEqual(pushPayload?.data, {
    emailId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
  });
});

test("Queue duplicate resolution stays inside the atomic Mailbox projection", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: One push\r\n\r\nBody";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "push-claim-loser",
    rawKey: "raw/2026/07/13/push-claim-loser.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receiptState: string | undefined;
  const commands: InboundProjectionCommand[] = [];
  await processInboundMessage(
    {
      id: "queue-message-push-claim-loser",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("a stored message must not retry");
      },
    },
    {
      BRAND: "wiser",
      RAW_MAIL_BUCKET: {
        async get() {
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put() {
          receiptState = "stored";
          return {};
        },
      },
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: InboundProjectionCommand) {
              commands.push(command);
              return acceptedProjectionResult(command, "duplicate");
            },
          };
        },
      },
    },
    {
      parse: (stream) => PostalMime.parse(stream),
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(receiptState, "stored");
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.email.id, pointer.ingressId);
  assert.equal(commands[0]?.email.automation_trigger, "live_inbound");
  assert.ok(commands[0]?.email.push_notification);
});

for (const testCase of [
  {
    name: "rejects an inactive mailbox before reading raw MIME",
    dbState: "inactive" as const,
    expectedReceipt: "rejected",
    expectedAction: "ack" as const,
  },
  {
    name: "retries when the active mailbox lookup is transiently unavailable",
    dbState: "unavailable" as const,
    expectedReceipt: "retrying",
    expectedAction: "retry" as const,
  },
]) {
  test(`Queue consumption ${testCase.name}`, async () => {
    const pointer: InboundArchivePointer = {
      schemaVersion: 1,
      ingressId: `d1-${testCase.dbState}`,
      rawKey: `raw/2026/07/15/d1-${testCase.dbState}.eml`,
      mailboxId: "hello@wiserchat.ai",
      rawSize: 100,
      archivedAt: "2026-07-15T10:00:00.000Z",
      etag: "archive-etag",
      version: "archive-version",
    };
    let receiptState: string | undefined;
    let action: "ack" | "retry" | undefined;

    await processInboundMessage(
      {
        id: `queue-d1-${testCase.dbState}`,
        timestamp: new Date("2026-07-15T10:00:01.000Z"),
        body: pointer,
        attempts: 1,
        ack() {
          action = "ack";
        },
        retry() {
          action = "retry";
        },
      },
      {
        DB: mailboxDb(testCase.dbState),
        RAW_MAIL_BUCKET: {
          async get() {
            assert.fail("D1 admission must finish before raw MIME is read");
          },
          async put(_key: string, value: string) {
            receiptState = JSON.parse(value).state;
            return {};
          },
        },
        BUCKET: {
          async head() {
            return {};
          },
          async put() {},
          async delete() {},
        },
        MAILBOX: {
          idFromName() {
            assert.fail("D1 admission must finish before Mailbox resolution");
          },
          get() {
            assert.fail("D1 admission must finish before Mailbox resolution");
          },
        },
      },
      { now: () => new Date("2026-07-15T10:00:01.000Z") },
    );

    assert.equal(receiptState, testCase.expectedReceipt);
    assert.equal(action, testCase.expectedAction);
  });
}

for (const testCase of [
  {
    name: "rejects when the mailbox becomes inactive at the pre-projection recheck",
    secondCheck: "inactive" as const,
    expectedReceipt: "rejected",
    expectedAction: "ack" as const,
  },
  {
    name: "retries when the pre-projection active lookup becomes unavailable",
    secondCheck: "unavailable" as const,
    expectedReceipt: "retrying",
    expectedAction: "retry" as const,
  },
]) {
  test(`Queue consumption ${testCase.name}`, async () => {
    const rawSource =
      "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: D1 recheck\r\n\r\nBody";
    const pointer: InboundArchivePointer = {
      schemaVersion: 1,
      ingressId: `d1-recheck-${testCase.secondCheck}`,
      rawKey: `raw/2026/07/15/d1-recheck-${testCase.secondCheck}.eml`,
      mailboxId: "hello@wiserchat.ai",
      rawSize: new TextEncoder().encode(rawSource).byteLength,
      archivedAt: "2026-07-15T10:00:00.000Z",
      etag: "archive-etag",
      version: "archive-version",
    };
    let activeChecks = 0;
    let rawReads = 0;
    let receiptState: string | undefined;
    let action: "ack" | "retry" | undefined;
    const db = {
      prepare() {
        return {
          bind(mailboxId: string) {
            return {
              async first() {
                activeChecks += 1;
                if (activeChecks === 1) return { id: mailboxId };
                if (testCase.secondCheck === "unavailable")
                  throw new Error("simulated second active lookup outage");
                return null;
              },
            };
          },
        };
      },
    };

    await processInboundMessage(
      {
        id: `queue-d1-recheck-${testCase.secondCheck}`,
        timestamp: new Date("2026-07-15T10:00:01.000Z"),
        body: pointer,
        attempts: 1,
        ack() {
          action = "ack";
        },
        retry() {
          action = "retry";
        },
      },
      {
        DB: db,
        RAW_MAIL_BUCKET: {
          async get() {
            rawReads += 1;
            return archivedEmail(pointer.rawKey, rawSource, pointer);
          },
          async put(_key: string, value: string) {
            receiptState = JSON.parse(value).state;
            return {};
          },
        },
        BUCKET: {
          async head() {
            return {};
          },
          async put() {},
          async delete() {},
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return {
              async isEmailDeleted() {
                return false;
              },
              async getEmail() {
                return null;
              },
              async createInboundEmail() {
                assert.fail("failed second D1 admission must forbid projection");
              },
            };
          },
        },
      },
      {
        parse() {
          assert.fail("failed second D1 admission must forbid parsing");
        },
        now: () => new Date("2026-07-15T10:00:01.000Z"),
      },
    );

    assert.equal(activeChecks, 2);
    assert.equal(rawReads, 1);
    assert.equal(receiptState, testCase.expectedReceipt);
    assert.equal(action, testCase.expectedAction);
  });
}

test("Queue batch consumption durably quarantines malformed pointers before acknowledging", async () => {
  let acknowledged = false;
  let quarantineKey: string | undefined;
  let quarantine: Record<string, unknown> | undefined;
  const message = {
    id: "queue-message-malformed",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: {
      schemaVersion: 999,
      rawKey: "attacker-controlled/private-message-id",
    },
    attempts: 1,
    ack() {
      acknowledged = true;
    },
    retry() {
      assert.fail(
        "a deterministic invalid pointer must not create a retry storm",
      );
    },
  };
  await processInboundBatch(
    { messages: [message] },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail("an invalid pointer must not read R2");
        },
        async put(key: string, value: string) {
          quarantineKey = key;
          quarantine = JSON.parse(value);
          return {};
        },
      },
      BUCKET: {
        async head() {
          assert.fail("an invalid pointer must not resolve a Mailbox");
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName() {
          assert.fail("an invalid pointer must not resolve a Durable Object");
        },
        get() {
          assert.fail("an invalid pointer must not resolve a Durable Object");
        },
      },
    },
    { now: () => new Date("2026-07-13T09:31:00.000Z") },
  );

  assert.equal(acknowledged, true);
  assert.equal(
    quarantineKey,
    "invalid-queue-pointers/8a06ae1fc6afca2b.json",
  );
  assert.deepEqual(quarantine, {
    attempts: 1,
    bodyKind: "object",
    errorCode: "INVALID_QUEUE_POINTER",
    queueRef: "8a06ae1fc6afca2b",
    recordedAt: "2026-07-13T09:31:00.000Z",
  });
});

test("DLQ batch quarantine persists only a bounded pointer classification", async () => {
  let acknowledged = false;
  let quarantineKey: string | undefined;
  let quarantine: Record<string, unknown> | undefined;
  await processInboundDeadLetterBatch(
    {
      messages: [
        {
          id: "dlq-message-malformed",
          timestamp: new Date("2026-07-13T09:31:00.000Z"),
          body: ["private-message-body"],
          attempts: 4,
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail("an invalid DLQ pointer must not retry");
          },
        },
      ],
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail("an invalid DLQ pointer must not read R2");
        },
        async put(key: string, value: string) {
          quarantineKey = key;
          quarantine = JSON.parse(value);
          return {};
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("an invalid DLQ pointer must not resolve a Mailbox");
        },
        get() {
          assert.fail("an invalid DLQ pointer must not resolve a Mailbox");
        },
      },
    },
    { now: () => new Date("2026-07-13T09:31:00.000Z") },
  );

  assert.equal(acknowledged, true);
  assert.equal(
    quarantineKey,
    "invalid-queue-pointers/add70155c3d24395.json",
  );
  assert.deepEqual(quarantine, {
    attempts: 4,
    bodyKind: "array",
    errorCode: "INVALID_DLQ_POINTER",
    queueRef: "add70155c3d24395",
    recordedAt: "2026-07-13T09:31:00.000Z",
  });
});

test("DLQ consumption records a terminal dead-letter receipt before acknowledging", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-terminal",
    rawKey: "raw/2026/07/13/dead-letter-terminal.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let receipt: Record<string, unknown> | undefined;
  let terminalFailure:
    | {
        id: string;
        queueRef: string;
        attempts: number;
        errorCode: "QUEUE_RETRY_EXHAUSTED";
      }
    | undefined;
  let acknowledged = false;
  await processInboundDeadLetterBatch(
    {
      messages: [
        {
          id: "dlq-message",
          timestamp: new Date("2026-07-13T10:00:00.000Z"),
          body: pointer,
          attempts: 1,
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail("a persisted dead-letter receipt must be acknowledged");
          },
        },
      ],
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async head() {
          return {
            etag: "pending-etag",
            customMetadata: { state: "dead_letter_pending" },
          };
        },
        async put(_key: string, value: string) {
          receipt = JSON.parse(value);
          return {};
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async recordInboundTerminalFailure(input: {
              id: string;
              queueRef: string;
              attempts: number;
              errorCode: "QUEUE_RETRY_EXHAUSTED";
            }): Promise<"ledgered"> {
              terminalFailure = input;
              return "ledgered";
            },
          };
        },
      },
    },
    {
      parse: (stream) => PostalMime.parse(stream),
      now: () => new Date("2026-07-13T10:00:00.000Z"),
    },
  );

  assert.equal(receipt?.state, "dead_lettered");
  assert.equal(receipt?.queueRef, "9831ba66d0fbd950");
  assert.equal("queueMessageId" in (receipt ?? {}), false);
  assert.deepEqual(terminalFailure, {
    id: pointer.ingressId,
    queueRef: "9831ba66d0fbd950",
    attempts: 1,
    errorCode: "QUEUE_RETRY_EXHAUSTED",
  });
  assert.equal(acknowledged, true);
});

test("a late DLQ delivery cannot override an email that is already stored", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "late-dlq-stored",
    rawKey: "raw/2026/07/13/late-dlq-stored.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receiptState: string | undefined;

  await processInboundDeadLetterBatch(
    {
      messages: [
        {
          id: "late-dlq-message",
          timestamp: new Date("2026-07-13T10:00:00.000Z"),
          body: pointer,
          attempts: 10,
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail(
              "a stored projection must terminally suppress late DLQ work",
            );
          },
        },
      ],
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async head() {
          return {
            etag: "pending-etag",
            customMetadata: { state: "dead_letter_pending" },
          };
        },
        async put(_key: string, value: string) {
          receiptState = JSON.parse(value).state;
          return {};
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async isEmailDeleted() {
              return false;
            },
            async getEmail() {
              return { id: pointer.ingressId };
            },
            async recordInboundTerminalFailure() {
              assert.fail(
                "a successful projection must not gain a failure ledger",
              );
            },
          };
        },
      },
    },
  );

  assert.equal(receiptState, "stored");
  assert.equal(acknowledged, true);
});

test("a delayed DLQ delivery does not acknowledge a stale pending receipt when terminal evidence cannot commit", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-write-race",
    rawKey: "raw/2026/07/13/dead-letter-write-race.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  const receipt = {
    state: "dead_letter_pending",
    updatedAt: "2026-07-13T09:00:00.000Z",
  };
  let headCalls = 0;
  let acknowledged = false;
  let attemptedReceipt: Record<string, unknown> | undefined;
  await assert.rejects(
    processInboundDeadLetterBatch(
      {
        messages: [
          {
            id: "dlq-write-race",
            timestamp: new Date("2026-07-13T10:00:00.000Z"),
            body: pointer,
            attempts: 1,
            ack() {
              acknowledged = true;
            },
            retry() {},
          },
        ],
      },
      {
        RAW_MAIL_BUCKET: {
          async get() {
            return null;
          },
          async head() {
            headCalls += 1;
            return {
              etag: `pending-etag-${headCalls}`,
              customMetadata: { state: receipt.state },
            };
          },
          async put(_key: string, value: string) {
            attemptedReceipt = JSON.parse(value);
            return null;
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return {
              async recordInboundTerminalFailure() {
                throw new Error("simulated terminal-ledger outage");
              },
            };
          },
        },
      },
      { now: () => new Date("2026-07-13T10:00:00.000Z") },
    ),
    /either durable terminal ledger/,
  );

  assert.deepEqual(receipt, {
    state: "dead_letter_pending",
    updatedAt: "2026-07-13T09:00:00.000Z",
  });
  assert.equal(attemptedReceipt?.state, "dead_lettered");
  assert.equal(acknowledged, false);
  assert.equal(headCalls, 3);
});

test("DLQ consumption acknowledges an R2 outage after the Mailbox terminal ledger commits", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-fallback-ledger",
    rawKey: "raw/2026/07/13/dead-letter-fallback-ledger.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let terminalLedgerInput: Record<string, unknown> | undefined;

  await processInboundDeadLetterBatch(
    {
      messages: [
        {
          id: "dlq-fallback-ledger",
          timestamp: new Date("2026-07-13T10:00:00.000Z"),
          body: pointer,
          attempts: 10,
          ack() {
            acknowledged = true;
          },
          retry() {
            assert.fail(
              "the independent terminal ledger permits acknowledgement",
            );
          },
        },
      ],
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async head() {
          throw new Error("simulated receipt outage");
        },
        async put() {
          throw new Error("simulated receipt outage");
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async recordInboundTerminalFailure(
              input: Record<string, unknown>,
            ): Promise<"ledgered"> {
              terminalLedgerInput = input;
              return "ledgered";
            },
          };
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(terminalLedgerInput?.id, pointer.ingressId);
  assert.equal(terminalLedgerInput?.errorCode, "QUEUE_RETRY_EXHAUSTED");
});

test("DLQ consumption rejects an undefined terminal-ledger disposition during an R2 outage", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-undefined-disposition",
    rawKey: "raw/2026/07/13/dead-letter-undefined-disposition.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;

  await assert.rejects(
    processInboundDeadLetterBatch(
      {
        messages: [
          {
            id: "dlq-undefined-disposition",
            timestamp: new Date("2026-07-13T10:00:00.000Z"),
            body: pointer,
            attempts: 10,
            ack() {
              acknowledged = true;
            },
            retry() {},
          },
        ],
      },
      {
        RAW_MAIL_BUCKET: {
          async get() {
            throw new Error("simulated receipt outage");
          },
          async head() {
            throw new Error("simulated receipt outage");
          },
          async put() {
            throw new Error("simulated receipt outage");
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return {
              async recordInboundTerminalFailure() {
                return undefined;
              },
            };
          },
        },
      },
    ),
    /simulated receipt outage/,
  );

  assert.equal(acknowledged, false);
});

test("a later retry cannot regress dead-letter-pending receipt state", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-monotonic",
    rawKey: "raw/2026/07/13/dead-letter-monotonic.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let retried = false;
  let acknowledged = false;
  await processInboundMessage(
    {
      id: "late-primary-message",
      timestamp: new Date("2026-07-13T10:00:00.000Z"),
      body: pointer,
      attempts: 2,
      ack() {
        acknowledged = true;
      },
      retry() {
        retried = true;
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async head() {
          return {
            etag: "pending-etag",
            customMetadata: { state: "dead_letter_pending" },
          };
        },
        async put() {
          assert.fail("retrying must not overwrite dead_letter_pending");
        },
      },
      BUCKET: {
        async head() {
          assert.fail("terminal receipt must short-circuit the mailbox marker");
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          throw new Error("unused");
        },
      },
    },
  );

  assert.equal(retried, false);
  assert.equal(acknowledged, true);
});
