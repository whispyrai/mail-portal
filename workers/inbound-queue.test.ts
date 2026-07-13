import assert from "node:assert/strict";
import test from "node:test";
import PostalMime from "postal-mime";
import type { InboundArchivePointer } from "./inbound-email.ts";
import {
  processInboundBatch,
  processInboundDeadLetterBatch,
  processInboundMessage,
} from "./inbound-queue.ts";

function archivedEmail(
  rawKey: string,
  source: string,
  pointer: InboundArchivePointer,
) {
  const bytes = new TextEncoder().encode(source);
  return {
    key: rawKey,
    version: pointer.version,
    size: bytes.byteLength,
    etag: pointer.etag,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
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
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "projection-test",
    rawKey: "raw/2026/07/13/projection-test.eml",
    mailboxId: mailboxAddress,
    rawSize: new TextEncoder().encode(rawSource).byteLength,
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let acknowledged = false;
  let retried = false;
  const stored: Array<{ folder: string; email: Record<string, unknown> }> = [];
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createEmail(folder: string, email: Record<string, unknown>) {
      stored.push({ folder, email });
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
  assert.equal(receiptWrites.length, 1);
  assert.match(receiptWrites[0], /"state":"stored"/);
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
      async createEmail() {
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
    assert.equal(duplicateLog?.fields?.ingressId, pointer.ingressId);
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
            etag: "stored-receipt",
            customMetadata: { state: "stored" },
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
            async createEmail() {
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
      async createEmail(_folder: string, email: Record<string, unknown>) {
        storedEmail = email;
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
        async delete() {
          assert.fail(
            "attachments must not be deleted after a proven Mailbox commit",
          );
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
    assert.equal(recoveredLog?.fields?.ingressId, pointer.ingressId);
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
      async createEmail() {
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
    assert.equal(receipt?.state, "quarantined");
    assert.equal(receipt?.errorCode, "MIME_PARSE_FAILED");
    assert.deepEqual(errors, [
      {
        message: "[mail-projection] quarantined",
        fields: {
          attempt: 1,
          durationMs: 0,
          errorCode: "MIME_PARSE_FAILED",
          errorMessage: "simulated malformed MIME",
          ingressId: pointer.ingressId,
          mailboxId: pointer.mailboxId,
          operation: "mime_parse",
          queueMessageId: "queue-message-parse-failure",
          rawKey: pointer.rawKey,
          status: "quarantined",
        },
      },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
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
          async createEmail() {
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
      assert.fail("a transient raw read failure must not be acknowledged");
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
});

test("Queue retry telemetry cannot overwrite a terminal receipt state", async () => {
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
        throw new Error("simulated marker outage");
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
        assert.fail("transient processing failure must retry");
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

  assert.equal(retried, true);
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
      assert.fail("transient marker read failure must not be acknowledged");
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
  assert.equal(receipt?.state, "retrying");
  assert.equal(receipt?.errorCode, "MAILBOX_MARKER_READ_FAILED");
});

test("Queue consumption quarantines an archive whose immutable metadata does not match its pointer", async () => {
  const rawSource =
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\n\r\nIntegrity";
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "integrity-mismatch",
    rawKey: "raw/2026/07/13/integrity-mismatch.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: new TextEncoder().encode(rawSource).byteLength,
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
          etag: "unexpected-etag",
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
          async createEmail() {
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
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createEmail() {
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
      assert.fail("an uncommitted Mailbox failure must not be acknowledged");
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
          async createEmail() {},
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
      assert.fail(
        "the final failed attempt must be retried into the configured DLQ",
      );
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
      async createEmail(_folder: string, email: Record<string, unknown>) {
        stored = email;
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
        assert.fail(
          "a sidecar failure after durable projection must not retry the email",
        );
      },
    };

    await processInboundMessage(message, env, {
      parse: (stream) => PostalMime.parse(stream),
      now: () => new Date("2026-07-13T09:31:00.000Z"),
    });

    assert.equal(stored?.id, pointer.ingressId);
    assert.equal(acknowledged, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fields?.errorCode, "RECEIPT_WRITE_FAILED");
    assert.equal(errors[0].fields?.status, "degraded");
  } finally {
    console.error = originalConsoleError;
  }
});

test("Queue consumption sends a branded push only after durable Mailbox projection", async () => {
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
  let stored = false;
  let pushClaimed = false;
  let pushPayload: Record<string, unknown> | undefined;
  const mailbox = {
    async findThreadBySubject() {
      return null;
    },
    async createEmail() {
      stored = true;
    },
    async getEmail() {
      return null;
    },
    async firePush(payload: Record<string, unknown>) {
      assert.equal(stored, true, "push must follow durable Mailbox projection");
      pushPayload = payload;
    },
    async claimInboundPush() {
      pushClaimed = true;
      return true;
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

  assert.equal(pushPayload?.icon, "/wiser-icon-192.png");
  assert.equal(pushClaimed, true);
  assert.equal(pushPayload?.badge, "/wiser-badge-96.png");
  assert.deepEqual(pushPayload?.data, {
    emailId: pointer.ingressId,
    mailboxId: pointer.mailboxId,
  });
});

test("Queue consumption suppresses push when another delivery owns the durable claim", async () => {
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
            async createEmail() {},
            async claimInboundPush() {
              return false;
            },
            async firePush() {
              assert.fail("a losing delivery must not emit a duplicate push");
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
});

test("Queue batch consumption acknowledges malformed pointers without touching storage", async () => {
  let acknowledged = false;
  const message = {
    id: "queue-message-malformed",
    timestamp: new Date("2026-07-13T09:31:00.000Z"),
    body: { schemaVersion: 999, rawKey: "attacker-controlled" },
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
        async put() {
          assert.fail("an invalid pointer must not write R2");
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
  );

  assert.equal(acknowledged, true);
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
            async recordInboundTerminalFailure() {},
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
  assert.equal(acknowledged, true);
});

test("DLQ consumption does not acknowledge a failed terminal receipt write", async () => {
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
  let headCalls = 0;
  let acknowledged = false;
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
              customMetadata: { state: "dead_letter_pending" },
            };
          },
          async put() {
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
    ),
    /either durable terminal ledger/,
  );

  assert.equal(acknowledged, false);
  assert.equal(headCalls, 2);
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
            async recordInboundTerminalFailure(input: Record<string, unknown>) {
              terminalLedgerInput = input;
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
  await processInboundMessage(
    {
      id: "late-primary-message",
      timestamp: new Date("2026-07-13T10:00:00.000Z"),
      body: pointer,
      attempts: 2,
      ack() {
        assert.fail("a failed delivery must retry");
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
          throw new Error("simulated marker outage");
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

  assert.equal(retried, true);
});
