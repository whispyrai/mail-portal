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
    customMetadata: options?.customMetadata,
    ...(options?.sha256 instanceof ArrayBuffer
      ? { checksums: { sha256: options.sha256 } }
      : {}),
  };
}

function isActiveMarkerKey(key: string): boolean {
  return key.startsWith("system/inbound-active/");
}

function activeMarkerObject(
  key: string,
  value: unknown,
  options?: R2PutTestOptions,
) {
  assert.equal(typeof value, "string");
  return r2Object(
    key,
    value.length,
    options,
    "active-marker-etag",
    "active-marker-version",
  );
}

function r2TextObject(key: string, value: string, etag = "receipt-etag") {
  return {
    ...r2Object(key, value.length, undefined, etag, "receipt-version"),
    body: new ReadableStream(),
    async text() {
      return value;
    },
  };
}

function rejectionRecoveryBucket(
  mode: "concurrent_winner" | "false" | "throw",
) {
  const sidecars = new Map<
    string,
    { value: string; etag: string; customMetadata?: Record<string, string> }
  >();
  let raw:
    | {
        key: string;
        bytes: Uint8Array;
        customMetadata?: Record<string, string>;
        sha256?: ArrayBuffer | string;
      }
    | undefined;
  let revision = 0;
  const objectForSidecar = (
    key: string,
    stored: {
      value: string;
      etag: string;
      customMetadata?: Record<string, string>;
    },
  ) => ({
    ...r2TextObject(key, stored.value, stored.etag),
    customMetadata: stored.customMetadata,
  });
  return {
    sidecars,
    bucket: {
      async head(key: string) {
        if (raw?.key === key) {
          return {
            ...r2Object(
              key,
              raw.bytes.byteLength,
              { sha256: raw.sha256 },
            ),
            customMetadata: raw.customMetadata,
          };
        }
        const stored = sidecars.get(key);
        return stored ? objectForSidecar(key, stored) : null;
      },
      async get(key: string) {
        if (raw?.key === key) {
          return {
            ...r2Object(
              key,
              raw.bytes.byteLength,
              { sha256: raw.sha256 },
            ),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(raw?.bytes);
                controller.close();
              },
            }),
            customMetadata: raw.customMetadata,
            async text() {
              return new TextDecoder().decode(raw?.bytes);
            },
          };
        }
        const stored = sidecars.get(key);
        return stored ? objectForSidecar(key, stored) : null;
      },
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (value instanceof ArrayBuffer) {
          raw = {
            key,
            bytes: new Uint8Array(value),
            customMetadata: options?.customMetadata,
            sha256: options?.sha256,
          };
          return r2Object(key, value.byteLength, options);
        }
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (
          key.startsWith("receipts/") &&
          parsed.state === "rejected"
        ) {
          if (mode === "throw")
            throw new Error("simulated rejected receipt write outage");
          if (mode === "concurrent_winner") {
            revision += 1;
            sidecars.set(key, {
              value: JSON.stringify({
                ...parsed,
                state: "forward_pending",
                errorCode: "INGRESS_RECOVERY_REQUIRED",
              }),
              etag: `sidecar-${revision}`,
              customMetadata: { state: "forward_pending" },
            });
          }
          return null;
        }
        const current = sidecars.get(key);
        if (
          options?.onlyIf?.etagDoesNotMatch === "*" &&
          current
        ) return null;
        if (
          options?.onlyIf?.etagMatches &&
          current?.etag !== options.onlyIf.etagMatches
        ) return null;
        revision += 1;
        const stored = {
          value,
          etag: `sidecar-${revision}`,
          customMetadata: options?.customMetadata,
        };
        sidecars.set(key, stored);
        return objectForSidecar(key, stored);
      },
      async delete(key: string) {
        sidecars.delete(key);
      },
    },
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
  test(`unreadable messages use verified policy or emergency delivery when the mailbox is ${dbState}`, async () => {
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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

    assert.equal(forwarded, dbState === "unavailable");
    if (dbState === "inactive") {
      assert.match(rejection ?? "", /mailbox unavailable/i);
    } else {
      assert.equal(rejection, undefined);
    }
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
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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

test("unreadable-message R2 admission outages forward without leaking provider detail", async () => {
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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

  assert.equal(forwarded, true);
  assert.equal(rejection, undefined);
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
  assert.equal(rejectionLog, undefined);
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
        if (isActiveMarkerKey(key)) {
          externalOperations.push("active-marker-put");
          return activeMarkerObject(key, value, options);
        }
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
  assert.equal(
    archived[0].key,
    "raw/2026/07/13/09/30/ingress-test.eml",
  );
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
    "active-marker-put",
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

test("a late timed-out initial raw put cannot supersede the exact create-only winner", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let currentRaw: ReturnType<typeof r2Object> | undefined;
  let completeTimedOutPut: (() => void) | undefined;
  let rawPutAttempts = 0;
  let queuedPointer: InboundArchivePointer | undefined;
  const rawConditions: Array<R2PutTestOptions["onlyIf"]> = [];

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
      async forward() {
        assert.fail("an exact raw winner must not emergency-forward");
      },
      setReject(reason: string) {
        assert.fail(`an exact raw winner must not reject: ${reason}`);
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: { async head() { return {}; } },
      RAW_MAIL_BUCKET: {
        async get() { return null; },
        async head(key: string) {
          return currentRaw?.key === key ? currentRaw : null;
        },
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (typeof value === "string")
            return r2Object(key, value.length, options, `${key}-etag`);
          rawPutAttempts += 1;
          rawConditions.push(options?.onlyIf);
          if (rawPutAttempts === 1) {
            return new Promise<ReturnType<typeof r2Object> | null>((resolve) => {
              completeTimedOutPut = () => {
                if (currentRaw) {
                  resolve(null);
                  return;
                }
                currentRaw = r2Object(
                  key,
                  value.byteLength,
                  options,
                  "late-etag",
                  "late-version",
                );
                resolve(currentRaw);
              };
            });
          }
          assert.equal(currentRaw, undefined);
          currentRaw = r2Object(
            key,
            value.byteLength,
            options,
            "winner-etag",
            "winner-version",
          );
          return currentRaw;
        },
      },
      INBOUND_QUEUE: {
        async send(pointer: InboundArchivePointer) {
          queuedPointer = pointer;
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("normal Queue success must not use emergency recovery");
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("normal Queue success must not resolve Mailbox");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      randomUUID: () => "late-initial-raw-put",
      infrastructureTimeoutMs: 1,
      sleep: () => Promise.resolve(),
      async digestSha256(value: ArrayBuffer) {
        return new Uint8Array(
          createHash("sha256").update(new Uint8Array(value)).digest(),
        ).buffer;
      },
    },
  );

  assert.equal(rawPutAttempts, 2);
  assert.deepEqual(rawConditions, [
    { etagDoesNotMatch: "*" },
    { etagDoesNotMatch: "*" },
  ]);
  assert.equal(queuedPointer?.version, "winner-version");
  assert.ok(completeTimedOutPut);
  completeTimedOutPut();
  await Promise.resolve();
  assert.equal(currentRaw?.version, "winner-version");
  assert.equal(currentRaw?.etag, queuedPointer?.etag);
});

test("a raw put that completes after direct fallback preserves the direct owner for later Queue convergence", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const lateCompletions: Array<() => void> = [];
  let rawPutAttempts = 0;
  let lateRaw: ReturnType<typeof r2Object> | undefined;
  let storedEmail: { id: string } | undefined;
  let storedAuthority: Record<string, unknown> | undefined;
  let forwardCalls = 0;

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwardCalls += 1;
        return { messageId: "must-not-forward-late-r2-direct" };
      },
      setReject(reason: string) {
        assert.fail(`direct fallback must not reject: ${reason}`);
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
        async put() {
          assert.fail("plain direct fallback must not upload derived content");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async head() {
          return lateRaw ?? null;
        },
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          assert.ok(value instanceof ArrayBuffer);
          rawPutAttempts += 1;
          return new Promise<ReturnType<typeof r2Object>>((resolve) => {
            lateCompletions.push(() => {
              lateRaw = r2Object(
                key,
                value.byteLength,
                options,
                "late-direct-etag",
                "late-direct-version",
              );
              resolve(lateRaw);
            });
          });
        },
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("timed-out raw archival must not enqueue yet");
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return storedEmail ?? null;
            },
            async getDirectInboundDeletionAuthority() {
              return null;
            },
            async getDirectInboundProjectionAuthority(
              authority: Record<string, unknown>,
            ) {
              return storedAuthority &&
                JSON.stringify(authority) === JSON.stringify(storedAuthority)
                ? { generation: 1 }
                : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createDirectInboundEmail(command: {
              email: { id: string };
              directAuthority: Record<string, unknown>;
            }) {
              storedEmail = command.email;
              storedAuthority = command.directAuthority;
              return { status: "stored" as const, cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      randomUUID: () => "late-r2-direct-owner",
      infrastructureTimeoutMs: 1,
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(rawPutAttempts, 10);
  assert.equal(storedEmail?.id, "late-r2-direct-owner");
  assert.equal(forwardCalls, 0);
  assert.equal(lateRaw, undefined);
  lateCompletions[0]?.();
  await Promise.resolve();
  assert.equal(lateRaw?.key, "raw/2026/07/17/10/00/late-r2-direct-owner.eml");
  assert.equal(storedAuthority?.ingressId, "late-r2-direct-owner");
});

test("a late timed-out MD5-to-SHA rewrite cannot supersede the exact CAS winner", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  let currentRaw:
    | (ReturnType<typeof r2Object> & {
        checksums: { md5?: ArrayBuffer; sha256?: ArrayBuffer };
      })
    | undefined;
  let completeTimedOutUpgrade: (() => void) | undefined;
  let digestCalls = 0;
  let rawPutAttempts = 0;
  let queuedPointer: InboundArchivePointer | undefined;
  const rawConditions: Array<R2PutTestOptions["onlyIf"]> = [];

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
      async forward() {
        assert.fail("an exact SHA upgrade winner must not emergency-forward");
      },
      setReject(reason: string) {
        assert.fail(`an exact SHA upgrade winner must not reject: ${reason}`);
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: { async head() { return {}; } },
      RAW_MAIL_BUCKET: {
        async get() { return null; },
        async head(key: string) {
          return currentRaw?.key === key ? currentRaw : null;
        },
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (typeof value === "string")
            return r2Object(key, value.length, options, `${key}-etag`);
          rawPutAttempts += 1;
          rawConditions.push(options?.onlyIf);
          if (rawPutAttempts === 1) {
            currentRaw = {
              ...r2Object(
                key,
                value.byteLength,
                options,
                "weak-etag",
                "weak-version",
              ),
              checksums: { md5: new Uint8Array(16).buffer },
            };
            return currentRaw;
          }
          const completeUpgrade = (
            resolve: (value: typeof currentRaw | null) => void,
            etag: string,
            version: string,
          ) => {
            if (
              currentRaw?.etag !== options?.onlyIf?.etagMatches ||
              !(options?.sha256 instanceof ArrayBuffer)
            ) {
              resolve(null);
              return;
            }
            currentRaw = {
              ...r2Object(
                key,
                value.byteLength,
                options,
                etag,
                version,
              ),
              checksums: { sha256: options.sha256 },
            };
            resolve(currentRaw);
          };
          if (rawPutAttempts === 2) {
            return new Promise<typeof currentRaw | null>((resolve) => {
              completeTimedOutUpgrade = () =>
                completeUpgrade(resolve, "late-sha-etag", "late-sha-version");
            });
          }
          return new Promise<typeof currentRaw | null>((resolve) => {
            completeUpgrade(resolve, "sha-winner-etag", "sha-winner-version");
          });
        },
      },
      INBOUND_QUEUE: {
        async send(pointer: InboundArchivePointer) {
          queuedPointer = pointer;
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("normal Queue success must not use emergency recovery");
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("normal Queue success must not resolve Mailbox");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      randomUUID: () => "late-sha-upgrade-put",
      infrastructureTimeoutMs: 1,
      sleep: () => Promise.resolve(),
      async digestSha256(value: ArrayBuffer) {
        digestCalls += 1;
        if (digestCalls === 1)
          throw new Error("simulated first SHA preparation failure");
        return new Uint8Array(
          createHash("sha256").update(new Uint8Array(value)).digest(),
        ).buffer;
      },
    },
  );

  assert.equal(rawPutAttempts, 3);
  assert.deepEqual(rawConditions, [
    { etagDoesNotMatch: "*" },
    { etagMatches: "weak-etag" },
    { etagMatches: "weak-etag" },
  ]);
  assert.equal(queuedPointer?.version, "sha-winner-version");
  assert.ok(completeTimedOutUpgrade);
  completeTimedOutUpgrade();
  await Promise.resolve();
  assert.equal(currentRaw?.version, "sha-winner-version");
  assert.equal(currentRaw?.etag, queuedPointer?.etag);
});

for (const stalledBoundary of [
  "raw_stream",
  "raw_put",
  "active_marker",
  "receipt",
  "bucket_head",
  "d1_lookup",
  "do_lookup",
  "do_write",
  "primary_queue",
  "emergency_authority",
  "provider_forward",
] as const) {
  test(`a never-resolving ${stalledBoundary} boundary still ends in a canonical ingress outcome`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const recovery = rejectionRecoveryBucket("false");
    let forwardCalls = 0;
    let rejection: string | undefined;
    let projectedId: string | undefined;
    let emergencyQueueCalls = 0;
    const raw =
      stalledBoundary === "raw_stream"
        ? {
            raw: new ReadableStream<Uint8Array>({ start() {} }),
            rawSize: 100,
          }
        : rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    const never = () => new Promise<never>(() => {});
    const rawBucket = {
      ...recovery.bucket,
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (
          stalledBoundary === "raw_put" &&
          value instanceof ArrayBuffer
        ) {
          return never();
        }
        if (
          stalledBoundary === "active_marker" &&
          isActiveMarkerKey(key)
        ) {
          return never();
        }
        if (
          stalledBoundary === "receipt" &&
          key.startsWith("receipts/")
        ) {
          return never();
        }
        if (
          stalledBoundary === "emergency_authority" &&
          key.startsWith("receipts/")
        ) {
          throw new Error("simulated receipt outage");
        }
        if (
          stalledBoundary === "emergency_authority" &&
          key.startsWith("system/emergency-forward/active/")
        ) {
          return never();
        }
        return recovery.bucket.put(key, value, options);
      },
    };

    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        async forward(recipient: string) {
          forwardCalls += 1;
          assert.equal(recipient, "verified-backup@example.com");
          if (stalledBoundary === "provider_forward") return never();
          return { messageId: `deadline-${stalledBoundary}` };
        },
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: {
          prepare(query: string) {
            assert.match(query, /FROM mailboxes/);
            return {
              bind() {
                return {
                  async first() {
                    if (stalledBoundary === "d1_lookup") return never();
                    return { id: mailboxAddress };
                  },
                };
              },
            };
          },
        },
        BUCKET: {
          async head() {
            if (
              stalledBoundary === "raw_put" ||
              stalledBoundary === "active_marker" ||
              stalledBoundary === "receipt"
            ) {
              throw new Error("force provider fallback");
            }
            if (stalledBoundary === "bucket_head") return never();
            if (stalledBoundary === "emergency_authority") return null;
            return {};
          },
          async put() {
            assert.fail("deadline recovery fixture must not write derived blobs");
          },
          async delete() {},
        },
        RAW_MAIL_BUCKET: rawBucket,
        INBOUND_QUEUE: {
          async send() {
            if (stalledBoundary === "primary_queue") return never();
            if (
              stalledBoundary === "do_lookup" ||
              stalledBoundary === "do_write" ||
              stalledBoundary === "provider_forward"
            ) {
              throw new Error("force direct projection fallback");
            }
            assert.fail(
              `${stalledBoundary} must recover before primary Queue handoff`,
            );
          },
        },
        EMERGENCY_FORWARD_QUEUE: {
          async send() {
            emergencyQueueCalls += 1;
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return {
              async getEmail() {
                if (stalledBoundary === "do_lookup") return never();
                if (stalledBoundary === "provider_forward")
                  throw new Error("force provider fallback");
                return projectedId ? { id: projectedId } : null;
              },
              async getInboundProjectionAuthority() {
                return projectedId ? { generation: 1 } : null;
              },
              async findThreadBySubject() {
                return null;
              },
              async createInboundEmail(command: { email: { id: string } }) {
                if (stalledBoundary === "do_write") return never();
                projectedId = command.email.id;
                return { status: "stored", cleanupKeys: [] };
              },
            };
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-17T10:00:00.000Z"),
        randomUUID: () => `stalled-${stalledBoundary.replaceAll("_", "-")}`,
        infrastructureTimeoutMs: 10,
        providerTimeoutMs: 1,
        sleep: () => Promise.resolve(),
        async parse() {
          return {
            headers: [],
            headerLines: [],
            from: { name: "Sender", address: "sender@example.com" },
            to: [{ name: "Mailbox", address: mailboxAddress }],
            text: "Deadline recovery",
            attachments: [],
          };
        },
      },
    );

    if (stalledBoundary === "primary_queue") {
      assert.equal(projectedId, "stalled-primary-queue");
      assert.equal(forwardCalls, 0);
    } else {
      assert.equal(forwardCalls, 1);
    }
    if (stalledBoundary === "provider_forward") {
      assert.equal(emergencyQueueCalls, 1);
    }
    assert.equal(rejection, undefined);
  });
}

for (const telemetryFailure of ["throw", "hang"] as const) {
  test(`initial telemetry ${telemetryFailure} cannot gate raw archival or Queue handoff`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const raw = rawEmail(
      `From: sender@example.com\r\nTo: ${mailboxAddress}`,
    );
    let rawArchived = false;
    let queued = false;
    await Promise.race([
      receiveEmail(
        {
          from: "sender@example.com",
          to: mailboxAddress,
          ...raw,
          setReject(reason: string) {
            assert.fail(`telemetry failure rejected durable mail: ${reason}`);
          },
        },
        {
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
              value: ArrayBuffer | string,
              options?: R2PutTestOptions,
            ) {
              if (isActiveMarkerKey(key))
                return activeMarkerObject(key, value, options);
              if (key.startsWith("receipts/")) {
                const state = JSON.parse(String(value)).state as string;
                return r2Object(
                  key,
                  String(value).length,
                  options,
                  `receipt-${state}`,
                );
              }
              rawArchived = true;
              assert.ok(value instanceof ArrayBuffer);
              return r2Object(key, value.byteLength, options);
            },
          },
          INBOUND_QUEUE: {
            async send() {
              queued = true;
            },
          },
          MAILBOX: {
            idFromName() {
              assert.fail("Queue admission must not resolve the Mailbox");
            },
          },
        },
        { waitUntil() {} },
        {
          now: () => new Date("2026-07-17T09:00:00.000Z"),
          randomUUID: () => `telemetry-${telemetryFailure}`,
          bestEffortTimeoutMs: 1,
          telemetryLogRef() {
            if (telemetryFailure === "throw")
              throw new Error("simulated telemetry failure");
            return new Promise(() => {});
          },
        },
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("telemetry blocked ingress durability")),
          100,
        ),
      ),
    ]);
    assert.equal(rawArchived, true);
    assert.equal(queued, true);
  });
}

test("inbound delivery uses direct durable projection when every active-marker write fails after raw archival", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let markerAttempts = 0;
  let sleepCalls = 0;
  let projectedId: string | undefined;
  let queued = false;
  let forwarded = false;
  let rejected = false;

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject() {
        rejected = true;
      },
    },
    {
      BRAND: "wiser",
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
        async put() {
          assert.fail("plain direct projection must not write derived objects");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            markerAttempts += 1;
            throw new Error("simulated active marker outage");
          }
          if (key.startsWith("receipts/")) {
            assert.fail("marker failure must stop before receipt admission");
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
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return projectedId ? { id: projectedId } : null;
            },
            async getInboundProjectionAuthority() {
              return projectedId ? { generation: 1 } : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              email: { id: string };
            }) {
              projectedId = command.email.id;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "active-marker-outage",
      sleep() {
        sleepCalls += 1;
        return Promise.resolve();
      },
      async parse() {
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          text: "Recovered from the authoritative raw archive.",
          attachments: [],
        };
      },
    },
  );

  assert.equal(markerAttempts, 10);
  assert.equal(sleepCalls, 9);
  assert.equal(projectedId, "active-marker-outage");
  assert.equal(queued, false);
  assert.equal(forwarded, false);
  assert.equal(rejected, false);
});

for (const authorityFailure of [
  "marker_put",
  "forward_pending_receipt_put",
  "queue_send",
] as const) {
  test(`post-archive emergency authority ${authorityFailure} failure falls through to direct provider forwarding`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const ingressId = `emergency-authority-${authorityFailure.replaceAll("_", "-")}`;
    const recovery = rejectionRecoveryBucket("false");
    let activeMarkerAttempts = 0;
    let emergencyMarkerAttempts = 0;
    let forwardPendingAttempts = 0;
    let emergencyQueueAttempts = 0;
    let forwardCalls = 0;
    let rejection: string | undefined;
    const bucket = {
      ...recovery.bucket,
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (isActiveMarkerKey(key)) {
          activeMarkerAttempts += 1;
          throw new Error("simulated active marker outage");
        }
        if (key.startsWith("system/emergency-forward/active/")) {
          emergencyMarkerAttempts += 1;
          if (authorityFailure === "marker_put")
            throw new Error("simulated emergency marker outage");
        }
        if (
          typeof value === "string" &&
          key.startsWith("receipts/") &&
          JSON.parse(value).state === "forward_pending"
        ) {
          forwardPendingAttempts += 1;
          if (authorityFailure === "forward_pending_receipt_put")
            throw new Error("simulated forward-pending receipt outage");
        }
        return recovery.bucket.put(key, value, options);
      },
    };

    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
        async forward(recipient: string) {
          forwardCalls += 1;
          assert.equal(recipient, "verified-backup@example.com");
          return { messageId: `provider-${authorityFailure}` };
        },
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            return null;
          },
        },
        RAW_MAIL_BUCKET: bucket,
        INBOUND_QUEUE: {
          async send() {
            assert.fail("active-marker failure must not reach the primary Queue");
          },
        },
        EMERGENCY_FORWARD_QUEUE: {
          async send() {
            emergencyQueueAttempts += 1;
            if (authorityFailure === "queue_send")
              throw new Error("simulated emergency Queue outage");
          },
        },
        MAILBOX: {
          idFromName() {
            assert.fail("unprovisioned direct fallback must not resolve Mailbox");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-17T10:00:00.000Z"),
        randomUUID: () => ingressId,
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(activeMarkerAttempts, 10);
    assert.equal(forwardCalls, 1);
    assert.equal(rejection, undefined);
    assert.ok(emergencyMarkerAttempts >= 1);
    assert.equal(
      forwardPendingAttempts > 0,
      authorityFailure !== "marker_put",
    );
    assert.equal(emergencyQueueAttempts, authorityFailure === "queue_send" ? 1 : 0);
  });
}

test("post-archive recovery ends in SMTP rejection when emergency authority and provider forwarding both fail", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const recovery = rejectionRecoveryBucket("false");
  let forwardCalls = 0;
  let rejection: string | undefined;
  const bucket = {
    ...recovery.bucket,
    async put(
      key: string,
      value: ArrayBuffer | string,
      options?: R2PutTestOptions,
    ) {
      if (
        isActiveMarkerKey(key) ||
        key.startsWith("system/emergency-forward/active/")
      ) {
        throw new Error("simulated recovery marker outage");
      }
      return recovery.bucket.put(key, value, options);
    },
  };

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
      async forward() {
        forwardCalls += 1;
        throw new Error("simulated provider outage");
      },
      setReject(reason: string) {
        rejection = reason;
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return null;
        },
      },
      RAW_MAIL_BUCKET: bucket,
      INBOUND_QUEUE: {
        async send() {
          assert.fail("active-marker failure must not reach the primary Queue");
        },
      },
      EMERGENCY_FORWARD_QUEUE: {
        async send() {
          assert.fail("marker failure must stop before emergency Queue send");
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("unprovisioned direct fallback must not resolve Mailbox");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-17T10:00:00.000Z"),
      randomUUID: () => "emergency-authority-provider-failure",
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(forwardCalls, 1);
  assert.match(rejection ?? "", /please resend later/i);
});

test("inbound delivery directly projects exact archived bytes when the archived receipt cannot commit", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const expectedRaw = new Uint8Array(
    await new Response(
      rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`).raw,
    ).arrayBuffer(),
  );
  let receiptAttempts = 0;
  let queued = false;
  let forwarded = false;
  let rejected = false;
  let projectedRaw: Uint8Array | undefined;
  let projection:
    | {
        folder: string;
        email: Record<string, unknown>;
        allowTerminalRecovery: boolean;
      }
    | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject() {
        rejected = true;
      },
    },
    {
      BRAND: "wiser",
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
        async put() {
          assert.fail("plain direct projection must not create derived objects");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
          if (key.startsWith("receipts/")) {
            receiptAttempts += 1;
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
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return projection?.email ?? null;
            },
            async getInboundProjectionAuthority() {
              return projection ? { generation: 1 } : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              folder: string;
              email: Record<string, unknown>;
              allowTerminalRecovery: boolean;
            }) {
              projection = command;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "admission-write-failure",
      sleep: () => Promise.resolve(),
      async parse(rawBytes: ArrayBuffer) {
        projectedRaw = new Uint8Array(rawBytes);
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          subject: "Archived receipt recovery",
          text: "Exact archived body",
          attachments: [],
        };
      },
    },
  );

  assert.equal(receiptAttempts, 10);
  assert.equal(queued, false);
  assert.equal(forwarded, false);
  assert.equal(rejected, false);
  assert.deepEqual(projectedRaw, expectedRaw);
  assert.equal(projection?.email.id, "admission-write-failure");
  assert.equal(projection?.email.date, "2026-07-13T09:30:00.000Z");
  assert.equal(projection?.folder, "inbox");
  assert.equal(projection?.allowTerminalRecovery, false);
});

for (const scenario of [
  { name: "emergency-forwards once when direct projection fails", forwardSucceeds: true },
  { name: "preserves automatic recovery when direct projection and emergency forwarding fail", forwardSucceeds: false },
]) {
  test(`inbound delivery ${scenario.name} after the archived receipt cannot commit`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    let forwardCalls = 0;
    let rejection: string | undefined;

    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        async forward(recipient: string, headers?: Headers) {
          forwardCalls += 1;
          assert.equal(recipient, "verified-backup@example.com");
          assert.equal(headers, undefined);
          if (!scenario.forwardSucceeds)
            throw new Error("simulated emergency forwarding outage");
          return { messageId: "archived-receipt-emergency-forward" };
        },
        setReject(reason: string) {
          rejection = reason;
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
        },
        RAW_MAIL_BUCKET: {
          async put(
            key: string,
            value: ArrayBuffer | string,
            options?: R2PutTestOptions,
          ) {
            if (isActiveMarkerKey(key)) {
              return activeMarkerObject(key, value, options);
            }
            if (key.startsWith("receipts/"))
              throw new Error("simulated receipt outage");
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          },
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("mail without a durable admission receipt must not enqueue");
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            throw new Error("simulated direct Mailbox outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => `archived-receipt-${scenario.forwardSucceeds}`,
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(forwardCalls, 1);
    if (scenario.forwardSucceeds) {
      assert.equal(rejection, undefined);
    } else {
      assert.match(rejection ?? "", /please resend later/i);
    }
  });
}

for (const deactivationCase of [
  {
    name: "immediately before direct projection",
    activeThroughCheck: 1,
    expectedActiveChecks: 2,
    expectedProjectionCalls: 0,
  },
  {
    name: "before a direct projection retry",
    activeThroughCheck: 2,
    expectedActiveChecks: 3,
    expectedProjectionCalls: 1,
  },
]) {
  test(`inbound delivery preserves archived recovery when a mailbox becomes inactive ${deactivationCase.name}`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    let activeChecks = 0;
    let forwardCalls = 0;
    let projectionCalls = 0;
    let queueCalls = 0;
    let rejection: string | undefined;

    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...raw,
        async forward() {
          forwardCalls += 1;
          return { messageId: "must-not-forward" };
        },
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: {
          prepare(query: string) {
            assert.match(query, /FROM mailboxes/);
            return {
              bind(mailboxId: string) {
                assert.equal(mailboxId, mailboxAddress);
                return {
                  async first() {
                    activeChecks += 1;
                    return activeChecks <= deactivationCase.activeThroughCheck
                      ? { id: mailboxId }
                      : null;
                  },
                };
              },
            };
          },
        },
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
            if (isActiveMarkerKey(key)) {
              return activeMarkerObject(key, value, options);
            }
            if (key.startsWith("receipts/"))
              throw new Error("simulated receipt outage");
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          },
        },
        INBOUND_QUEUE: {
          async send() {
            queueCalls += 1;
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
                return false;
              },
              async findThreadBySubject() {
                return null;
              },
              async createInboundEmail() {
                projectionCalls += 1;
                if (deactivationCase.expectedProjectionCalls === 1)
                  throw new Error("simulated first projection failure");
                return { status: "stored", cleanupKeys: [] };
              },
            };
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () => "direct-projection-deactivation",
        sleep: () => Promise.resolve(),
        async parse() {
          return {
            headers: [],
            headerLines: [],
            from: { name: "Sender", address: "sender@example.com" },
            to: [{ name: "Mailbox", address: mailboxAddress }],
            text: "Must not project",
            attachments: [],
          };
        },
      },
    );

    assert.equal(activeChecks, deactivationCase.expectedActiveChecks);
    assert.equal(projectionCalls, deactivationCase.expectedProjectionCalls);
    assert.equal(queueCalls, 0);
    assert.equal(forwardCalls, 1);
    assert.equal(rejection, undefined);
  });
}

test("inbound delivery emergency-forwards once when the per-attempt active recheck is unavailable", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let activeChecks = 0;
  let forwardCalls = 0;
  let projectionCalls = 0;
  let queueCalls = 0;
  let rejection: string | undefined;
  const receiptStates: string[] = [];

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward(recipient: string) {
        forwardCalls += 1;
        assert.equal(recipient, "verified-backup@example.com");
        return { messageId: "per-attempt-recheck-forward" };
      },
      setReject(reason: string) {
        rejection = reason;
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: {
        prepare(query: string) {
          assert.match(query, /FROM mailboxes/);
          return {
            bind(mailboxId: string) {
              assert.equal(mailboxId, mailboxAddress);
              return {
                async first() {
                  activeChecks += 1;
                  if (activeChecks === 3)
                    throw new Error("simulated per-attempt active lookup outage");
                  return { id: mailboxId };
                },
              };
            },
          };
        },
      },
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
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
          if (!key.startsWith("receipts/")) {
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          }
          const state = JSON.parse(String(value)).state as string;
          receiptStates.push(state);
          if (state === "admitted")
            throw new Error("simulated admitted receipt outage");
          return r2Object(key, String(value).length, options, "archived-etag");
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queueCalls += 1;
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
              return null;
            },
            async createInboundEmail() {
              projectionCalls += 1;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "per-attempt-active-recheck",
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(activeChecks, 3);
  assert.deepEqual(receiptStates, ["archived", ...Array(10).fill("admitted")]);
  assert.equal(projectionCalls, 0);
  assert.equal(queueCalls, 0);
  assert.equal(forwardCalls, 1);
  assert.equal(rejection, undefined);
});

async function assertEmergencyForwardResultPreserved(
  forwardResult: unknown,
): Promise<void> {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let forwardCalls = 0;
  let rejection: string | undefined;
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const capture = (message: string, fields?: Record<string, unknown>) => {
    logs.push({ message, fields });
  };
  console.log = capture;
  console.error = capture;
  try {
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwardCalls += 1;
        return { messageId: "valid-test-fixture" };
      },
      setReject(reason: string) {
        rejection = reason;
      },
    };
    Object.defineProperty(message, "forward", {
      value: async () => {
        forwardCalls += 1;
        return forwardResult;
      },
    });

    await receiveEmail(
      message,
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: mailboxDb(),
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
            if (isActiveMarkerKey(key)) {
              return activeMarkerObject(key, value, options);
            }
            if (key.startsWith("receipts/"))
              throw new Error("simulated receipt outage");
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          },
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("mail without a durable admission receipt must not enqueue");
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            throw new Error("simulated direct Mailbox outage");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () => "missing-forward-message-id",
        sleep: () => Promise.resolve(),
      },
    );
  } finally {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  }

  assert.equal(forwardCalls, 1);
  assert.match(rejection ?? "", /please resend later/i);
  assert.equal(
    logs.some(
      (entry) =>
        entry.fields?.operation === "emergency_forward" &&
        entry.fields?.status === "succeeded",
    ),
    false,
  );
  if (
    forwardResult &&
    typeof forwardResult === "object" &&
    "messageId" in forwardResult &&
    typeof forwardResult.messageId === "string"
  ) {
    assert.equal(
      logs.some((entry) =>
        Object.values(entry.fields ?? {}).some(
          (value) => value === forwardResult.messageId,
        ),
      ),
      false,
    );
  }
  assert.doesNotMatch(JSON.stringify(logs), /provider-message-id-poison/);
}

test("inbound delivery preserves archived recovery when emergency forwarding resolves without a message ID", async () => {
  await assertEmergencyForwardResultPreserved({});
});

test("inbound delivery preserves archived recovery when emergency forwarding resolves with a non-string message ID", async () => {
  await assertEmergencyForwardResultPreserved({
    messageId: { privatePayload: "provider-message-id-poison" },
  });
});

test("inbound delivery preserves archived recovery when emergency forwarding resolves with a whitespace-only message ID", async () => {
  await assertEmergencyForwardResultPreserved({ messageId: " \t\n" });
});

test("inbound delivery keeps a successful Queue handoff when enqueued receipt advancement loses CAS", async () => {
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
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
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
      async forward() {
        assert.fail("successful Queue handoff must not emergency-forward");
      },
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

test("inbound delivery directly projects when the admitted receipt cannot commit", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const receiptStates: string[] = [];
  let queued = false;
  let forwarded = false;
  let rejected = false;
  let projectedId: unknown;

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject() {
        rejected = true;
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
        async put() {
          assert.fail("plain direct projection must not create derived objects");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
          if (!key.startsWith("receipts/")) {
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          }
          const state: unknown = JSON.parse(String(value)).state;
          assert.equal(typeof state, "string");
          receiptStates.push(state);
          if (state === "archived")
            return r2Object(
              key,
              String(value).length,
              options,
              "archived-receipt-etag",
            );
          throw new Error("simulated admitted receipt outage");
        },
      },
      INBOUND_QUEUE: {
        async send() {
          queued = true;
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return projectedId ? {} : null;
            },
            async getInboundProjectionAuthority() {
              return projectedId ? { generation: 1 } : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              email: Record<string, unknown>;
            }) {
              projectedId = command.email.id;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "admitted-receipt-failure",
      sleep: () => Promise.resolve(),
      async parse() {
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          text: "Recovered admitted body",
          attachments: [],
        };
      },
    },
  );

  assert.equal(receiptStates[0], "archived");
  assert.equal(receiptStates.filter((state) => state === "admitted").length, 10);
  assert.equal(queued, false);
  assert.equal(forwarded, false);
  assert.equal(rejected, false);
  assert.equal(projectedId, "admitted-receipt-failure");
});

test("a bare legacy tombstone after admitted-receipt CAS loss cannot suppress emergency forwarding", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let receiptState = "missing";
  let forwardCalls = 0;

  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwardCalls += 1;
        return { messageId: "legacy-tombstone-recovery-forward" };
      },
      setReject(reason: string) {
        assert.fail(`a terminal Mailbox winner must not reject: ${reason}`);
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
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
          if (!key.startsWith("receipts/")) {
            assert.ok(value instanceof ArrayBuffer);
            return r2Object(key, value.byteLength, options);
          }
          const nextState: unknown = JSON.parse(String(value)).state;
          if (nextState === "archived") {
            receiptState = "archived";
            return r2Object(
              key,
              String(value).length,
              options,
              "archived-receipt-etag",
            );
          }
          assert.equal(nextState, "admitted");
          assert.equal(options?.onlyIf?.etagMatches, "archived-receipt-etag");
          receiptState = "deleted";
          return null;
        },
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("an admitted receipt CAS loser must not enqueue");
        },
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
              assert.fail("deletion truth must be checked before projection lookup");
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "admitted-receipt-cas-loss",
    },
  );

  assert.equal(receiptState, "deleted");
  assert.equal(forwardCalls, 1);
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
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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

test("checksum failure preserves raw in R2 then directly forwards without SHA-less recovery authority", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let digestAttempts = 0;
  let rawPuts = 0;
  let forwardedTo: string | undefined;
  let rejection: string | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        rejection = reason;
      },
      async forward(recipient: string) {
        forwardedTo = recipient;
        return { messageId: "provider-accepted-preserved-raw" };
      },
    },
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: {
        prepare() {
          assert.fail("SHA-less preservation must not run D1 admission");
        },
      },
      BUCKET: {
        async head() {
          assert.fail("SHA-less preservation must not run mailbox admission");
        },
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          rawPuts += 1;
          assert.match(key, /^raw\//);
          assert.ok(value instanceof ArrayBuffer);
          assert.equal(options?.sha256, undefined);
          assert.equal(options?.customMetadata?.rawSha256, undefined);
          return {
            ...r2Object(key, value.byteLength, options),
            checksums: { md5: new ArrayBuffer(16) },
          };
        },
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("SHA-less pointer must not reach the normal Queue");
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("SHA-less preservation must not resolve a Mailbox");
        },
        get() {
          assert.fail("SHA-less preservation must not resolve a Mailbox");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "digest-failure-preserved",
      async digestSha256() {
        digestAttempts += 1;
        throw new Error("simulated WebCrypto failure");
      },
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(rawPuts, 1);
  assert.equal(digestAttempts, 3);
  assert.equal(forwardedTo, "verified-backup@example.com");
  assert.equal(rejection, undefined);
});

test("checksum preparation retry rewrites the preservation archive with exact SHA authority", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const digest = Uint8Array.from(
    createHash("sha256")
      .update(
        new TextEncoder().encode(
          `From: sender@example.com\r\nTo: ${mailboxAddress}\r\n\r\nHello from the Internet.`,
        ),
      )
      .digest(),
  ).buffer;
  let digestAttempts = 0;
  const rawWrites: Array<{ hasSha: boolean; metadataSha?: string }> = [];
  let queued: InboundArchivePointer | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`exact rewrite must not reject: ${reason}`);
      },
      async forward() {
        assert.fail("exact rewrite must continue through normal Queue handoff");
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
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (key.startsWith("raw/")) {
            assert.ok(value instanceof ArrayBuffer);
            rawWrites.push({
              hasSha: options?.sha256 instanceof ArrayBuffer,
              metadataSha: options?.customMetadata?.rawSha256,
            });
            return options?.sha256 instanceof ArrayBuffer
              ? r2Object(key, value.byteLength, options)
              : {
                  ...r2Object(key, value.byteLength, options),
                  checksums: { md5: new ArrayBuffer(16) },
                };
          }
          if (isActiveMarkerKey(key))
            return activeMarkerObject(key, value, options);
          return r2Object(key, String(value).length, options);
        },
      },
      INBOUND_QUEUE: {
        async send(value: InboundArchivePointer) {
          queued = value;
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          throw new Error("normal Queue handoff must precede projection");
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "digest-retry-rewrite",
      async digestSha256() {
        digestAttempts += 1;
        if (digestAttempts === 1)
          throw new Error("simulated transient WebCrypto failure");
        return digest;
      },
      sleep: () => Promise.resolve(),
    },
  );

  assert.deepEqual(rawWrites, [
    { hasSha: false, metadataSha: undefined },
    {
      hasSha: true,
      metadataSha: Buffer.from(digest).toString("hex"),
    },
  ]);
  assert.equal(digestAttempts, 2);
  assert.equal(queued?.rawSha256, Buffer.from(digest).toString("hex"));
});

test("failed exact-SHA rewrite falls back to exact direct authority before forwarding", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const digest = Uint8Array.from(
    createHash("sha256")
      .update(
        new TextEncoder().encode(
          `From: sender@example.com\r\nTo: ${mailboxAddress}\r\n\r\nHello from the Internet.`,
        ),
      )
      .digest(),
  ).buffer;
  let digestAttempts = 0;
  let preservationWrites = 0;
  let exactRewriteAttempts = 0;
  let forwardCalls = 0;
  let directCalls = 0;
  let storedEmail: Record<string, unknown> | undefined;
  let storedAuthority: Record<string, unknown> | undefined;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`preserved raw direct-forward must not reject: ${reason}`);
      },
      async forward(recipient: string) {
        forwardCalls += 1;
        assert.equal(recipient, "verified-backup@example.com");
        return { messageId: "provider-accepted-after-rewrite-outage" };
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
        async put() {
          assert.fail("plain direct fallback must not upload derived content");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          assert.match(key, /^raw\//);
          assert.ok(value instanceof ArrayBuffer);
          if (options?.sha256 instanceof ArrayBuffer) {
            exactRewriteAttempts += 1;
            throw new Error("simulated exact SHA rewrite outage");
          }
          preservationWrites += 1;
          return {
            ...r2Object(key, value.byteLength, options),
            checksums: { md5: new ArrayBuffer(16) },
          };
        },
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("failed exact rewrite must not enqueue a pointer");
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return storedEmail ?? null;
            },
            async findThreadBySubject() {
              return null;
            },
            async getDirectInboundProjectionAuthority(
              authority: Record<string, unknown>,
            ) {
              return storedAuthority &&
                JSON.stringify(authority) === JSON.stringify(storedAuthority)
                ? { generation: 1 }
                : null;
            },
            async getDirectInboundDeletionAuthority() {
              return null;
            },
            async createDirectInboundEmail(command: {
              email: Record<string, unknown>;
              directAuthority: Record<string, unknown>;
            }) {
              directCalls += 1;
              assert.equal(
                command.directAuthority.rawSha256,
                Buffer.from(digest).toString("hex"),
              );
              storedEmail = command.email;
              storedAuthority = command.directAuthority;
              return { status: "stored" as const, cleanupKeys: [] };
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "digest-rewrite-outage",
      async digestSha256() {
        digestAttempts += 1;
        if (digestAttempts === 1)
          throw new Error("simulated initial WebCrypto failure");
        return digest;
      },
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(digestAttempts, 2);
  assert.equal(preservationWrites, 1);
  assert.equal(exactRewriteAttempts, 10);
  assert.equal(directCalls, 1);
  assert.equal(forwardCalls, 0);
});

test("exact SHA authority stores directly when raw preservation fails", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  const expectedRawSha256 = createHash("sha256")
    .update(
      `From: sender@example.com\r\nTo: ${mailboxAddress}\r\n\r\nHello from the Internet.`,
    )
    .digest("hex");
  let rawPutAttempts = 0;
  let storedEmail: Record<string, unknown> | undefined;
  let storedAuthority: Record<string, unknown> | undefined;
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
            rawPutAttempts += 1;
            throw new Error("simulated R2 preservation outage");
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
              async getDirectInboundProjectionAuthority(
                authority: Record<string, unknown>,
              ) {
                return storedAuthority &&
                  JSON.stringify(authority) === JSON.stringify(storedAuthority)
                  ? { generation: 1 }
                  : null;
              },
              async getDirectInboundDeletionAuthority() {
                return null;
              },
              async createDirectInboundEmail(command: {
                folder: string;
                email: Record<string, unknown>;
                allowTerminalRecovery: boolean;
                projectionExpiresAt?: number;
                directAuthority: Record<string, unknown>;
              }) {
                assert.equal(command.folder, "inbox");
                assert.equal(command.allowTerminalRecovery, false);
                assert.ok(
                  Number.isSafeInteger(command.projectionExpiresAt) &&
                    command.projectionExpiresAt! > Date.now(),
                );
                assert.deepEqual(command.directAuthority, {
                  schemaVersion: 1,
                  ingressId: "digest-failure",
                  mailboxId: mailboxAddress,
                  rawSize: raw.rawSize,
                  rawSha256: expectedRawSha256,
                  receivedAt: "2026-07-13T09:30:00.000Z",
                });
                storedEmail = command.email;
                storedAuthority = command.directAuthority;
                return { status: "stored" as const, cleanupKeys: [] };
              },
              async createInboundEmail() {
                assert.fail("direct fallback must not use archive authority");
              },
            };
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "digest-failure",
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(rawPutAttempts, 10);
    assert.equal(forwarded, false);
    assert.equal(storedEmail?.id, "digest-failure");
    assert.equal(storedAuthority?.rawSha256, expectedRawSha256);
    assert.equal(
      errors.some(
        (entry) =>
          entry.fields?.errorCode ===
          "RAW_ARCHIVE_CHECKSUM_PREPARATION_FAILED",
      ),
      false,
    );
  } finally {
    console.error = originalConsoleError;
  }
});

test("ambiguous direct commit is accepted only after the exact authority getter proves it", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let storedEmail: { id: string } | undefined;
  let storedAuthority: Record<string, unknown> | undefined;
  let createCalls = 0;
  let forwardCalls = 0;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`proven ambiguous commit must not reject: ${reason}`);
      },
      async forward() {
        forwardCalls += 1;
        return { messageId: "must-not-forward" };
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
        async put() {
          assert.fail("plain direct projection must not upload derived content");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put() {
          throw new Error("simulated raw archive outage");
        },
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return storedEmail ?? null;
            },
            async getDirectInboundProjectionAuthority(
              authority: Record<string, unknown>,
            ) {
              return storedAuthority &&
                JSON.stringify(authority) === JSON.stringify(storedAuthority)
                ? { generation: 1 }
                : null;
            },
            async getDirectInboundDeletionAuthority() {
              return null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createDirectInboundEmail(command: {
              email: { id: string };
              directAuthority: Record<string, unknown>;
            }) {
              createCalls += 1;
              storedEmail = command.email;
              storedAuthority = command.directAuthority;
              throw new Error("simulated response loss after commit");
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "direct-ambiguous",
      sleep: () => Promise.resolve(),
      async parse() {
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          text: "Committed before response loss.",
          attachments: [],
        };
      },
    },
  );

  assert.equal(createCalls, 1);
  assert.equal(storedEmail?.id, "direct-ambiguous");
  assert.equal(forwardCalls, 0);
});

test("a direct commit-delete-lost-response race never provider-forwards after exact deletion authority appears", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let deletedAuthority: Record<string, unknown> | undefined;
  let forwardCalls = 0;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`exact deletion must remain terminal: ${reason}`);
      },
      async forward() {
        forwardCalls += 1;
        return { messageId: "must-not-forward-deleted-direct" };
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
        async put() {
          assert.fail("plain direct projection must not upload derived content");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put() {
          throw new Error("simulated raw archive outage");
        },
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return null;
            },
            async getDirectInboundProjectionAuthority() {
              return null;
            },
            async getDirectInboundDeletionAuthority(
              authority: Record<string, unknown>,
            ) {
              return deletedAuthority &&
                JSON.stringify(authority) === JSON.stringify(deletedAuthority)
                ? {
                    generation: 2,
                    deletedAt: "2026-07-13T09:30:01.000Z",
                  }
                : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createDirectInboundEmail(command: {
              directAuthority: Record<string, unknown>;
            }) {
              deletedAuthority = command.directAuthority;
              throw new Error(
                "simulated response loss after direct commit and delete",
              );
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "direct-delete-lost-response",
      sleep: () => Promise.resolve(),
      async parse() {
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          text: "Deleted before response loss.",
          attachments: [],
        };
      },
    },
  );

  assert.ok(deletedAuthority);
  assert.equal(forwardCalls, 0);
});

test("unrelated direct identity collision falls through to provider forwarding", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let forwardCalls = 0;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      setReject(reason: string) {
        assert.fail(`provider recovery must not reject: ${reason}`);
      },
      async forward(recipient: string) {
        forwardCalls += 1;
        assert.equal(recipient, "verified-backup@example.com");
        return { messageId: "provider-after-direct-identity-conflict" };
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
      },
      RAW_MAIL_BUCKET: {
        async put() {
          throw new Error("simulated raw archive outage");
        },
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return { id: "direct-foreign-collision" };
            },
            async getDirectInboundProjectionAuthority() {
              return null;
            },
            async getDirectInboundDeletionAuthority() {
              return null;
            },
            async createDirectInboundEmail() {
              assert.fail("an unrelated existing email must not be overwritten");
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "direct-foreign-collision",
      sleep: () => Promise.resolve(),
    },
  );

  assert.equal(forwardCalls, 1);
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
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

test("inbound delivery directly projects when Queue enqueue fails", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const archivedKeys: string[] = [];
  const receiptStates: string[] = [];
  let queueCalls = 0;
  let forwarded = false;
  let rejected = false;
  let projectedId: unknown;
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> =
    [];
  const originalConsoleError = console.error;
  console.error = (message: string, fields?: Record<string, unknown>) => {
    errors.push({ message, fields });
  };
  try {
    const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          return {};
        },
        async put() {
          assert.fail("plain direct projection must not create derived objects");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ReadableStream | ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
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
          queueCalls += 1;
          throw new Error("simulated Queue outage");
        },
      },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return projectedId ? {} : null;
            },
            async getInboundProjectionAuthority() {
              return projectedId ? { generation: 1 } : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              email: Record<string, unknown>;
            }) {
              projectedId = command.email.id;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject() {
        rejected = true;
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "queue-failure",
        async parse() {
          return {
            headers: [],
            headerLines: [],
            from: { name: "Sender", address: "sender@example.com" },
            to: [{ name: "Mailbox", address: mailboxAddress }],
            text: "Queue failure recovery",
            attachments: [],
          };
        },
      },
    );

    assert.deepEqual(archivedKeys, [
      "raw/2026/07/13/09/30/queue-failure.eml",
    ]);
    assert.deepEqual(receiptStates, ["archived", "admitted"]);
    assert.equal(queueCalls, 1);
    assert.equal(projectedId, "queue-failure");
    assert.equal(forwarded, false);
    assert.equal(rejected, false);
    assert.equal(errors[0]?.message, "[mail-ingress] boundary failed");
    assert.equal(errors[0]?.fields?.errorCode, "QUEUE_ENQUEUE_FAILED");
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

test("an archive-backed commit-delete-lost-response race never provider-forwards after exact deletion authority appears", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let deletedAuthority: Record<string, unknown> | undefined;
  let forwardCalls = 0;
  await receiveEmail(
    {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwardCalls += 1;
        return { messageId: "must-not-forward-deleted-archive" };
      },
      setReject(reason: string) {
        assert.fail(`exact archive deletion must remain terminal: ${reason}`);
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
        async put() {
          assert.fail("plain archive projection must not upload derived content");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async put(
          key: string,
          value: ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (typeof value === "string") {
            return r2Object(key, value.length, options, `${key}-etag`);
          }
          return r2Object(key, value.byteLength, options);
        },
      },
      INBOUND_QUEUE: {
        async send() {
          throw new Error("simulated Queue outage");
        },
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
            async getInboundProjectionAuthority() {
              return null;
            },
            async getInboundDeletionAuthority(
              authority: Record<string, unknown>,
            ) {
              return deletedAuthority &&
                JSON.stringify(authority) === JSON.stringify(deletedAuthority)
                ? {
                    generation: 2,
                    deletedAt: "2026-07-13T09:30:01.000Z",
                  }
                : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              archiveAuthority: Record<string, unknown>;
            }) {
              deletedAuthority = command.archiveAuthority;
              throw new Error(
                "simulated response loss after archive commit and delete",
              );
            },
          };
        },
      },
    },
    { waitUntil() {} },
    {
      now: () => new Date("2026-07-13T09:30:00.000Z"),
      randomUUID: () => "archive-delete-lost-response",
      sleep: () => Promise.resolve(),
      async parse() {
        return {
          headers: [],
          headerLines: [],
          from: { name: "Sender", address: "sender@example.com" },
          to: [{ name: "Mailbox", address: mailboxAddress }],
          text: "Deleted before archive response loss.",
          attachments: [],
        };
      },
    },
  );

  assert.ok(deletedAuthority);
  assert.equal(forwardCalls, 0);
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

test("inbound delivery directly projects archived mail when the mailbox marker lookup transiently fails", async () => {
  const mailboxAddress = "hello@wiserchat.ai";
  const raw = rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`);
  let rawArchived = false;
  let markerChecks = 0;
  let queued = false;
  let forwarded = false;
  let rejected = false;
  let projectedId: unknown;
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
      EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
      DB: mailboxDb(),
      BUCKET: {
        async head() {
          markerChecks += 1;
          if (markerChecks === 1)
            throw new Error("simulated mailbox marker outage");
          return {};
        },
        async put() {
          assert.fail("plain direct projection must not create derived objects");
        },
        async delete() {},
      },
      RAW_MAIL_BUCKET: {
        async put(
          key: string,
          value: ReadableStream | ArrayBuffer | string,
          options?: R2PutTestOptions,
        ) {
          if (isActiveMarkerKey(key)) {
            return activeMarkerObject(key, value, options);
          }
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
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return {
            async getEmail() {
              return projectedId ? {} : null;
            },
            async getInboundProjectionAuthority() {
              return projectedId ? { generation: 1 } : null;
            },
            async findThreadBySubject() {
              return null;
            },
            async createInboundEmail(command: {
              email: Record<string, unknown>;
            }) {
              projectedId = command.email.id;
              return { status: "stored", cleanupKeys: [] };
            },
          };
        },
      },
    };
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...raw,
      async forward() {
        forwarded = true;
        return { messageId: "must-not-forward" };
      },
      setReject() {
        rejected = true;
      },
    };

    await receiveEmail(
      message,
      env,
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-13T09:30:00.000Z"),
        randomUUID: () => "admission-lookup-outage",
        async parse() {
          return {
            headers: [],
            headerLines: [],
            from: { name: "Sender", address: "sender@example.com" },
            to: [{ name: "Mailbox", address: mailboxAddress }],
            text: "Recovered body",
            attachments: [],
          };
        },
      },
    );

    assert.equal(rawArchived, true);
    assert.equal(markerChecks, 2);
    assert.equal(queued, false);
    assert.equal(forwarded, false);
    assert.equal(rejected, false);
    assert.equal(projectedId, "admission-lookup-outage");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].fields?.errorCode, "MAILBOX_ADMISSION_CHECK_FAILED");
    assert.equal(errors[0].fields?.status, "degraded");
  } finally {
    console.error = originalConsoleError;
  }
});

const d1AdmissionCases: Array<{
  name: string;
  dbState: "inactive" | "unavailable";
  expectedReceipts: string[];
  expectedRejection: boolean;
  expectedForward: boolean;
}> = [
  {
    name: "rejects an archived delivery when D1 says the mailbox is inactive",
    dbState: "inactive",
    expectedReceipts: ["archived", "rejected"],
    expectedRejection: true,
    expectedForward: false,
  },
  {
    name: "emergency-forwards an archived delivery when the D1 active lookup remains unavailable",
    dbState: "unavailable",
    expectedReceipts: ["archived"],
    expectedRejection: false,
    expectedForward: true,
  },
];

for (const testCase of d1AdmissionCases) {
  test(`inbound delivery ${testCase.name}`, async () => {
    const mailboxAddress = "hello@wiserchat.ai";
    const receiptStates: string[] = [];
    const receiptBodies = new Map<string, string>();
    let forwarded = false;
    let projected = false;
    let rejection: string | undefined;
    const message = {
      from: "sender@example.com",
      to: mailboxAddress,
      ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
      async forward(recipient: string) {
        forwarded = true;
        assert.equal(recipient, "verified-backup@example.com");
        return { messageId: "d1-admission-emergency-forward" };
      },
      setReject(reason: string) {
        rejection = reason;
      },
    };

    await receiveEmail(
      message,
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: mailboxDb(testCase.dbState),
        BUCKET: {
          async head() {
            return {};
          },
        },
        RAW_MAIL_BUCKET: {
          async get(key: string) {
            const value = receiptBodies.get(key);
            return value ? r2TextObject(key, value, `receipt-${JSON.parse(value).state}`) : null;
          },
          async put(
            key: string,
            value: ArrayBuffer | string,
            options?: R2PutTestOptions,
          ) {
            if (isActiveMarkerKey(key)) {
              return activeMarkerObject(key, value, options);
            }
            if (key.startsWith("receipts/")) {
              const state = JSON.parse(String(value)).state as string;
              receiptStates.push(state);
              receiptBodies.set(key, String(value));
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
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return {
              async getInboundDeletionAuthority() {
                return null;
              },
              async getDirectInboundDeletionAuthority() {
                return null;
              },
              async createInboundEmail() {
                projected = true;
                assert.fail("unverified recipients must not reach projection");
              },
              async createDirectInboundEmail() {
                projected = true;
                assert.fail("unverified recipients must not reach projection");
              },
            };
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
    assert.equal(forwarded, testCase.expectedForward);
    assert.equal(projected, false);
  });
}

test("inbound delivery archives before permanently rejecting an unprovisioned envelope recipient", async () => {
  let rawWasRead = false;
  let rawWasArchived = false;
  let rejection: string | undefined;
  const receiptBodies = new Map<string, string>();
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
      async get(key: string) {
        const value = receiptBodies.get(key);
        return value ? r2TextObject(key, value) : null;
      },
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (isActiveMarkerKey(key)) {
          return activeMarkerObject(key, value, options);
        }
        if (key.startsWith("receipts/")) receiptBodies.set(key, String(value));
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

for (const recipientCase of [
  {
    name: "statically invalid",
    mailboxAddress: "blocked@wiserchat.ai",
    allowedAddresses: ["hello@wiserchat.ai"],
    mailboxProvisioned: true,
    mailboxState: "active",
  },
  {
    name: "unprovisioned",
    mailboxAddress: "missing@wiserchat.ai",
    allowedAddresses: [],
    mailboxProvisioned: false,
    mailboxState: "active",
  },
  {
    name: "inactive",
    mailboxAddress: "inactive@wiserchat.ai",
    allowedAddresses: [],
    mailboxProvisioned: true,
    mailboxState: "inactive",
  },
]) {
  test(`inbound delivery preserves automatic recovery for a proven ${recipientCase.name} recipient when rejection receipt persistence fails`, async () => {
    const receiptStates: string[] = [];
    let forwarded = false;
    let projected = false;
    let rejection: string | undefined;
    const raw = rawEmail(
      `From: sender@example.com\r\nTo: ${recipientCase.mailboxAddress}`,
    );

    await receiveEmail(
      {
        from: "sender@example.com",
        to: recipientCase.mailboxAddress,
        ...raw,
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
        EMAIL_ADDRESSES: recipientCase.allowedAddresses,
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: mailboxDb(
          recipientCase.mailboxState === "inactive" ? "inactive" : "active",
        ),
        BUCKET: {
          async head() {
            if (recipientCase.name === "statically invalid")
              assert.fail("statically invalid recipients must not reach Mailbox markers");
            return recipientCase.mailboxProvisioned ? {} : null;
          },
        },
        RAW_MAIL_BUCKET: {
          async put(
            key: string,
            value: ArrayBuffer | string,
            options?: R2PutTestOptions,
          ) {
            if (isActiveMarkerKey(key)) {
              return activeMarkerObject(key, value, options);
            }
            if (!key.startsWith("receipts/")) {
              assert.ok(value instanceof ArrayBuffer);
              return r2Object(key, value.byteLength, options);
            }
            const state: unknown = JSON.parse(String(value)).state;
            assert.equal(typeof state, "string");
            receiptStates.push(state);
            if (state === "archived")
              return r2Object(
                key,
                String(value).length,
                options,
                "archived-etag",
              );
            throw new Error("simulated rejected receipt outage");
          },
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("rejected recipients must not enqueue");
          },
        },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            projected = true;
            throw new Error("rejected recipients must not reach Mailbox projection");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () =>
          `rejection-receipt-${recipientCase.name.replaceAll(" ", "-")}`,
        sleep: () => Promise.resolve(),
      },
    );

    assert.equal(receiptStates[0], "archived");
    assert.equal(receiptStates.filter((state) => state === "rejected").length, 10);
    assert.match(rejection ?? "", /mailbox unavailable/i);
    assert.equal(forwarded, false);
    assert.equal(projected, false);
  });
}

for (const receiptFailure of [
  "throw",
  "false",
  "concurrent_winner",
] as const) {
  test(`post-rejection receipt failure ${receiptFailure} retains recovery authority without a false terminal receipt`, async () => {
    const mailboxAddress = "blocked@wiserchat.ai";
    const recovery = rejectionRecoveryBucket(receiptFailure);
    const emergencyQueue: unknown[] = [];
    const ingressId = `rejection-${receiptFailure.replaceAll("_", "-")}`;
    let rejection: string | undefined;
    let rejectedReceiptAttempts = 0;
    const orderedBucket = {
      ...recovery.bucket,
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (
          typeof value === "string" &&
          key.startsWith("receipts/") &&
          JSON.parse(value).state === "rejected"
        ) {
          rejectedReceiptAttempts += 1;
          assert.match(
            rejection ?? "",
            /mailbox unavailable/i,
            "setReject must be requested before terminal receipt persistence",
          );
        }
        return recovery.bucket.put(key, value, options);
      },
    };
    await receiveEmail(
      {
        from: "sender@example.com",
        to: mailboxAddress,
        ...rawEmail(`From: sender@example.com\r\nTo: ${mailboxAddress}`),
        setReject(reason: string) {
          rejection = reason;
        },
      },
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: ["hello@wiserchat.ai"],
        EMERGENCY_FORWARD_DESTINATION: "verified-backup@example.com",
        DB: mailboxDb(),
        BUCKET: {
          async head() {
            assert.fail("static rejection must not read a mailbox marker");
          },
        },
        RAW_MAIL_BUCKET: orderedBucket,
        INBOUND_QUEUE: {
          async send() {
            assert.fail("unproven rejection must not reach the primary Queue");
          },
        },
        EMERGENCY_FORWARD_QUEUE: {
          async send(value: unknown) {
            emergencyQueue.push(value);
          },
        },
        MAILBOX: {
          idFromName() {
            assert.fail("static rejection must not resolve the Mailbox");
          },
        },
      },
      { waitUntil() {} },
      {
        now: () => new Date("2026-07-17T10:00:00.000Z"),
        randomUUID: () => ingressId,
        sleep: () => Promise.resolve(),
      },
    );
    const receipt = recovery.sidecars.get(
      `receipts/${ingressId}.json`,
    );
    assert.match(rejection ?? "", /mailbox unavailable/i);
    assert.ok(rejectedReceiptAttempts >= 1);
    assert.notEqual(JSON.parse(receipt?.value ?? "null").state, "rejected");
    assert.equal(
      [...recovery.sidecars.keys()].some((key) =>
        key.startsWith("system/inbound-active/"),
      ),
      true,
    );
    assert.ok(emergencyQueue.length <= 1);
  });
}

test("inbound delivery rejects an envelope recipient outside EMAIL_ADDRESSES", async () => {
  let rejection: string | undefined;
  let mailboxWasChecked = false;
  let rawWasArchived = false;
  let activeMarkerKey: string | undefined;
  let deletedMarkerKey: string | undefined;
  let rejectedReceiptWrittenAfterSetReject = false;
  const receiptBodies = new Map<string, string>();
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
      async get(key: string) {
        const value = receiptBodies.get(key);
        return value ? r2TextObject(key, value) : null;
      },
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (isActiveMarkerKey(key)) {
          activeMarkerKey = key;
          return activeMarkerObject(key, value, options);
        }
        if (key.startsWith("receipts/")) {
          const receipt = JSON.parse(String(value)) as Record<string, unknown>;
          if (receipt.state === "rejected") {
            assert.match(
              rejection ?? "",
              /mailbox unavailable/i,
              "terminal receipt must be written only after setReject",
            );
            rejectedReceiptWrittenAfterSetReject = true;
          }
          receiptBodies.set(key, String(value));
        }
        if (!key.startsWith("receipts/")) rawWasArchived = true;
        return r2Object(
          key,
          typeof value === "string" ? value.length : value.byteLength,
          options,
        );
      },
      async delete(key: string) {
        deletedMarkerKey = key;
      },
    },
    INBOUND_QUEUE: { async send() {} },
  };

  await receiveEmail(message, env, { waitUntil() {} });

  assert.match(rejection ?? "", /mailbox unavailable/i);
  assert.equal(mailboxWasChecked, false);
  assert.equal(rawWasArchived, true);
  assert.equal(rejectedReceiptWrittenAfterSetReject, true);
  assert.equal(deletedMarkerKey, activeMarkerKey);
});

test("inbound delivery archives recipients outside configured mail domains before rejection", async () => {
  let mailboxWasChecked = false;
  let rawWasArchived = false;
  let rejection: string | undefined;
  const receiptBodies = new Map<string, string>();
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
      async get(key: string) {
        const value = receiptBodies.get(key);
        return value ? r2TextObject(key, value) : null;
      },
      async put(
        key: string,
        value: ArrayBuffer | string,
        options?: R2PutTestOptions,
      ) {
        if (isActiveMarkerKey(key)) {
          return activeMarkerObject(key, value, options);
        }
        if (key.startsWith("receipts/")) receiptBodies.set(key, String(value));
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
