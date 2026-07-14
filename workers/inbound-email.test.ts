// Inbound email handler contract tests. These exercise the same exported
// handler Cloudflare calls, with only R2 and Durable Objects replaced at the
// platform boundary.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { receiveEmail, type InboundArchivePointer } from "./inbound-email.ts";

type R2PutTestOptions = {
  customMetadata?: Record<string, string>;
  onlyIf?: { etagMatches?: string };
  sha256?: ArrayBuffer | string;
};

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

test("inbound delivery forwards to the emergency destination only after verifying an unreadable message recipient", async () => {
  let forwardedTo: string | undefined;
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

  assert.equal(forwardedTo, "verified-backup@example.com");
});

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
  const env = {
    BRAND: "wiser",
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
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

  await receiveEmail(
    message,
    env,
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "ingress-test",
    },
  );

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
  assert.deepEqual(receiptStates, ["admitted", "enqueued"]);
  assert.deepEqual(externalOperations, [
    "raw-put",
    "mailbox-head",
    "receipt-put",
    "queue-send",
    "receipt-put",
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
        if (nextState === "admitted") {
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

test("inbound delivery writes directly to the intended mailbox after raw retries exhaust", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let queued = false;
  let archiveAttempts = 0;
  let storedEmail: Record<string, unknown> | undefined;
  const uploadedAttachments: Uint8Array[] = [];
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
      BUCKET: {
        async head() {
          return {};
        },
        async put(_key: string, value: unknown) {
          assert.ok(
            value instanceof ReadableStream,
            "direct fallback attachment must cross R2 as a stream",
          );
          const bytes = new Uint8Array(await new Response(value).arrayBuffer());
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
              return storedEmail ?? null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createEmail(folder: string, email: Record<string, unknown>) {
              assert.equal(folder, "inbox");
              storedEmail = email;
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
        assert.fail(`successful direct storage must not reject: ${reason}`);
      },
      async forward() {
        assert.fail("successful direct storage must not forward externally");
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "archive-failure",
        sleep(delayMs: number) {
          backoffDelays.push(delayMs);
          return Promise.resolve();
        },
      },
    );

    assert.equal(queued, false);
    assert.equal(storedEmail?.id, "archive-failure");
    assert.equal(storedEmail?.date, "2026-07-13T09:30:00.000Z");
    assert.equal(uploadedAttachments.length, 1);
    assert.equal(
      new TextDecoder().decode(uploadedAttachments[0]),
      "Direct fallback",
    );
    assert.equal(archiveAttempts, 10);
    assert.deepEqual(
      backoffDelays,
      [100, 200, 400, 800, 1600, 2000, 2000, 2000, 2000],
    );
    assert.equal(errors.length, 10);
    assert.equal(errors.at(-1)?.message, "[mail-ingress] boundary failed");
    assert.equal(errors.at(-1)?.fields?.attempt, 10);
    assert.equal(errors.at(-1)?.fields?.errorCode, "RAW_ARCHIVE_FAILED");
    assert.equal(errors.at(-1)?.fields?.status, "failed");
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

test("inbound delivery never forwards when a raw outage coincides with an unverifiable mailbox", async () => {
  const raw = rawEmail("From: sender@example.com\r\nTo: typo@wiserchat.ai");
  let forwarded = false;
  let rejection: string | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: "typo@wiserchat.ai",
      ...raw,
      setReject(reason: string) {
        rejection = reason;
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

  assert.equal(forwarded, false);
  assert.match(rejection ?? "", /mailbox unavailable/i);
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
              async createEmail(
                folder: string,
                email: Record<string, unknown>,
              ) {
                assert.equal(folder, "inbox");
                storedEmail = email;
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
    assert.equal(
      archiveErrors.at(-1)?.fields?.rawKey,
      "raw/2026/07/13/size-mismatch.eml",
    );
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
    assert.deepEqual(receiptStates, ["admitted"]);
    assert.deepEqual(errors, [
      {
        message: "[mail-ingress] boundary failed",
        fields: {
          durationMs: 0,
          errorCode: "QUEUE_ENQUEUE_FAILED",
          errorMessage: "simulated Queue outage",
          ingressId: "queue-failure",
          mailboxId: mailboxAddress,
          operation: "queue_enqueue",
          rawKey: "raw/2026/07/13/queue-failure.eml",
          recoveryAction: "scheduled_reconciliation",
          status: "deferred",
        },
      },
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("inbound delivery uses the SMTP envelope recipient when the visible To header differs", async () => {
  const mailboxAddress = "hesham@wiserchat.ai";
  let queuedPointer: InboundArchivePointer | undefined;
  const env = {
    DOMAINS: "wiserchat.ai,test.wiserchat.ai",
    EMAIL_ADDRESSES: [],
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

test("inbound delivery still archives and enqueues when the mailbox admission lookup is transiently unavailable", async () => {
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
    assert.equal(queued, true);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fields?.errorCode, "MAILBOX_ADMISSION_CHECK_FAILED");
    assert.equal(errors[0].fields?.status, "degraded");
  } finally {
    console.error = originalConsoleError;
  }
});

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
