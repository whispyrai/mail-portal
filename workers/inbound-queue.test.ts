import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import PostalMime from "postal-mime";
import {
  receiveEmail,
  type InboundArchivePointer,
} from "./inbound-email.ts";
import type { InboundProjectionCommand } from "./lib/inbound-projection-contract.ts";
import type { InboundDeadlineScheduler } from "./lib/inbound-work-deadline.ts";
import {
  isInboundArchivePointer,
  processInboundBatch,
  processInboundDeadLetterBatch,
  processInboundMessage as processInboundMessageProduction,
} from "./inbound-queue.ts";

function manualDeadlineScheduler(): InboundDeadlineScheduler & {
  fireDelay(delayMs: number): void;
} {
  let nextHandle = 0;
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  return {
    setTimeout(callback, delayMs) {
      nextHandle += 1;
      pending.set(nextHandle, { callback, delayMs });
      return nextHandle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    fireDelay(delayMs) {
      const matches = [...pending.entries()].filter(
        ([, value]) => value.delayMs === delayMs,
      );
      assert.ok(matches.length > 0, `no ${delayMs}ms deadline was pending`);
      for (const [handle, value] of matches) {
        pending.delete(handle);
        value.callback();
      }
    },
  };
}

async function waitForCondition(
  condition: () => boolean,
  failure: string,
): Promise<void> {
  await Promise.race([
    (async () => {
      while (!condition()) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(failure)), 50);
    }),
  ]);
}

test("Queue pointer admission accepts legacy and minute raw keys but rejects lookalikes", () => {
  const base = {
    schemaVersion: 1,
    ingressId: "pointer-key-matrix",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-16T09:57:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  for (const rawKey of [
    "raw/2026/07/16/pointer-key-matrix.eml",
    "raw/2026/07/16/09/57/pointer-key-matrix.eml",
  ]) {
    assert.equal(isInboundArchivePointer({ ...base, rawKey }), true, rawKey);
  }
  for (const rawKey of [
    "raw/2026/07/16/09/pointer-key-matrix.eml",
    "raw/2026/07/16/09/57/extra/pointer-key-matrix.eml",
    "raw/2026/07/16/09/60/pointer-key-matrix.eml",
    "raw/2026/07/16/09/57/different-id.eml",
  ]) {
    assert.equal(isInboundArchivePointer({ ...base, rawKey }), false, rawKey);
  }
});

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
  const emergencySidecars = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  const receiptSidecars = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  let cleanupRevision = 0;
  let receiptRevision = 0;
  const projectedAuthorities = new Map<string, string>();
  const projectedEmails = new Set<string>();
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
      if (key.startsWith("system/emergency-forward/")) {
        const stored = emergencySidecars.get(key);
        return stored
          ? {
              key,
              version: "emergency-sidecar-version",
              size: stored.value.length,
              etag: stored.etag,
              body: new ReadableStream(),
              customMetadata: stored.customMetadata,
              async text() {
                return stored.value;
              },
            }
          : null;
      }
      if (key.startsWith("receipts/")) {
        const stored = receiptSidecars.get(key);
        if (stored) {
          return {
            key,
            version: "receipt-version",
            size: stored.value.length,
            etag: stored.etag,
            body: new ReadableStream(),
            customMetadata: stored.customMetadata,
            async text() { return stored.value; },
          };
        }
        let underlying: Awaited<ReturnType<typeof rawBucket.get>> = null;
        try {
          underlying = await rawBucket.get(key);
        } catch {
          // Focused raw-archive stubs commonly reject any non-raw key.
        }
        if (underlying) {
          try {
            const value = JSON.parse(await underlying.text());
            if (value?.ingressId === message.body.ingressId) return underlying;
          } catch {
            // Most focused tests use one raw-object stub for every key.
          }
        }
        const pointer = message.body;
        const value = JSON.stringify({
          schemaVersion: pointer.schemaVersion,
          ingressId: pointer.ingressId,
          rawKey: pointer.rawKey,
          mailboxId: pointer.mailboxId,
          rawSize: pointer.rawSize,
          ...(pointer.rawSha256 ? { rawSha256: pointer.rawSha256 } : {}),
          archivedAt: pointer.archivedAt,
          etag: pointer.etag,
          version: pointer.version,
          state: "enqueued",
          updatedAt: message.timestamp.toISOString(),
        });
        receiptSidecars.set(key, {
          value,
          etag: "initial-receipt-etag",
          customMetadata: { state: "enqueued" },
        });
        return {
          key,
          version: "initial-receipt-version",
          size: value.length,
          etag: "initial-receipt-etag",
          customMetadata: { state: "enqueued" },
          async text() { return value; },
        };
      }
      return rawBucket.get(key);
    },
    async put(
      key: string,
      value: string,
      options?: {
        customMetadata?: Record<string, string>;
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
      if (key.startsWith("system/emergency-forward/")) {
        const current = emergencySidecars.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (
          options?.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== current?.etag
        ) {
          return null;
        }
        const etag = `emergency-etag-${emergencySidecars.size + 1}`;
        emergencySidecars.set(key, {
          value,
          etag,
          customMetadata: options?.customMetadata,
        });
        return { etag };
      }
      if (key.startsWith("receipts/") && receiptSidecars.has(key)) {
        const current = receiptSidecars.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (
          options?.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== current?.etag
        ) {
          return null;
        }
        const written = await rawBucket.put(key, value, {
          ...(options?.customMetadata
            ? { customMetadata: options.customMetadata }
            : {}),
        } as never);
        if (written === null) return null;
        receiptRevision += 1;
        const etag = `receipt-etag-${receiptRevision}`;
        receiptSidecars.set(key, {
          value,
          etag,
          customMetadata: options?.customMetadata,
        });
        return { etag };
      }
      const written = await rawBucket.put(key, value, options as never);
      return written;
    },
    async delete(key: string) {
      if (key.startsWith("system/derived-content-cleanup-intents/pending/")) {
        cleanupIntents.delete(key);
        return;
      }
      if (key.startsWith("system/emergency-forward/")) {
        emergencySidecars.delete(key);
        return;
      }
      if ("delete" in rawBucket && typeof rawBucket.delete === "function") {
        return rawBucket.delete(key);
      }
    },
    async head(key: string) {
      const stored = emergencySidecars.get(key);
      if (stored) {
        return {
          etag: stored.etag,
          customMetadata: stored.customMetadata,
        };
      }
      if ("head" in rawBucket && typeof rawBucket.head === "function") {
        return rawBucket.head(key);
      }
      return null;
    },
  };
  return processInboundMessageProduction(
    message,
    {
      ...env,
      DB: env.DB ?? mailboxDb(),
      RAW_MAIL_BUCKET: cleanupAwareRawBucket as never,
      EMERGENCY_FORWARD_QUEUE:
        env.EMERGENCY_FORWARD_QUEUE ??
        ({ async send() {} } as never),
      MAILBOX: {
        ...env.MAILBOX,
        get(id: unknown) {
          const mailbox = get(id);
          const createInboundEmail = mailbox.createInboundEmail?.bind(mailbox);
          const getEmail = mailbox.getEmail?.bind(mailbox);
          const getInboundProjectionAuthority =
            mailbox.getInboundProjectionAuthority?.bind(mailbox);
          return {
            ...mailbox,
            ...(createInboundEmail
              ? {
                  async createInboundEmail(command: InboundProjectionCommand) {
                    const result = await createInboundEmail(command);
                    if (
                      command.archiveAuthority &&
                      result &&
                      ["stored", "duplicate"].includes(result.status)
                    ) {
                      projectedAuthorities.set(
                        command.email.id,
                        JSON.stringify(command.archiveAuthority),
                      );
                      projectedEmails.add(command.email.id);
                    }
                    return result;
                  },
                }
              : {}),
            ...(getEmail
              ? {
                  async getEmail(emailId: string) {
                    const existing = await getEmail(emailId);
                    return (
                      existing ??
                      (projectedEmails.has(emailId) ? { id: emailId } : null)
                    );
                  },
                }
              : {}),
            async getInboundProjectionAuthority(authority) {
              if (getInboundProjectionAuthority) {
                return getInboundProjectionAuthority(authority);
              }
              return projectedAuthorities.get(authority.ingressId) ===
                JSON.stringify(authority)
                ? { generation: 1 }
                : null;
            },
          };
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

function emergencySidecarStore() {
  const objects = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  let revision = 0;
  return {
    objects,
    bucket: {
      async get(key: string) {
        const object = objects.get(key);
        return object
          ? {
              key,
              etag: object.etag,
              customMetadata: object.customMetadata,
              async text() {
                return object.value;
              },
            }
          : null;
      },
      async head(key: string) {
        const object = objects.get(key);
        return object
          ? { etag: object.etag, customMetadata: object.customMetadata }
          : null;
      },
      async put(
        key: string,
        value: string,
        options?: {
          customMetadata?: Record<string, string>;
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
        },
      ) {
        const current = objects.get(key);
        if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
        if (
          options?.onlyIf?.etagMatches &&
          options.onlyIf.etagMatches !== current?.etag
        ) {
          return null;
        }
        revision += 1;
        const etag = `sidecar-etag-${revision}`;
        objects.set(key, {
          value,
          etag,
          customMetadata: options?.customMetadata,
        });
        return { etag };
      },
      async delete(key: string) {
        objects.delete(key);
      },
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    rawSha256: "c".repeat(64),
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
      async getInboundProjectionAuthority(authority: unknown) {
        assert.deepEqual(authority, {
          schemaVersion: pointer.schemaVersion,
          ingressId: pointer.ingressId,
          rawKey: pointer.rawKey,
          mailboxId: pointer.mailboxId,
          rawSize: pointer.rawSize,
          rawSha256: pointer.rawSha256,
          archivedAt: pointer.archivedAt,
          etag: pointer.etag,
          version: pointer.version,
        });
        return { generation: 1 };
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

test("a late R2 archive pointer converges on the exact same-invocation direct owner without a second projection", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "late-r2-direct-owner",
    rawKey: "raw/2026/07/17/10/00/late-r2-direct-owner.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-17T10:00:00.000Z",
    etag: "late-archive-etag",
    version: "late-archive-version",
  };
  const directAuthority = {
    schemaVersion: 1,
    ingressId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
    rawSize: pointer.rawSize,
    rawSha256: pointer.rawSha256,
    receivedAt: pointer.archivedAt,
  };
  let acknowledged = false;
  let createCalls = 0;
  await processInboundMessage(
    {
      id: "queue-late-r2-direct-owner",
      timestamp: new Date("2026-07-17T10:00:01.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("an exact direct owner must suppress Queue redelivery");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail("exact direct stored truth must avoid rereading late raw");
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
          return {
            async getInboundDeletionAuthority() {
              return null;
            },
            async getInboundProjectionAuthority(authority: {
              ingressId: string;
              mailboxId: string;
              rawSize: number;
              rawSha256: string;
              archivedAt: string;
            }) {
              assert.deepEqual(
                {
                  schemaVersion: authority.schemaVersion,
                  ingressId: authority.ingressId,
                  mailboxId: authority.mailboxId,
                  rawSize: authority.rawSize,
                  rawSha256: authority.rawSha256,
                  receivedAt: authority.archivedAt,
                },
                directAuthority,
              );
              return { generation: 1 };
            },
            async getEmail() {
              return { id: pointer.ingressId };
            },
            async createInboundEmail() {
              createCalls += 1;
              assert.fail("late raw must not create a second authority owner");
            },
          };
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("exact direct stored truth must not emergency-forward");
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(createCalls, 0);
});

test("a non-cancellable late raw put converges through Queue on the one direct owner", async () => {
  const mailboxId = "hello@wiserchat.ai";
  const rawSource = `From: sender@example.com\r\nTo: ${mailboxId}\r\n\r\nLate R2`;
  const rawBytes = new TextEncoder().encode(rawSource);
  const pendingRawPuts: Array<() => void> = [];
  let lateRaw:
    | {
        key: string;
        size: number;
        etag: string;
        version: string;
        customMetadata?: Record<string, string>;
      }
    | undefined;
  let directAuthority:
    | {
        schemaVersion: 1;
        ingressId: string;
        mailboxId: string;
        rawSize: number;
        rawSha256: string;
        receivedAt: string;
      }
    | undefined;
  let directCreates = 0;
  let archiveCreates = 0;
  let providerForwards = 0;
  let emergencyForwards = 0;
  let emailStored = false;
  const mailbox = {
    async getEmail() {
      return emailStored ? { id: directAuthority?.ingressId } : null;
    },
    async findThreadBySubject() {
      return null;
    },
    async getDirectInboundDeletionAuthority() {
      return null;
    },
    async getDirectInboundProjectionAuthority(authority: unknown) {
      return directAuthority &&
        JSON.stringify(authority) === JSON.stringify(directAuthority)
        ? { generation: 1 }
        : null;
    },
    async getInboundDeletionAuthority() {
      return null;
    },
    async getInboundProjectionAuthority(authority: {
      schemaVersion: 1;
      ingressId: string;
      mailboxId: string;
      rawSize: number;
      rawSha256: string;
      archivedAt: string;
    }) {
      return directAuthority &&
        authority.schemaVersion === directAuthority.schemaVersion &&
        authority.ingressId === directAuthority.ingressId &&
        authority.mailboxId === directAuthority.mailboxId &&
        authority.rawSize === directAuthority.rawSize &&
        authority.rawSha256 === directAuthority.rawSha256 &&
        authority.archivedAt === directAuthority.receivedAt
        ? { generation: 1 }
        : null;
    },
    async createDirectInboundEmail(command: {
      directAuthority: NonNullable<typeof directAuthority>;
    }) {
      directCreates += 1;
      directAuthority = command.directAuthority;
      emailStored = true;
      return { status: "stored" as const, cleanupKeys: [] };
    },
    async createInboundEmail() {
      archiveCreates += 1;
      assert.fail("late raw must not create an archive authority owner");
    },
  };
  const rawBucket = {
    async get() {
      return null;
    },
    async head() {
      return lateRaw ?? null;
    },
    async put(
      key: string,
      value: ArrayBuffer | string,
      options?: {
        customMetadata?: Record<string, string>;
        sha256?: ArrayBuffer;
      },
    ) {
      if (typeof value === "string") {
        return { key, size: value.length, etag: `${key}-etag`, version: "v1" };
      }
      return new Promise<typeof lateRaw>((resolve) => {
        pendingRawPuts.push(() => {
          lateRaw = {
            key,
            size: value.byteLength,
            etag: "late-direct-etag",
            version: "late-direct-version",
            customMetadata: options?.customMetadata,
            ...(options?.sha256
              ? { checksums: { sha256: options.sha256 } }
              : {}),
          } as typeof lateRaw;
          resolve(lateRaw);
        });
      });
    },
    async delete() {},
  };
  const mailboxNamespace = {
    idFromName(value: string) {
      return value;
    },
    get() {
      return mailbox;
    },
  };

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxId,
      rawSize: rawBytes.byteLength,
      raw: new ReadableStream({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      }),
      async forward() {
        providerForwards += 1;
        return { messageId: "must-not-forward" };
      },
      setReject(reason: string) {
        assert.fail(`late R2 direct fallback must not reject: ${reason}`);
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      RAW_MAIL_BUCKET: rawBucket,
      INBOUND_QUEUE: {
        async send() {
          assert.fail("raw archival had not completed during ingress");
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          emergencyForwards += 1;
        },
      },
      MAILBOX: mailboxNamespace,
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      randomUUID: () => "late-r2-direct-integrated",
      infrastructureTimeoutMs: 1,
      sleep: () => Promise.resolve(),
      async digestSha256(value: ArrayBuffer) {
        return Uint8Array.from(
          createHash("sha256").update(new Uint8Array(value)).digest(),
        ).buffer;
      },
    },
  );

  assert.equal(pendingRawPuts.length, 10);
  assert.equal(directCreates, 1);
  assert.equal(archiveCreates, 0);
  assert.equal(providerForwards, 0);
  pendingRawPuts[0]?.();
  await Promise.resolve();
  assert.ok(lateRaw);
  assert.ok(directAuthority);
  const lateMetadata = lateRaw.customMetadata;
  assert.ok(lateMetadata);
  const pointer: InboundArchivePointer = {
    schemaVersion: Number(lateMetadata.schemaVersion) as 1,
    ingressId: String(lateMetadata.ingressId),
    rawKey: lateRaw.key,
    mailboxId: String(lateMetadata.mailboxId),
    rawSize: Number(lateMetadata.rawSize),
    rawSha256: String(lateMetadata.rawSha256),
    archivedAt: String(lateMetadata.archivedAt),
    etag: lateRaw.etag,
    version: lateRaw.version,
  };
  assert.equal(pointer.rawSize, lateRaw.size);
  assert.deepEqual(
    {
      schemaVersion: pointer.schemaVersion,
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      rawSize: pointer.rawSize,
      rawSha256: pointer.rawSha256,
      receivedAt: pointer.archivedAt,
    },
    directAuthority,
  );
  let acknowledged = false;
  await processInboundMessage(
    {
      id: "late-r2-reconciliation-queue",
      timestamp: new Date("2026-07-17T10:00:01.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("late raw must converge on direct authority");
      },
    },
    {
      DB: mailboxDb(),
      RAW_MAIL_BUCKET: rawBucket,
      BUCKET: {
        async head() {
          return {};
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: mailboxNamespace,
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          emergencyForwards += 1;
        },
      },
    },
  );

  assert.equal(acknowledged, true);
  assert.equal(directCreates, 1);
  assert.equal(archiveCreates, 0);
  assert.equal(providerForwards, 0);
  assert.equal(emergencyForwards, 0);
});

test("a late R2 archive pointer remains deleted when the exact direct deletion owner exists", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "late-r2-direct-deleted",
    rawKey: "raw/2026/07/17/10/00/late-r2-direct-deleted.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-17T10:00:00.000Z",
    etag: "late-archive-etag",
    version: "late-archive-version",
  };
  let acknowledged = false;
  await processInboundMessage(
    {
      id: "queue-late-r2-direct-deleted",
      timestamp: new Date("2026-07-17T10:00:01.000Z"),
      body: pointer,
      attempts: 1,
      ack() {
        acknowledged = true;
      },
      retry() {
        assert.fail("an exact direct deletion must suppress Queue redelivery");
      },
    },
    {
      RAW_MAIL_BUCKET: {
        async get() {
          assert.fail("exact direct deletion must avoid rereading late raw");
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
          return {
            async getInboundDeletionAuthority() {
              return {
                generation: 2,
                deletedAt: "2026-07-17T10:00:00.500Z",
              };
            },
            async getInboundProjectionAuthority() {
              assert.fail("exact deletion must be checked first");
            },
            async getEmail() {
              return null;
            },
          };
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("exact direct deletion must not emergency-forward");
        },
      },
    },
  );

  assert.equal(acknowledged, true);
});

test("an unrelated same-ID email cannot mint a stored Queue receipt without exact projection authority", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "queue-unrelated-collision",
    rawKey: "raw/2026/07/17/10/00/queue-unrelated-collision.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-17T10:00:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let retried = false;
  let emergencyForwards = 0;
  let storedReceiptWrites = 0;
  await processInboundMessage(
    {
      id: "queue-unrelated-collision-delivery",
      timestamp: new Date("2026-07-17T10:00:01.000Z"),
      body: pointer,
      attempts: 1,
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
        async put(_key: string, value: string) {
          if (JSON.parse(value).state === "stored") storedReceiptWrites += 1;
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
            async getInboundDeletionAuthority() {
              return null;
            },
            async getInboundProjectionAuthority() {
              return null;
            },
            async getEmail() {
              return { id: pointer.ingressId };
            },
            async createInboundEmail() {
              assert.fail("an unrelated collision must not project");
            },
          };
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          emergencyForwards += 1;
        },
      },
    },
  );

  assert.equal(acknowledged, false);
  assert.equal(retried, true);
  assert.equal(emergencyForwards, 1);
  assert.equal(storedReceiptWrites, 0);
});

test("Queue redelivery honors a durable user-deletion tombstone", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "deleted-inbound",
    rawKey: "raw/2026/07/13/deleted-inbound.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "d".repeat(64),
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
            async getInboundDeletionAuthority() {
              return {
                generation: 2,
                deletedAt: "2026-07-13T09:30:30.000Z",
              };
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receiptState: string | undefined;
  let deletionAuthorityReads = 0;
  const mailbox = {
    async isEmailDeleted() {
      return false;
    },
    async getInboundDeletionAuthority() {
      deletionAuthorityReads += 1;
      return deletionAuthorityReads >= 2
        ? {
            generation: 2,
            deletedAt: "2026-07-13T09:30:30.000Z",
          }
        : null;
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
      async getInboundProjectionAuthority(authority: unknown) {
        return storedEmail &&
          JSON.stringify(authority) ===
            JSON.stringify({
              schemaVersion: pointer.schemaVersion,
              ingressId: pointer.ingressId,
              rawKey: pointer.rawKey,
              mailboxId: pointer.mailboxId,
              rawSize: pointer.rawSize,
              rawSha256: pointer.rawSha256,
              archivedAt: pointer.archivedAt,
              etag: pointer.etag,
              version: pointer.version,
            })
          ? { generation: 1 }
          : null;
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

test("Queue resolves a generic lost projection response as deleted only after exact deletion authority appears", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Deleted race\r\n\r\nBody";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "queue-generic-delete-race",
    rawKey: "raw/2026/07/13/queue-generic-delete-race.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let deleted = false;
  let acknowledged = false;
  let retried = false;
  let emergencyForwards = 0;
  let terminalReceipt: string | undefined;

  await processInboundMessage(
    {
      id: "queue-generic-delete-race-delivery",
      timestamp: new Date("2026-07-13T09:31:00.000Z"),
      body: pointer,
      attempts: 1,
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
          return archivedEmail(pointer.rawKey, rawSource, pointer);
        },
        async put(_key: string, value: string) {
          terminalReceipt = JSON.parse(value).state;
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
            async getInboundDeletionAuthority() {
              return deleted
                ? {
                    generation: 2,
                    deletedAt: "2026-07-13T09:30:30.000Z",
                  }
                : null;
            },
            async getInboundProjectionAuthority() {
              return null;
            },
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail() {
              deleted = true;
              throw new Error(
                "simulated generic response loss after commit and delete",
              );
            },
          };
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          emergencyForwards += 1;
        },
      },
    },
  );

  assert.equal(deleted, true);
  assert.equal(terminalReceipt, "deleted");
  assert.equal(acknowledged, true);
  assert.equal(retried, false);
  assert.equal(emergencyForwards, 0);
});

test("Queue consumption automatically forwards an unparseable archive without deleting raw MIME", async () => {
  const rawSource = "not parseable in this test";
  const rawSha256 = createHash("sha256").update(rawSource).digest("hex");
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "parse-failure",
    rawKey: "raw/2026/07/13/parse-failure.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    rawSha256,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let receipt: Record<string, unknown> | undefined;
  const forwarded: unknown[] = [];
  const sidecars = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  let sidecarRevision = 0;
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
        async get(key: string) {
          if (key === pointer.rawKey) {
            return archivedEmail(pointer.rawKey, rawSource, pointer);
          }
          const stored = sidecars.get(key);
          return stored
            ? {
                key,
                etag: stored.etag,
                customMetadata: stored.customMetadata,
                async text() {
                  return stored.value;
                },
              }
            : null;
        },
        async head(key: string) {
          const stored = sidecars.get(key);
          return stored
            ? { etag: stored.etag, customMetadata: stored.customMetadata }
            : null;
        },
        async put(
          key: string,
          value: string,
          options?: {
            customMetadata?: Record<string, string>;
            onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
          },
        ) {
          const current = sidecars.get(key);
          if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null;
          if (
            options?.onlyIf?.etagMatches &&
            options.onlyIf.etagMatches !== current?.etag
          ) {
            return null;
          }
          if (key === `receipts/${pointer.ingressId}.json`) {
            receipt = JSON.parse(value);
          }
          sidecarRevision += 1;
          const etag = `sidecar-${sidecarRevision}`;
          sidecars.set(key, {
            value,
            etag,
            customMetadata: options?.customMetadata,
          });
          return { etag };
        },
        async delete(key: string) {
          assert.equal(
            key,
            `system/inbound-active/${encodeURIComponent(pointer.rawKey)}.json`,
            "terminal cleanup may delete only the active marker, never raw MIME",
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
      EMERGENCY_FORWARD_QUEUE: {
        async send(value: unknown) {
          forwarded.push(value);
        },
      },
    };
    let retried = false;
    const message = {
      id: "queue-message-parse-failure",
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
      async parse() {
        throw new Error("simulated malformed MIME");
      },
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    });

    assert.equal(acknowledged, false);
    assert.equal(retried, true);
    assert.deepEqual(receipt, {
      ...pointer,
      state: "forward_pending",
      updatedAt: "2026-07-13T09:31:00.000Z",
      errorCode: "MIME_PARSE_FAILED",
    });
    assert.deepEqual(forwarded, [
      { schemaVersion: 1, pointer, generation: 1 },
    ]);
    const forwardError = errors.find(
      ({ message }) => message === "[mail-projection] emergency forward pending",
    );
    assert.ok(forwardError);
    assert.equal(forwardError.fields?.errorCode, "MIME_PARSE_FAILED");
    assert.equal(forwardError.fields?.operation, "mime_parse");
    assert.equal(forwardError.fields?.status, "forward_pending");
    assertTelemetryRef(forwardError.fields?.ingressRef);
    assertTelemetryRef(forwardError.fields?.objectRef);
    assertTelemetryRef(forwardError.fields?.queueRef);
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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

test("Queue consumption establishes emergency authority when its Mailbox marker disappears", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "missing-mailbox",
    rawKey: "raw/2026/07/13/missing-mailbox.eml",
    mailboxId: "removed@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  const sidecars = emergencySidecarStore();
  const emergencyQueue: unknown[] = [];
  const env = {
    RAW_MAIL_BUCKET: sidecars.bucket,
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
    EMERGENCY_FORWARD_QUEUE: {
      async send(value: unknown) { emergencyQueue.push(value); },
    },
  };
  let retried = false;
  const message = {
    id: "queue-message-missing-mailbox",
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
    parse() {
      assert.fail("a missing Mailbox marker must hand off before parsing");
    },
    now: () => new Date("2026-07-13T09:31:00.000Z"),
  });

  assert.equal(acknowledged, false);
  assert.equal(retried, true);
  assert.equal(emergencyQueue.length, 1);
  assert.equal(
    JSON.parse(
      sidecars.objects.get(`receipts/${pointer.ingressId}.json`)?.value ?? "null",
    ).state,
    "forward_pending",
  );
});

test("Queue consumption records and schedules a bounded retry when the raw archive cannot be read", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "raw-read-retry",
    rawKey: "raw/2026/07/13/raw-read-retry.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
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

  assert.equal(receipt?.state, "forward_pending");
  assert.equal(receipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.equal(retryDelay, 300);
  assert.equal(acknowledged, false);
});

test("scheduled retry establishes emergency authority before any diagnostic receipt write can throw or hang", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "authority-before-retry-evidence",
    rawKey:
      "raw/2026/07/13/09/31/authority-before-retry-evidence.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "e".repeat(64),
    archivedAt: "2026-07-13T09:31:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };

  for (const poison of ["throw", "hang"] as const) {
    const sidecars = emergencySidecarStore();
    const receiptKey = `receipts/${pointer.ingressId}.json`;
    await sidecars.bucket.put(
      receiptKey,
      JSON.stringify({
        ...pointer,
        state: "enqueued",
        updatedAt: "2026-07-13T09:31:00.000Z",
      }),
      { customMetadata: { state: "enqueued" } },
    );
    const authorityEvents: string[] = [];
    let diagnosticReceiptWrites = 0;
    const rawBucket = {
      ...sidecars.bucket,
      async get(key: string) {
        if (key === pointer.rawKey) return null;
        return sidecars.bucket.get(key);
      },
      async put(
        key: string,
        value: string,
        options?: Parameters<typeof sidecars.bucket.put>[2],
      ) {
        const body = JSON.parse(value) as { state?: string };
        if (
          key === receiptKey &&
          (body.state === "retrying" ||
            body.state === "dead_letter_pending")
        ) {
          diagnosticReceiptWrites += 1;
          if (poison === "throw") {
            throw new Error("diagnostic receipt write failed");
          }
          return new Promise<never>(() => undefined);
        }
        if (key.startsWith("system/emergency-forward/active/")) {
          authorityEvents.push("marker");
        }
        if (key === receiptKey && body.state === "forward_pending") {
          authorityEvents.push("forward_pending");
        }
        return sidecars.bucket.put(key, value, options);
      },
    };
    const actions: string[] = [];
    const work = processInboundMessageProduction(
      {
        id: `queue-authority-before-evidence-${poison}`,
        timestamp: new Date("2026-07-13T09:31:00.000Z"),
        body: pointer,
        attempts: 2,
        ack() {
          actions.push("ack");
        },
        retry(options) {
          actions.push(`retry:${options?.delaySeconds ?? 0}`);
        },
      },
      {
        DB: mailboxDb(),
        RAW_MAIL_BUCKET: rawBucket,
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
              async getInboundDeletionAuthority() {
                return null;
              },
              async getInboundProjectionAuthority() {
                return null;
              },
              async isEmailDeleted() {
                return false;
              },
              async getEmail() {
                return null;
              },
            };
          },
        },
        EMERGENCY_FORWARD_QUEUE: {
          async send() {
            authorityEvents.push("emergency_queue");
          },
        },
      },
      {
        now: () => new Date("2026-07-13T09:31:00.000Z"),
      },
    );

    await assert.doesNotReject(
      Promise.race([
        work,
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(
                  `${poison} diagnostic receipt path blocked emergency authority`,
                ),
              ),
            100,
          );
        }),
      ]),
    );
    assert.equal(diagnosticReceiptWrites, 0, poison);
    assert.deepEqual(actions, ["retry:300"], poison);
    assert.equal(authorityEvents[0], "marker", poison);
    assert.ok(
      authorityEvents.indexOf("forward_pending") >
        authorityEvents.indexOf("marker"),
      poison,
    );
    assert.ok(
      authorityEvents.indexOf("emergency_queue") >
        authorityEvents.indexOf("forward_pending"),
      poison,
    );
  }
});

test("Queue delivery acknowledges an exact stored receipt only after Mailbox truth confirms it", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "terminal-receipt-race",
    rawKey: "raw/2026/07/13/terminal-receipt-race.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let retried = false;
  let acknowledged = false;
  let markerCleanupAttempted = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        assert.equal(key, `receipts/${pointer.ingressId}.json`);
        return {
          key,
          etag: "stored-etag",
          customMetadata: { state: "stored" },
          async text() {
            return JSON.stringify({
              ...pointer,
              state: "stored",
              updatedAt: "2026-07-13T09:31:00.000Z",
            });
          },
        };
      },
      async head(key: string) {
        assert.equal(key, `receipts/${pointer.ingressId}.json`);
        return { etag: "stored-etag", customMetadata: { state: "stored" } };
      },
      async put() {
        assert.fail("a terminal stored receipt must not regress to retrying");
      },
      async delete(key: string) {
        assert.equal(
          key,
          `system/inbound-active/${encodeURIComponent(pointer.rawKey)}.json`,
        );
        markerCleanupAttempted = true;
        throw new Error("simulated active marker cleanup outage");
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
        return {
          async isEmailDeleted() {
            return false;
          },
          async getEmail() {
            return { id: pointer.ingressId };
          },
          async getInboundProjectionAuthority() {
            return { generation: 1 };
          },
        };
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
  assert.equal(markerCleanupAttempted, true);
});

test("an exact stored receipt without Mailbox truth retries without clearing recovery authority", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "stored-receipt-missing-mailbox-truth",
    rawKey:
      "raw/2026/07/13/10/00/stored-receipt-missing-mailbox-truth.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    archivedAt: "2026-07-13T10:00:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let retried = false;
  let markerDeleted = false;

  await processInboundMessage(
    {
      id: "stored-receipt-missing-mailbox-truth-message",
      timestamp: new Date("2026-07-13T10:01:00.000Z"),
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
        async get(key: string) {
          return {
            key,
            etag: "stored-etag",
            customMetadata: { state: "stored" },
            async text() {
              return JSON.stringify({
                ...pointer,
                state: "stored",
                updatedAt: "2026-07-13T10:00:30.000Z",
              });
            },
          };
        },
        async put() {
          assert.fail("unproven terminal truth must not mutate the receipt");
        },
        async delete() {
          markerDeleted = true;
        },
      },
      BUCKET: {
        async head() {
          assert.fail("unproven terminal truth must retry before projection");
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
          };
        },
      },
    },
  );

  assert.equal(acknowledged, false);
  assert.equal(retried, true);
  assert.equal(markerDeleted, false);
});

test("Queue consumption retries when the Mailbox marker cannot be read", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "marker-read-retry",
    rawKey: "raw/2026/07/13/marker-read-retry.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "c".repeat(64),
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
  assert.equal(receipt?.state, "forward_pending");
  assert.equal(receipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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

  assert.equal(receipt?.state, "forward_pending");
  assert.equal(receipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.equal("attempt" in (receipt ?? {}), false);
  assert.equal(retryDelay, 300);
  assert.equal(acknowledged, false);
});

test("Queue consumption establishes emergency authority on the final configured attempt", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-intent",
    rawKey: "raw/2026/07/13/dead-letter-intent.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "f".repeat(64),
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
  assert.equal(receipt?.state, "forward_pending");
  assert.equal(receipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.equal("attempt" in (receipt ?? {}), false);
});

test("Queue consumption retains a stored Message when its exact receipt cannot commit", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Stored\r\n\r\nBody";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "receipt-write-failure",
    rawKey: "raw/2026/07/13/receipt-write-failure.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    assert.equal(acknowledged, false);
    assert.equal(retried, true);
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    name: "forwards an inactive mailbox after SMTP acceptance",
    dbState: "inactive" as const,
    expectedReceipt: "forward_pending",
    expectedAction: "retry" as const,
  },
  {
    name: "retries when the active mailbox lookup is transiently unavailable",
    dbState: "unavailable" as const,
    expectedReceipt: "forward_pending",
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
      rawSha256: "a".repeat(64),
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
    name: "forwards when the mailbox becomes inactive at the pre-projection recheck",
    secondCheck: "inactive" as const,
    expectedReceipt: "forward_pending",
    expectedAction: "retry" as const,
  },
  {
    name: "retries when the pre-projection active lookup becomes unavailable",
    secondCheck: "unavailable" as const,
    expectedReceipt: "forward_pending",
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
      rawSha256: createHash("sha256").update(rawSource).digest("hex"),
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
    assert.equal(rawReads, 2);
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

test("Queue batch isolates a hung first delivery while a healthy second delivery completes", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "queue-hung-first",
    rawKey: "raw/2026/07/13/09/31/queue-hung-first.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "d".repeat(64),
    archivedAt: "2026-07-13T09:31:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  const sidecars = emergencySidecarStore();
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  await sidecars.bucket.put(
    receiptKey,
    JSON.stringify({
      ...pointer,
      state: "enqueued",
      updatedAt: "2026-07-13T09:31:00.000Z",
    }),
    { customMetadata: { state: "enqueued" } },
  );
  const initialReceipt = await sidecars.bucket.get(receiptKey);
  assert.ok(initialReceipt);

  let releaseReceiptRead: (() => void) | undefined;
  let receiptReads = 0;
  const rawBucket = {
    ...sidecars.bucket,
    async get(key: string) {
      if (key === receiptKey) {
        receiptReads += 1;
        if (receiptReads === 1) {
          await new Promise<void>((resolve) => {
            releaseReceiptRead = resolve;
          });
          return initialReceipt;
        }
      }
      return sidecars.bucket.get(key);
    },
  };
  const scheduler = manualDeadlineScheduler();
  const firstActions: string[] = [];
  const secondActions: string[] = [];
  const emergencyQueue: unknown[] = [];
  const work = processInboundBatch(
    {
      messages: [
        {
          id: "queue-hung-first-message",
          timestamp: new Date("2026-07-13T09:31:00.000Z"),
          body: pointer,
          attempts: 1,
          ack() {
            firstActions.push("ack");
          },
          retry(options) {
            firstActions.push(`retry:${options?.delaySeconds ?? 0}`);
          },
        },
        {
          id: "queue-healthy-second-message",
          timestamp: new Date("2026-07-13T09:31:00.000Z"),
          body: ["bounded-classification"],
          attempts: 1,
          ack() {
            secondActions.push("ack");
          },
          retry(options) {
            secondActions.push(`retry:${options?.delaySeconds ?? 0}`);
          },
        },
      ],
    },
    {
      DB: mailboxDb(),
      RAW_MAIL_BUCKET: rawBucket,
      BUCKET: {
        async head() {
          return null;
        },
        async put() {},
        async delete() {},
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          assert.fail("the hung receipt read must expire before projection");
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send(value: unknown) {
          emergencyQueue.push(value);
        },
      },
    },
    {
      deadlineScheduler: scheduler,
      infrastructureTimeoutMs: 100_000,
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    },
  );

  await waitForCondition(
    () => secondActions.length === 1,
    "the healthy second Queue delivery did not complete independently",
  );
  assert.deepEqual(secondActions, ["ack"]);
  assert.deepEqual(firstActions, []);

  scheduler.fireDelay(60_000);
  await work;

  assert.deepEqual(firstActions, ["retry:300"]);
  assert.deepEqual(secondActions, ["ack"]);
  assert.deepEqual(emergencyQueue, [
    { schemaVersion: 1, pointer, generation: 1 },
  ]);

  releaseReceiptRead?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    firstActions,
    ["retry:300"],
    "late work must not acknowledge or replace the timeout disposition",
  );
});

test("DLQ batch isolates a hung invalid-pointer ledger and fences its late acknowledgement", async () => {
  const sidecars = emergencySidecarStore();
  const scheduler = manualDeadlineScheduler();
  let releasePoisonPut: (() => void) | undefined;
  const rawBucket = {
    ...sidecars.bucket,
    async put(
      key: string,
      value: string,
      options?: Parameters<typeof sidecars.bucket.put>[2],
    ) {
      const classification = JSON.parse(value) as { bodyKind?: string };
      if (classification.bodyKind === "string") {
        await new Promise<void>((resolve) => {
          releasePoisonPut = resolve;
        });
      }
      return sidecars.bucket.put(key, value, options);
    },
  };
  const firstActions: string[] = [];
  const secondActions: string[] = [];
  const work = processInboundDeadLetterBatch(
    {
      messages: [
        {
          id: "dlq-hung-first-message",
          timestamp: new Date("2026-07-13T09:31:00.000Z"),
          body: "hung-invalid-pointer",
          attempts: 10,
          ack() {
            firstActions.push("ack");
          },
          retry(options) {
            firstActions.push(`retry:${options?.delaySeconds ?? 0}`);
          },
        },
        {
          id: "dlq-healthy-second-message",
          timestamp: new Date("2026-07-13T09:31:00.000Z"),
          body: ["bounded-classification"],
          attempts: 10,
          ack() {
            secondActions.push("ack");
          },
          retry(options) {
            secondActions.push(`retry:${options?.delaySeconds ?? 0}`);
          },
        },
      ],
    },
    {
      RAW_MAIL_BUCKET: rawBucket,
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          assert.fail("invalid DLQ pointers must not resolve a Mailbox");
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("invalid DLQ pointers must not enter emergency delivery");
        },
      },
    },
    {
      deadlineScheduler: scheduler,
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    },
  );

  await waitForCondition(
    () => secondActions.length === 1,
    "the healthy second DLQ delivery did not complete independently",
  );
  assert.deepEqual(secondActions, ["ack"]);
  assert.deepEqual(firstActions, []);

  scheduler.fireDelay(15_000);
  await work;
  assert.deepEqual(firstActions, ["retry:30"]);
  assert.deepEqual(secondActions, ["ack"]);

  releasePoisonPut?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    firstActions,
    ["retry:30"],
    "late DLQ work must not acknowledge or replace the timeout disposition",
  );
});

test("DLQ consumption records forward-pending truth and enqueues emergency delivery before acknowledging", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-terminal",
    rawKey: "raw/2026/07/13/dead-letter-terminal.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
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
  const emergencyQueue: unknown[] = [];
  const sidecars = emergencySidecarStore();
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
        ...sidecars.bucket,
        async put(
          key: string,
          value: string,
          options?: Parameters<typeof sidecars.bucket.put>[2],
        ) {
          const written = await sidecars.bucket.put(key, value, options);
          if (written && key === `receipts/${pointer.ingressId}.json`) {
            receipt = JSON.parse(value);
          }
          return written;
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
      EMERGENCY_FORWARD_QUEUE: {
        async send(value: unknown) {
          emergencyQueue.push(value);
        },
      },
    },
    {
      parse: (stream) => PostalMime.parse(stream),
      now: () => new Date("2026-07-13T10:00:00.000Z"),
    },
  );

  assert.equal(receipt?.state, "forward_pending");
  assert.equal(receipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.equal("queueMessageId" in (receipt ?? {}), false);
  assert.deepEqual(terminalFailure, {
    id: pointer.ingressId,
    archiveAuthority: pointer,
    queueRef: "9831ba66d0fbd950",
    attempts: 1,
    errorCode: "QUEUE_RETRY_EXHAUSTED",
  });
  assert.deepEqual(emergencyQueue, [
    { schemaVersion: 1, pointer, generation: 1 },
  ]);
  assert.equal(acknowledged, true);
});

test("DLQ forwarding authority is committed before terminal-ledger throws or hangs", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-indeterminate-ledger",
    rawKey: "raw/2026/07/13/10/00/dead-letter-indeterminate-ledger.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "c".repeat(64),
    archivedAt: "2026-07-13T10:00:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  for (const failure of ["throw", "hang"] as const) {
    const sidecars = emergencySidecarStore();
    const emergencyQueue: unknown[] = [];
    let acknowledged = false;
    const work = processInboundDeadLetterBatch(
      {
        messages: [{
          id: `dlq-indeterminate-ledger-${failure}`,
          timestamp: new Date("2026-07-13T10:01:00.000Z"),
          body: pointer,
          attempts: 10,
          ack() { acknowledged = true; },
          retry() { assert.fail("durable forwarding authority must acknowledge"); },
        }],
      },
      {
        RAW_MAIL_BUCKET: sidecars.bucket,
        MAILBOX: {
          idFromName(mailboxId: string) { return mailboxId; },
          get() {
            return {
              recordInboundTerminalFailure() {
                if (failure === "throw") throw new Error("ledger unavailable");
                return new Promise<never>(() => {});
              },
            };
          },
        },
        EMERGENCY_FORWARD_QUEUE: {
          async send(value: unknown) { emergencyQueue.push(value); },
        },
      },
      {
        now: () => new Date("2026-07-13T10:01:00.000Z"),
        infrastructureTimeoutMs: 1,
      },
    );
    await assert.doesNotReject(
      Promise.race([
        work,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${failure} ledger blocked forwarding`)), 40),
        ),
      ]),
    );
    assert.equal(acknowledged, true, failure);
    assert.equal(emergencyQueue.length, 1, failure);
    assert.equal(
      JSON.parse(
        sidecars.objects.get(`receipts/${pointer.ingressId}.json`)?.value ?? "null",
      ).state,
      "forward_pending",
      failure,
    );
  }
});

test("a delayed DLQ delivery does not acknowledge a stale pending receipt when terminal evidence cannot commit", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-write-race",
    rawKey: "raw/2026/07/13/dead-letter-write-race.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "b".repeat(64),
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
  let retryDelay: number | undefined;
  let attemptedReceipt: Record<string, unknown> | undefined;
  await processInboundDeadLetterBatch(
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
            retry(options) {
              retryDelay = options?.delaySeconds;
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
  );

  assert.deepEqual(receipt, {
    state: "dead_letter_pending",
    updatedAt: "2026-07-13T09:00:00.000Z",
  });
  assert.equal(attemptedReceipt?.reason, "QUEUE_RETRY_EXHAUSTED");
  assert.equal(acknowledged, false);
  assert.equal(retryDelay, 30);
  assert.equal(headCalls, 0);
});

test("a primary duplicate repairs dead-letter-pending into emergency authority", async () => {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "dead-letter-monotonic",
    rawKey: "raw/2026/07/13/dead-letter-monotonic.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "b".repeat(64),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let retried = false;
  let acknowledged = false;
  const sidecars = emergencySidecarStore();
  const receiptKey = `receipts/${pointer.ingressId}.json`;
  await sidecars.bucket.put(
    receiptKey,
    JSON.stringify({
      ...pointer,
      state: "dead_letter_pending",
      updatedAt: "2026-07-13T09:00:00.000Z",
      attempt: 2,
      delaySeconds: 4,
      errorCode: "MAILBOX_PROJECTION_FAILED",
    }),
    { customMetadata: { state: "dead_letter_pending" } },
  );
  const emergencyQueue: unknown[] = [];
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
      RAW_MAIL_BUCKET: sidecars.bucket,
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
      EMERGENCY_FORWARD_QUEUE: {
        async send(value: unknown) { emergencyQueue.push(value); },
      },
    },
  );

  assert.equal(retried, true);
  assert.equal(acknowledged, false);
  assert.equal(emergencyQueue.length, 1);
  assert.equal(
    JSON.parse(sidecars.objects.get(receiptKey)?.value ?? "null").state,
    "forward_pending",
  );
});
