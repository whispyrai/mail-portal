// Inbound email handler contract tests. These exercise the same exported
// handler Cloudflare calls, with only R2 and Durable Objects replaced at the
// platform boundary.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { receiveEmail, type InboundArchivePointer } from "./inbound-email.ts";

type R2PutTestOptions = {
  customMetadata?: Record<string, string>;
  onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
  sha256?: ArrayBuffer | string;
};

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

function r2Object(
  key: string,
  size: number,
  options?: R2PutTestOptions,
  etag = "archive-etag",
  version = "archive-version",
) {
  return {
    key,
    size,
    etag,
    version,
    ...(options?.sha256 instanceof ArrayBuffer
      ? { checksums: { sha256: options.sha256 } }
      : {}),
  };
}

function rawEmail(headers: string, body = "Hello from the Internet.") {
  const bytes = new TextEncoder().encode(`${headers}\r\n\r\n${body}`);
  return {
    raw: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    rawSize: bytes.byteLength,
  };
}

function assertTelemetryRef(value: unknown): void {
  assert.match(String(value), /^(?:[a-f0-9]{16}|unavailable)$/);
}

test("inbound delivery forwards to the emergency destination only after verifying an unreadable message recipient", async () => {
  let forwardedTo: string | undefined;
  const admissionLogs: Array<Record<string, unknown>> = [];
  const originalConsoleLog = console.log;
  console.log = (_message: string, fields?: Record<string, unknown>) => {
    if (fields?.operation === "emergency_forward_admission")
      admissionLogs.push(fields);
  };
  try {
    await receiveEmail(
      {
        from: "sender@example.com",
        to: "hello@wiserchat.ai",
        raw: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("simulated stream failure"));
          },
        }),
        rawSize: 100,
        async forward(recipient: string) {
          forwardedTo = recipient;
          return { messageId: "stream-failure-forward" };
        },
        setReject(reason: string) {
          assert.fail(
            `successful emergency forwarding must not reject: ${reason}`,
          );
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            return {};
          },
          async put() {
            assert.fail("unreadable raw bytes cannot reach storage");
          },
          async delete() {
            assert.fail("unreadable raw bytes cannot reach storage");
          },
        },
        RAW_MAIL_BUCKET: {
          async put() {
            assert.fail("unreadable raw bytes cannot reach R2");
          },
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("unreadable raw bytes cannot enqueue");
          },
        },
        MAILBOX: {
          idFromName() {
            assert.fail("unreadable raw bytes cannot reach Mailbox");
          },
          get() {
            assert.fail("unreadable raw bytes cannot reach Mailbox");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "stream-failure",
      },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(forwardedTo, "verified-backup@example.com");
  assert.deepEqual(
    admissionLogs.map(({ found, status, target }) => ({
      ...(typeof found === "boolean" ? { found } : {}),
      status,
      target,
    })),
    [
      { status: "started", target: "r2" },
      { found: true, status: "succeeded", target: "r2" },
      { status: "started", target: "d1" },
      { status: "succeeded", target: "d1" },
    ],
  );
});

for (const dbState of ["inactive", "unavailable"] as const) {
  test(`unreadable messages never emergency-forward when the mailbox is ${dbState}`, async () => {
    let forwarded = false;
    let rejection: string | undefined;
    await receiveEmail(
      {
        from: "sender@example.com",
        to: "hello@wiserchat.ai",
        raw: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("simulated stream failure"));
          },
        }),
        rawSize: 100,
        async forward() {
          forwarded = true;
          return { messageId: "must-not-forward" };
        },
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(dbState),
        BUCKET: {
          async head() {
            return {};
          },
        },
        RAW_MAIL_BUCKET: { async put() {} },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName() {
            return "unused";
          },
          get() {
            throw new Error("unused");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () => `unreadable-${dbState}`,
      },
    );

    assert.equal(forwarded, false);
    assert.match(rejection ?? "", /mailbox unavailable/i);
  });
}

test("inbound delivery rejects an unreadable message for an unverified recipient", async () => {
  let forwarded = false;
  let rejection: string | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: "typo@wiserchat.ai",
      raw: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("simulated stream failure"));
        },
      }),
      rawSize: 100,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject(reason: string) {
        rejection = reason;
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_TO: "verified-backup@example.com",
      BUCKET: {
        async head() {
          return null;
        },
        async put() {},
        async delete() {},
      },
      RAW_MAIL_BUCKET: { async put() {} },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName() {
          return "unused";
        },
        get() {
          throw new Error("unused");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "unreadable-unverified-recipient",
    },
  );

  assert.equal(forwarded, false);
  assert.match(rejection ?? "", /mailbox unavailable/i);
});

test("unreadable-message admission failures reject without forwarding or leaking provider detail", async () => {
  const errors: Array<Record<string, unknown>> = [];
  let forwarded = false;
  let rejection: string | undefined;
  const originalConsoleError = console.error;
  console.error = (_message: string, fields?: Record<string, unknown>) => {
    if (fields) errors.push(fields);
  };
  try {
    await receiveEmail(
      {
        from: "sender@example.com",
        to: "hello@wiserchat.ai",
        raw: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error("simulated stream failure"));
          },
        }),
        rawSize: 100,
        async forward() {
          forwarded = true;
          return { messageId: "must-not-forward" };
        },
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        BUCKET: {
          async head() {
            throw new Error("simulated mailbox marker outage");
          },
          async put() {},
          async delete() {},
        },
        RAW_MAIL_BUCKET: { async put() {} },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName() {
            return "unused";
          },
          get() {
            throw new Error("unused");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "unreadable-verification-outage",
      },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(forwarded, false);
  assert.match(rejection ?? "", /mailbox unavailable/i);
  const admissionFailure = errors.find(
    (fields) => fields.operation === "emergency_forward_admission",
  );
  assert.equal(admissionFailure?.errorCode, "MAILBOX_VERIFICATION_FAILED");
  assert.equal(admissionFailure?.status, "failed");
  assert.equal(admissionFailure?.durationMs, 0);
  assert.equal(admissionFailure?.target, "r2");
  const rejectionLog = errors.find(
    (fields) => fields.operation === "smtp_rejection",
  );
  assert.equal(rejectionLog?.errorCode, "MAILBOX_VERIFICATION_FAILED");
  assert.doesNotMatch(
    JSON.stringify(errors),
    /simulated stream failure|simulated mailbox marker outage/,
  );
});

test("inbound delivery archives exact raw MIME and durably enqueues its pointer before projection", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const headers = [
    "From: Sender <sender@example.com>",
    `To: ${mailboxAddress}`,
    "Subject: Durable receipt proof",
    "Message-ID: <durable-receipt@example.com>",
  ].join("\r\n");
  const body = "Hello from the Internet.";
  const raw = rawEmail(headers, body);
  const expectedRaw = new TextEncoder().encode(`${headers}\r\n\r\n${body}`);
  const expectedRawSha256 = createHash("sha256")
    .update(expectedRaw)
    .digest("hex");
  const archived: Array<{
    key: string;
    bytes: Uint8Array;
    customMetadata?: Record<string, string>;
  }> = [];
  const receiptStates: string[] = [];
  const queued: unknown[] = [];
  const externalOperations: string[] = [];
  const startedOperations: string[] = [];
  const env = {
    BRAND: "wiser",
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: mailboxDb(),
    BUCKET: {
      async head(key: string) {
        externalOperations.push("mailbox-head");
        return key === `mailboxes/${mailboxAddress}.json` ? {} : null;
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        value: ReadableStream | ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (key.startsWith("receipts/")) {
          externalOperations.push("receipt-put");
          assert.equal(typeof value, "string");
          receiptStates.push(JSON.parse(value).state);
          return r2Object(
            key,
            value.length,
            options,
            "receipt-etag",
            "receipt-version",
          );
        }
        assert.notEqual(typeof value, "string");
        externalOperations.push("raw-put");
        const bytes = new Uint8Array(await new Response(value).arrayBuffer());
        archived.push({ key, bytes, customMetadata: options?.customMetadata });
        return r2Object(key, bytes.byteLength, options);
      },
    },
    INBOUND_QUEUE: {
      async send(pointer: unknown) {
        externalOperations.push("queue-send");
        queued.push(pointer);
      },
    },
    MAILBOX: {
      idFromName() {
        assert.fail("ingress must not resolve a Mailbox Durable Object");
      },
    },
  };
  const message = {
    from: "sender@example.com",
    to: mailboxAddress,
    ...raw,
    setReject(reason: string) {
      assert.fail(`known mailbox was rejected: ${reason}`);
    },
  };

  const originalConsoleLog = console.log;
  console.log = (_message: string, fields?: Record<string, unknown>) => {
    if (fields?.status === "started" && typeof fields.operation === "string")
      startedOperations.push(fields.operation);
  };
  try {
    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "ingress-test",
      },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  assert.equal(archived.length, 1);
  assert.deepEqual(archived[0].bytes, expectedRaw);
  assert.match(archived[0].key, /^raw\/2026\/07\/13\/ingress-test\.eml$/);
  assert.deepEqual(archived[0].customMetadata, {
    archivedAt: "2026-07-13T09:30:00.000Z",
    declaredRawSize: String(expectedRaw.byteLength),
    ingressId: "ingress-test",
    mailboxId: mailboxAddress,
    rawSize: String(expectedRaw.byteLength),
    rawSha256: expectedRawSha256,
    schemaVersion: "1",
  });
  assert.deepEqual(queued, [
    {
      archivedAt: "2026-07-13T09:30:00.000Z",
      etag: "archive-etag",
      ingressId: "ingress-test",
      mailboxId: mailboxAddress,
      rawKey: archived[0].key,
      rawSize: expectedRaw.byteLength,
      rawSha256: expectedRawSha256,
      schemaVersion: 1,
      version: "archive-version",
    },
  ]);
  assert.deepEqual(receiptStates, ["archived", "admitted", "enqueued"]);
  assert.deepEqual(externalOperations, [
    "raw-put",
    "receipt-put",
    "mailbox-head",
    "receipt-put",
    "queue-send",
    "receipt-put",
  ]);
  assert.deepEqual(startedOperations, [
    "inbound_receive",
    "raw_stream_read",
    "raw_archive_checksum",
    "raw_archive",
    "receipt_write",
    "mailbox_admission_check",
    "receipt_write",
    "queue_enqueue",
    "receipt_write",
  ]);
});

test("inbound delivery never enqueues before the durable admission decision commits", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let queued = false;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`valid preserved mail must not be rejected: ${reason}`);
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_TO: "verified-backup@example.com",
      BUCKET: {
        async head() {
          return {};
        },
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (key.startsWith("receipts/")) {
            throw new Error("simulated receipt outage");
          }
          assert.ok(value instanceof ArrayBuffer);
          return r2Object(key, value.byteLength, options);
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queued = true;
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "admission-write-failure",
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(queued, false);
});

test("inbound delivery never regresses a receipt state advanced by the Queue consumer", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let receiptState: string | undefined;
  let receiptEtag: string | undefined;
  let enqueuedCondition: string | undefined;
  const env = {
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: mailboxDb(),
    BUCKET: {
      async head() {
        return {};
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        value: ReadableStream | ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (!key.startsWith("receipts/")) {
          assert.notEqual(typeof value, "string");
          const size = new Uint8Array(await new Response(value).arrayBuffer())
            .byteLength;
          return r2Object(key, size, options);
        }

        assert.equal(typeof value, "string");
        const nextState = JSON.parse(value).state;
        if (nextState === "archived") {
          receiptState = nextState;
          receiptEtag = "archived-receipt-etag";
          return {
            key,
            size: value.length,
            etag: receiptEtag,
            version: "receipt-version",
          };
        }

        if (nextState === "admitted") {
          assert.equal(options?.onlyIf?.etagMatches, "archived-receipt-etag");
          receiptState = nextState;
          receiptEtag = "admitted-receipt-etag";
          return {
            key,
            size: value.length,
            etag: receiptEtag,
            version: "receipt-version",
          };
        }

        enqueuedCondition = options?.onlyIf?.etagMatches;
        if (enqueuedCondition !== receiptEtag) return null;
        if (receiptState !== "admitted") return null;
        receiptState = nextState;
        return {
          key,
          size: value.length,
          etag: "enqueued-etag",
          version: "receipt-version",
        };
      },
    },
    INBOUND_QUEUE: {
      async send() {
        receiptState = "stored";
        receiptEtag = "stored-receipt-etag";
      },
    },
  };

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`known mailbox was rejected: ${reason}`);
      },
    },
    env,
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "receipt-race",
    },
  );

  assert.equal(enqueuedCondition, "admitted-receipt-etag");
  assert.equal(receiptState, "stored");
});

test("attachment fallback never uploads without a cleanup ledger and forwards once", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let queued = false;
  let archiveAttempts = 0;
  let cleanupIntentAttempts = 0;
  let derivedPutAttempts = 0;
  let forwardedTo: string | undefined;
  const backoffDelays: number[] = [];
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const raw = rawEmail(
      [
        "From: sender@example.com",
        `To: ${mailboxAddress}`,
        'Content-Type: multipart/mixed; boundary="direct-boundary"',
      ].join("\r\n"),
      [
        "--direct-boundary",
        "Content-Type: text/plain",
        "",
        "Direct fallback body.",
        "--direct-boundary",
        'Content-Type: application/octet-stream; name="fallback.txt"',
        'Content-Disposition: attachment; filename="fallback.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        "RGlyZWN0IGZhbGxiYWNr",
        "--direct-boundary--",
      ].join("\r\n"),
    );
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_TO: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
        async put() {
          derivedPutAttempts += 1;
          assert.fail("derived upload must not start without a verified cleanup intent");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(key: string) {
          if (key.startsWith("raw/")) archiveAttempts += 1;
          else cleanupIntentAttempts += 1;
          throw new Error("simulated R2 outage");
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queued = true;
        },
      },
      MAILBOX: {
        idFromName(id: string) {
          return id;
        },
        get() {
          return {
            async getEmail() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail() {
              assert.fail("Mailbox projection must not run without a cleanup intent");
            },
          };
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`successful emergency forwarding must not reject: ${reason}`);
      },
      async forward(recipient: string) {
        assert.equal(forwardedTo, undefined, "emergency forwarding must run once");
        forwardedTo = recipient;
        return { messageId: "attachment-fallback-forward" };
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "archive-failure",
        random: () => 0,
        sleep(delayMs: number) {
          backoffDelays.push(delayMs);
          return Promise.resolve();
        },
      },
    );

    assert.equal(queued, false);
    assert.equal(derivedPutAttempts, 0);
    assert.equal(cleanupIntentAttempts, 3);
    assert.equal(forwardedTo, "verified-backup@example.com");
    assert.equal(archiveAttempts, 10);
    assert.deepEqual(
      backoffDelays,
      [50, 100, 200, 400, 800, 1000, 1000, 1000, 1000, 100, 200],
    );
    const boundaryFailure = errors.find(
      (entry) =>
        entry.message === "[mail-ingress] raw archive attempt completed" &&
        entry.fields?.operation === "raw_archive" &&
        entry.fields?.status === "failed",
    );
    assert.equal(boundaryFailure?.fields?.attempt, 10);
    assert.equal(boundaryFailure?.fields?.errorCode, "RAW_ARCHIVE_FAILED");
    assert.equal(boundaryFailure?.fields?.status, "failed");
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery forwards to Gmail when raw archival and direct mailbox storage both fail", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let archiveAttempts = 0;
  let forwardedTo: string | undefined;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        setReject(reason: string) {
          assert.fail(
            `successful emergency forwarding must not reject: ${reason}`,
          );
        },
        async forward(recipient: string) {
          forwardedTo = recipient;
          return { messageId: "emergency-forward-id" };
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            return {};
          },
          async put(_key: string, value: unknown) {
            assert.ok(
              value instanceof ReadableStream,
              "direct fallback attachment must cross R2 as a stream",
            );
            const bytes = new Uint8Array(
              await new Response(value).arrayBuffer(),
            );
            uploadedAttachments.push(bytes);
            return { size: bytes.byteLength };
          },
          async delete() {},
        },
        RAW_MAIL_BUCKET: {
          async put() {
            archiveAttempts += 1;
            throw new Error("simulated R2 outage");
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(id: string) {
            return id;
          },
          get() {
            throw new Error("simulated Durable Object outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "archive-and-forward-failure",
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(archiveAttempts, 10);
    assert.equal(forwardedTo, "verified-backup@example.com");
    const mailboxFailure = errors.find(
      (entry) => entry.fields?.errorCode === "DIRECT_MAILBOX_FALLBACK_FAILED",
    );
    assert.equal(mailboxFailure?.fields?.status, "failed");
    assert.equal(
      errors.some(
        (entry) => entry.fields?.errorCode === "EMERGENCY_FORWARD_FAILED",
      ),
      false,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery forwards when a raw outage coincides with a transient mailbox verification outage", async () => {
  const raw = rawEmail("From: sender@example.com\r\nTo: typo@wiserchat.ai");
  let forwardedTo: string | undefined;
  let rejection: string | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: "typo@wiserchat.ai",
      ...raw,
      setReject(reason: string) {
        rejection = reason;
      },
      async forward(recipient: string) {
        forwardedTo = recipient;
        return { messageId: "verification-outage-forward" };
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_TO: "verified-backup@example.com",
      BUCKET: {
        async head() {
          throw new Error("simulated mailbox marker outage");
        },
        async put() {},
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put() {
          throw new Error("simulated R2 outage");
        },
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName() {
          return "unused";
        },
        get() {
          throw new Error("unused");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "unverified-mailbox-fallback",
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(forwardedTo, "verified-backup@example.com");
  assert.equal(rejection, undefined);
});

test("inbound delivery logs raw and fallback boundaries before starting them", async () => {
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const originalConsoleLog = console.log;
  console.log = (message: string, fields?: Record<string, unknown>) => {
    logs.push({ message, fields });
  };
  try {
    const raw = rawEmail("From: sender@example.com\r\nTo: hello@wiserchat.ai");
    await receiveEmail(
      {
        from: "sender@example.com",
        to: "hello@wiserchat.ai",
        ...raw,
        setReject(reason: string) {
          assert.fail(`successful emergency forwarding rejected: ${reason}`);
        },
        async forward() {
          return { messageId: "provider-message-id-poison" };
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            throw new Error("simulated mailbox marker outage");
          },
          async put() {},
          async delete() {},
        },
        RAW_MAIL_BUCKET: {
          async put() {
            throw new Error("simulated R2 outage");
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName() {
            return "unused";
          },
          get() {
            throw new Error("unused");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "boundary-start-logs",
        random: () => 0,
        sleep: () => Promise.resolve(),
      },
    );
  } finally {
    console.log = originalConsoleLog;
  }

  const startedOperations = logs
    .filter((entry) => entry.fields?.status === "started")
    .map((entry) => entry.fields?.operation);
  assert.deepEqual(startedOperations.slice(0, 4), [
    "inbound_receive",
    "raw_stream_read",
    "raw_archive_checksum",
    "raw_archive",
  ]);
  assert.ok(startedOperations.includes("direct_mailbox_fallback"));
  assert.ok(startedOperations.includes("emergency_forward"));
  const rawArchiveStarts = logs.filter(
    (entry) =>
      entry.fields?.operation === "raw_archive" &&
      entry.fields?.status === "started",
  );
  assert.ok(rawArchiveStarts.length > 0);
  for (const entry of rawArchiveStarts) {
    assertTelemetryRef(entry.fields?.ingressRef);
    assertTelemetryRef(entry.fields?.objectRef);
  }
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(
    serializedLogs,
    /provider-message-id-poison|boundary-start-logs|raw\/2026\/07\/13\/boundary-start-logs\.eml/,
  );
});

test("inbound delivery permanently rejects only when all three durable paths fail", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let rejection: string | undefined;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        setReject(reason: string) {
          rejection = reason;
        },
        async forward() {
          throw new Error("simulated emergency forwarding outage");
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        BUCKET: {
          async head() {
            return {};
          },
          async put() {},
          async delete() {},
        },
        RAW_MAIL_BUCKET: {
          async put() {
            throw new Error("simulated R2 outage");
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(id: string) {
            return id;
          },
          get() {
            throw new Error("simulated Durable Object outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "all-paths-failed",
        sleep: () => Promise.resolve(),
      },
    );

    assert.match(rejection ?? "", /could not be stored.*resend later/i);
    const forwardFailure = errors.find(
      (entry) => entry.fields?.errorCode === "EMERGENCY_FORWARD_FAILED",
    );
    assert.equal(forwardFailure?.fields?.status, "failed");
    const rejectionLog = errors.find(
      (entry) => entry.fields?.errorCode === "ALL_DURABILITY_PATHS_FAILED",
    );
    assert.equal(rejectionLog?.fields?.status, "rejected");
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery stores in the intended mailbox when checksum preparation fails", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let rawPutAttempted = false;
  let storedEmail: Record<string, unknown> | undefined;
  let forwarded = false;
  const errors: Array<{ fields?: Record<string, unknown> }> = [];
  const originalConsoleError = console.error;
  console.error = (_message: string, fields?: Record<string, unknown>) => {
    errors.push({ fields });
  };
  try {
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        setReject(reason: string) {
          assert.fail(`successful mailbox fallback must not reject: ${reason}`);
        },
        async forward() {
          forwarded = true;
          return { messageId: "must-not-forward" };
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            return {};
          },
          async put() {
            assert.fail(
              "plain fallback message must not upload derived objects",
            );
          },
          async delete() {},
        },
        RAW_MAIL_BUCKET: {
          async put() {
            rawPutAttempted = true;
            assert.fail("R2 must not receive a raw write without a checksum");
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(id: string) {
            return id;
          },
          get() {
            return {
              async getEmail() {
                return storedEmail ?? null;
              },
              async findThreadBySubject() {
                return null;
              },
              async createInboundEmail(command: {
                folder: string;
                email: Record<string, unknown>;
                allowTerminalRecovery: boolean;
              }) {
                assert.equal(command.folder, "inbox");
                assert.equal(command.allowTerminalRecovery, false);
                storedEmail = command.email;
                return { status: "stored" as const, cleanupKeys: [] };
              },
            };
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "digest-failure",
        async digestSha256() {
          throw new Error("simulated WebCrypto failure");
        },
      },
    );

    assert.equal(rawPutAttempted, false);
    assert.equal(forwarded, false);
    assert.equal(storedEmail?.id, "digest-failure");
    assert.equal(
      errors.find(
        (entry) =>
          entry.fields?.errorCode === "RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED",
      )?.fields?.status,
      "failed",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery retries when R2 omits the requested raw checksum", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let archiveAttempts = 0;
  let forwarded = false;
  const errors: Array<{ fields?: Record<string, unknown> }> = [];
  const originalConsoleError = console.error;
  console.error = (_message: string, fields?: Record<string, unknown>) => {
    errors.push({ fields });
  };
  try {
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        setReject(reason: string) {
          assert.fail(
            `successful emergency forwarding must not reject: ${reason}`,
          );
        },
        async forward() {
          forwarded = true;
          return { messageId: "missing-checksum-forward" };
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        BUCKET: {
          async head() {
            return {};
          },
        },
        RAW_MAIL_BUCKET: {
          async put(key: string, value: ArrayBuffer) {
            archiveAttempts += 1;
            return {
              key,
              size: value.byteLength,
              etag: "archive-etag",
              version: "archive-version",
            };
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(id: string) {
            return id;
          },
          get() {
            throw new Error("simulated Durable Object outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "missing-checksum",
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(archiveAttempts, 10);
    assert.equal(forwarded, true);
    const archiveFailures = errors.filter(
      (entry) => entry.fields?.operation === "raw_archive",
    );
    assert.equal(archiveFailures.length, 10);
    assert.equal(
      archiveFailures.at(-1)?.fields?.errorCode,
      "RAW_ARCHIVE_CHECKSUM_UNAVAILABLE",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery retries when R2 returns a same-size raw object with the wrong checksum", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let archiveAttempts = 0;
  let forwarded = false;
  const errors: Array<{ fields?: Record<string, unknown> }> = [];
  const originalConsoleError = console.error;
  console.error = (_message: string, fields?: Record<string, unknown>) => {
    errors.push({ fields });
  };
  try {
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        setReject(reason: string) {
          assert.fail(
            `successful emergency forwarding must not reject: ${reason}`,
          );
        },
        async forward() {
          forwarded = true;
          return { messageId: "wrong-checksum-forward" };
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        BUCKET: {
          async head() {
            return {};
          },
        },
        RAW_MAIL_BUCKET: {
          async put(key: string, value: ArrayBuffer) {
            archiveAttempts += 1;
            return {
              key,
              size: value.byteLength,
              etag: "archive-etag",
              version: "archive-version",
              checksums: { sha256: new ArrayBuffer(32) },
            };
          },
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(id: string) {
            return id;
          },
          get() {
            throw new Error("simulated Durable Object outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "wrong-checksum",
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(archiveAttempts, 10);
    assert.equal(forwarded, true);
    const archiveFailures = errors.filter(
      (entry) => entry.fields?.operation === "raw_archive",
    );
    assert.equal(archiveFailures.length, 10);
    assert.equal(
      archiveFailures.at(-1)?.fields?.errorCode,
      "RAW_ARCHIVE_CHECKSUM_MISMATCH",
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery refuses handoff when the persisted raw size does not match the envelope", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let queued = false;
  let archiveAttempts = 0;
  let forwarded = false;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(),
      EMERGENCY_FORWARD_TO: "verified-backup@example.com",
      BUCKET: {
        async head() {
          return {};
        },
      },
      RAW_MAIL_BUCKET: {
        async put(key: string, value: ReadableStream) {
          archiveAttempts += 1;
          const bytes = new Uint8Array(await new Response(value).arrayBuffer());
          return {
            key,
            size: bytes.byteLength - 1,
            etag: "archive-etag",
            version: "archive-version",
          };
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queued = true;
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(
          `successful emergency forwarding must not reject: ${reason}`,
        );
      },
      async forward() {
        forwarded = true;
        return { messageId: "size-mismatch-forward" };
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "size-mismatch",
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(queued, false);
    assert.equal(forwarded, true);
    assert.equal(archiveAttempts, 10);
    const archiveErrors = errors.filter(
      (entry) => entry.fields?.operation === "raw_archive",
    );
    assert.equal(archiveErrors.length, 10);
    assert.equal(
      archiveErrors.at(-1)?.fields?.errorCode,
      "RAW_ARCHIVE_SIZE_MISMATCH",
    );
    assertTelemetryRef(archiveErrors.at(-1)?.fields?.objectRef);
    assert.equal("rawKey" in (archiveErrors.at(-1)?.fields ?? {}), false);
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery preserves the raw archive when Queue enqueue fails", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const archivedKeys: string[] = [];
  const receiptStates: string[] = [];
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const raw = rawEmail(
      [
        "From: sender@example.com",
        `To: ${mailboxAddress}`,
        'Content-Type: multipart/mixed; boundary="direct-boundary"',
      ].join("\r\n"),
      [
        "--direct-boundary",
        "Content-Type: text/plain",
        "",
        "Direct fallback body.",
        "--direct-boundary",
        'Content-Type: application/octet-stream; name="fallback.txt"',
        'Content-Disposition: attachment; filename="fallback.txt"',
        "Content-Transfer-Encoding: base64",
        "",
        "RGlyZWN0IGZhbGxiYWNr",
        "--direct-boundary--",
      ].join("\r\n"),
    );
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ReadableStream | ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (key.startsWith("receipts/")) {
            assert.equal(typeof value, "string");
            receiptStates.push(JSON.parse(value).state);
            return r2Object(
              key,
              value.length,
              options,
              "receipt-etag",
              "receipt-version",
            );
          }
          assert.notEqual(typeof value, "string");
          const bytes = new Uint8Array(await new Response(value).arrayBuffer());
          archivedKeys.push(key);
          return r2Object(key, bytes.byteLength, options);
        },
      },
      INBOUND_QUEUE: {
        async send() {
          throw new Error("simulated Queue outage");
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`known mailbox was rejected: ${reason}`);
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "queue-failure",
      },
    );

    assert.deepEqual(archivedKeys, ["raw/2026/07/13/queue-failure.eml"]);
    assert.deepEqual(receiptStates, ["archived", "admitted"]);
    assert.deepEqual(errors, [
      {
        message: "[mail-ingress] boundary failed",
        fields: {
          durationMs: 0,
          errorCode: "QUEUE_ENQUEUE_FAILED",
          ingressRef: errors[0]?.fields?.ingressRef,
          objectRef: errors[0]?.fields?.objectRef,
          operation: "queue_enqueue",
          recoveryAction: "scheduled_reconciliation",
          status: "deferred",
        },
      },
    ]);
    assertTelemetryRef(errors[0]?.fields?.ingressRef);
    assertTelemetryRef(errors[0]?.fields?.objectRef);
    assert.doesNotMatch(
      JSON.stringify(errors),
      /simulated Queue outage|queue-failure|hello@wiserchat\.ai/,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery uses the SMTP envelope recipient when the visible To header differs", async () => {
  const mailboxAddress = "hesham@wiserchat.ai";
  let queuedPointer: InboundArchivePointer | undefined;
  const env = {
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: mailboxDb(),
    BUCKET: {
      async head(key: string) {
        return key === `mailboxes/${mailboxAddress}.json` ? {} : null;
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        _value: ReadableStream,
        options?: R2PutTestOptions,
      ) {
        return r2Object(key, message.rawSize, options);
      },
    },
    INBOUND_QUEUE: {
      async send(pointer: InboundArchivePointer) {
        queuedPointer = pointer;
      },
    },
  };
  const message = {
    from: "sender@example.com",
    to: mailboxAddress,
    ...rawEmail(
      [
        "From: Sender <sender@example.com>",
        "To: Visible recipient <someone-else@example.com>",
        "Subject: Envelope recipient proof",
        "Date: Fri, 10 Jul 2026 12:00:00 +0000",
        "Message-ID: <envelope-proof@example.com>",
      ].join("\r\n"),
    ),
    setReject(reason: string) {
      assert.fail(`known mailbox was rejected: ${reason}`);
    },
  };
  await receiveEmail(
    message,
    env,
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "envelope-recipient",
    },
  );

  assert.equal(queuedPointer?.mailboxId, mailboxAddress);
  assert.notEqual(queuedPointer?.mailboxId, "someone-else@example.com");
});

test("inbound delivery preserves archived mail when the mailbox marker lookup is transiently unavailable", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let rawArchived = false;
  let queued = false;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      BUCKET: {
        async head() {
          throw new Error("simulated mailbox marker outage");
        },
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ReadableStream | ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (key.startsWith("receipts/")) {
            return r2Object(
              key,
              String(value).length,
              options,
              "receipt-etag",
              "receipt-version",
            );
          }
          rawArchived = true;
          assert.notEqual(typeof value, "string");
          const size = new Uint8Array(await new Response(value).arrayBuffer())
            .byteLength;
          return r2Object(key, size, options);
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queued = true;
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(
          `transient lookup outage must not permanently reject: ${reason}`,
        );
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "admission-lookup-outage",
      },
    );

    assert.equal(rawArchived, true);
    assert.equal(queued, false);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fields?.errorCode, "MAILBOX_ADMISSION_CHECK_FAILED");
    assert.equal(errors[0].fields?.status, "degraded");
  } finally {
    console.error = originalConsoleError;
  }
});

for (const testCase of [
  {
    name: "rejects an archived delivery when D1 says the mailbox is inactive",
    dbState: "inactive" as const,
    expectedReceipts: ["archived", "rejected"],
    expectedRejection: true,
  },
  {
    name: "preserves an archived delivery when the D1 active lookup is transiently unavailable",
    dbState: "unavailable" as const,
    expectedReceipts: ["archived"],
    expectedRejection: false,
  },
]) {
  test(`inbound delivery ${testCase.name}`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const receiptStates: string[] = [];
    let rejection: string | undefined;
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
      setReject(reason: string) {
        rejection = reason;
      },
    };

    await receiveEmail(
      message,
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_TO: "verified-backup@example.com",
        DB: mailboxDb(testCase.dbState),
        BUCKET: {
          async head() {
            return {};
          },
        },
        RAW_MAIL_BUCKET: {
          async put(
            key: string,
            value: ArrayBuffer | string,
            options?: R2PutTestOptions,
          ) {
            if (key.startsWith("receipts/")) {
              const state = JSON.parse(String(value)).state as string;
              receiptStates.push(state);
              return r2Object(
                key,
                String(value).length,
                options,
                `receipt-${state}`,
              );
            }
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          },
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("unadmitted archived mail must not enqueue");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () => `d1-${testCase.dbState}`,
      },
    );

    assert.deepEqual(receiptStates, testCase.expectedReceipts);
    assert.equal(Boolean(rejection), testCase.expectedRejection);
  });
}

test("inbound delivery archives before permanently rejecting an unprovisioned envelope recipient", async () => {
  let rawWasRead = false;
  let rawWasArchived = false;
  let rejection: string | undefined;
  const rawBytes = new Uint8Array(100);
  const message = {
    from: "sender@example.com",
    to: "typo@wiserchat.ai",
    get raw() {
      rawWasRead = true;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(rawBytes);
          controller.close();
        },
      });
    },
    rawSize: 100,
    setReject(reason: string) {
      rejection = reason;
    },
  };
  const env = {
    DOMAINS: "wiserchat.ai,test.wiserchat.ai",
    EMAIL_ADDRESSES: [],
    BUCKET: {
      async head() {
        assert.equal(
          rawWasArchived,
          true,
          "mailbox lookup must follow raw persistence",
        );
        return null;
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (!key.startsWith("receipts/")) rawWasArchived = true;
        return r2Object(
          key,
          typeof value === "string" ? value.length : value.byteLength,
          options,
        );
      },
    },
    INBOUND_QUEUE: { async send() {} },
  };

  await receiveEmail(message, env, { waitUntil() {} });

  assert.match(rejection ?? "", /mailbox unavailable/i);
  assert.equal(rawWasRead, true);
  assert.equal(rawWasArchived, true);
});

test("inbound delivery never issues SMTP rejection until the rejected receipt is durable", async () => {
  const mailboxAddress = "missing@wiserchat.ai";
  const states: string[] = [];
  let rejected = false;
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject() {
        rejected = true;
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return null;
        },
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (!key.startsWith("receipts/")) {
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          }
          const state = JSON.parse(String(value)).state as string;
          states.push(state);
          return state === "archived"
            ? r2Object(key, String(value).length, options, "archived-etag")
            : null;
        },
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("unprovisioned mail must not enqueue");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "rejection-receipt-race",
    },
  );

  assert.deepEqual(states, ["archived", "rejected"]);
  assert.equal(rejected, false);
});

test("inbound delivery rejects an envelope recipient outside EMAIL_ADDRESSES", async () => {
  let rejection: string | undefined;
  let mailboxWasChecked = false;
  let rawWasArchived = false;
  const message = {
    from: "sender@example.com",
    to: "contact@wiserchat.ai",
    ...rawEmail("From: sender@example.com\r\nTo: contact@wiserchat.ai"),
    setReject(reason: string) {
      rejection = reason;
    },
  };
  const env = {
    DOMAINS: "wiserchat.ai,test.wiserchat.ai",
    EMAIL_ADDRESSES: ["hello@wiserchat.ai"],
    BUCKET: {
      async head() {
        mailboxWasChecked = true;
        return {};
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (!key.startsWith("receipts/")) rawWasArchived = true;
        return r2Object(
          key,
          typeof value === "string" ? value.length : value.byteLength,
          options,
        );
      },
    },
    INBOUND_QUEUE: { async send() {} },
  };

  await receiveEmail(message, env, { waitUntil() {} });

  assert.match(rejection ?? "", /mailbox unavailable/i);
  assert.equal(mailboxWasChecked, false);
  assert.equal(rawWasArchived, true);
});

test("inbound delivery archives recipients outside configured mail domains before rejection", async () => {
  let mailboxWasChecked = false;
  let rawWasArchived = false;
  let rejection: string | undefined;
  const message = {
    from: "sender@example.com",
    to: "hesham@wiserchat.ai.attacker.example",
    ...rawEmail(
      "From: sender@example.com\r\nTo: hesham@wiserchat.ai.attacker.example",
    ),
    setReject(reason: string) {
      rejection = reason;
    },
  };
  const env = {
    DOMAINS: "wiserchat.ai,test.wiserchat.ai",
    EMAIL_ADDRESSES: [],
    BUCKET: {
      async head() {
        mailboxWasChecked = true;
        return null;
      },
    },
    RAW_MAIL_BUCKET: {
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (!key.startsWith("receipts/")) rawWasArchived = true;
        return r2Object(
          key,
          typeof value === "string" ? value.length : value.byteLength,
          options,
        );
      },
    },
    INBOUND_QUEUE: { async send() {} },
  };

  await receiveEmail(message, env, { waitUntil() {} });

  assert.match(rejection ?? "", /mailbox unavailable/i);
  assert.equal(mailboxWasChecked, false);
  assert.equal(rawWasArchived, true);
});
