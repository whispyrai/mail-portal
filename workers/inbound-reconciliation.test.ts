import assert from "node:assert/strict";
import test from "node:test";
import type { InboundArchivePointer } from "./inbound-email.ts";
import { reconcileInboundArchives } from "./inbound-reconciliation.ts";

test("reconciliation preserves but never enqueues raw mail without a durable admission decision", async () => {
  const rawKey = "raw/2026/07/13/reconcile-missing-receipt.eml";
  const queued: InboundArchivePointer[] = [];
  let receipt: Record<string, unknown> | undefined;
  let sweepCursor: Record<string, unknown> | undefined;
  let anomaly: Record<string, unknown> | undefined;
  let recoveryPointer: Record<string, unknown> | undefined;
  const env = {
    RAW_MAIL_BUCKET: {
      async list(options: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) {
        assert.deepEqual(options, { prefix: "raw/", limit: 100 });
        return {
          objects: [{ key: rawKey }],
          truncated: false,
        };
      },
      async head(key: string) {
        assert.equal(key, rawKey);
        return {
          key: rawKey,
          size: 321,
          etag: "archive-etag",
          version: "archive-version",
          customMetadata: {
            archivedAt: "2026-07-13T09:30:00.000Z",
            ingressId: "reconcile-missing-receipt",
            mailboxId: "hello@wiserchat.ai",
            rawSize: "321",
            rawSha256: "a".repeat(64),
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        assert.equal(key, "receipts/reconcile-missing-receipt.json");
        return null;
      },
      async put(key: string, value: string) {
        if (key === "system/reconciliation-cursor.json") {
          sweepCursor = JSON.parse(value);
          return {};
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          anomaly = JSON.parse(value);
          return {};
        }
        if (key.startsWith("system/inbound-recovery-pointers/")) {
          recoveryPointer = JSON.parse(value);
          return {};
        }
        assert.equal(key, "receipts/reconcile-missing-receipt.json");
        receipt = JSON.parse(value);
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send(pointer: InboundArchivePointer) {
        queued.push(pointer);
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
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.deepEqual(result, {
    scanned: 1,
    reenqueued: 0,
    skipped: 1,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    terminalized: 0,
    failureLedgered: 0,
  });
  assert.deepEqual(queued, []);
  assert.equal(receipt, undefined);
  assert.equal(anomaly?.errorCode, "ADMISSION_DECISION_MISSING");
  assert.equal(anomaly?.status, "pending_operator_review");
  assert.equal(recoveryPointer?.ingressId, "reconcile-missing-receipt");
  assert.equal(recoveryPointer?.rawSha256, "a".repeat(64));
  assert.equal(sweepCursor?.cursor, null);
});

test("reconciliation skips terminal and dead-letter handoffs while repairing stale and archived states", async () => {
  const ingressIds = [
    "stored",
    "recent",
    "stale",
    "archived",
    "admitted",
    "dead-letter-recent",
    "dead-letter-stale",
    "invalid",
  ];
  const rawKeys = ingressIds.map((id) => `raw/2026/07/13/${id}.eml`);
  const states: Record<
    string,
    { state: string; updatedAt: string; errorCode?: string }
  > = {
    stored: { state: "stored", updatedAt: "2026-07-13T09:00:00.000Z" },
    recent: { state: "enqueued", updatedAt: "2026-07-13T09:55:00.000Z" },
    stale: { state: "enqueued", updatedAt: "2026-07-13T09:30:00.000Z" },
    archived: { state: "archived", updatedAt: "2026-07-13T09:59:00.000Z" },
    admitted: { state: "admitted", updatedAt: "2026-07-13T09:59:00.000Z" },
    "dead-letter-recent": {
      state: "dead_letter_pending",
      updatedAt: "2026-07-13T09:55:00.000Z",
    },
    "dead-letter-stale": {
      state: "dead_letter_pending",
      updatedAt: "2026-07-13T09:30:00.000Z",
    },
  };
  const queued: string[] = [];
  const receiptConditions: Record<string, string | undefined> = {};
  const env = {
    RAW_MAIL_BUCKET: {
      async list() {
        return {
          objects: rawKeys.map((key) => ({ key })),
          truncated: false,
        };
      },
      async head(key: string) {
        const ingressId = key.slice(key.lastIndexOf("/") + 1, -4);
        return {
          key,
          size: 123,
          etag: "archive-etag",
          version: "archive-version",
          customMetadata:
            ingressId === "invalid"
              ? {}
              : {
                  archivedAt: "2026-07-13T09:00:00.000Z",
                  ingressId,
                  mailboxId: "hello@wiserchat.ai",
                  rawSize: "123",
                  schemaVersion: "1",
                },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        const ingressId = key.slice("receipts/".length, -".json".length);
        const receipt = states[ingressId];
        return receipt
          ? {
              etag: `${ingressId}-receipt-etag`,
              async text() {
                return JSON.stringify(receipt);
              },
            }
          : null;
      },
      async put(
        key: string,
        value: string,
        options?: { onlyIf?: { etagMatches?: string } },
      ) {
        if (key.startsWith("receipts/")) {
          const ingressId = key.slice("receipts/".length, -".json".length);
          receiptConditions[ingressId] = options?.onlyIf?.etagMatches;
          states[ingressId] = JSON.parse(value);
        }
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send(pointer: InboundArchivePointer) {
        queued.push(pointer.ingressId);
      },
    },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return {
          async getEmail() {
            return {};
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.deepEqual(queued, ["stale", "archived", "admitted"]);
  assert.equal(receiptConditions.stale, "stale-receipt-etag");
  assert.deepEqual(result, {
    scanned: 8,
    reenqueued: 3,
    skipped: 3,
    invalid: 1,
    failed: 0,
    projectionMissing: 0,
    terminalized: 1,
    failureLedgered: 0,
  });
  assert.equal(states["dead-letter-stale"].state, "dead_lettered");
  assert.equal(
    states["dead-letter-stale"].errorCode,
    "DLQ_TERMINALIZATION_RECOVERED",
  );
});

test("reconciliation restores a terminal receipt from the independent Mailbox ledger", async () => {
  const ingressId = "terminal-ledger-recovery";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let finalState: string | undefined;
  let queueCalls = 0;
  const env = {
    RAW_MAIL_BUCKET: {
      async list() {
        return { objects: [{ key: rawKey }], truncated: false };
      },
      async head() {
        return {
          key: rawKey,
          size: 321,
          etag: "archive-etag",
          version: "archive-version",
          customMetadata: {
            archivedAt: "2026-07-13T09:00:00.000Z",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "321",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return {
          etag: "stale-receipt-etag",
          async text() {
            return JSON.stringify({
              state: "retrying",
              updatedAt: "2026-07-13T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("receipts/")) finalState = JSON.parse(value).state;
        return {};
      },
      async delete() {},
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
          async getEmail() {
            return null;
          },
          async getInboundTerminalFailure() {
            return {
              queueMessageId: "dlq-terminal-message",
              attempts: 10,
              errorCode: "QUEUE_RETRY_EXHAUSTED",
              recordedAt: "2026-07-13T09:45:00.000Z",
            };
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(finalState, "dead_lettered");
  assert.equal(queueCalls, 0);
});

test("reconciliation terminalizes an intentionally deleted stale projection", async () => {
  const ingressId = "deleted-stale-projection";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let finalState: string | undefined;
  let queueCalls = 0;
  const env = {
    RAW_MAIL_BUCKET: {
      async list() {
        return { objects: [{ key: rawKey }], truncated: false };
      },
      async head() {
        return {
          key: rawKey,
          size: 321,
          etag: "archive-etag",
          version: "archive-version",
          customMetadata: {
            archivedAt: "2026-07-13T09:00:00.000Z",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "321",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return {
          etag: "stale-receipt-etag",
          async text() {
            return JSON.stringify({
              state: "enqueued",
              updatedAt: "2026-07-13T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("receipts/")) finalState = JSON.parse(value).state;
        return {};
      },
      async delete() {},
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
          async getEmail() {
            return null;
          },
          async isEmailDeleted() {
            return true;
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(finalState, "deleted");
  assert.equal(queueCalls, 0);
});

test("reconciliation resumes from and persists the R2 continuation cursor", async () => {
  let persistedCursor: unknown;
  const env = {
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        assert.equal(key, "system/reconciliation-cursor.json");
        return {
          async text() {
            return JSON.stringify({ cursor: "previous-page-cursor" });
          },
        };
      },
      async list(options: { prefix: string; limit: number; cursor?: string }) {
        assert.deepEqual(options, {
          prefix: "raw/",
          limit: 100,
          cursor: "previous-page-cursor",
        });
        return { objects: [], truncated: true, cursor: "next-page-cursor" };
      },
      async head() {
        assert.fail("an empty page must not read archive metadata");
      },
      async put(key: string, value: string) {
        assert.equal(key, "system/reconciliation-cursor.json");
        persistedCursor = JSON.parse(value).cursor;
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("an empty page must not enqueue");
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
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.equal(persistedCursor, "next-page-cursor");
  assert.deepEqual(result, {
    scanned: 0,
    reenqueued: 0,
    skipped: 0,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    terminalized: 0,
    failureLedgered: 0,
  });
});

test("reconciliation reports a stored receipt whose Mailbox projection is missing", async () => {
  let cursorPersisted = false;
  const rawKey = "raw/2026/07/13/stored-but-missing.eml";
  const env = {
    RAW_MAIL_BUCKET: {
      async list() {
        return { objects: [{ key: rawKey }], truncated: false };
      },
      async head() {
        return {
          key: rawKey,
          size: 123,
          etag: "archive-etag",
          version: "archive-version",
          customMetadata: {
            archivedAt: "2026-07-13T09:00:00.000Z",
            ingressId: "stored-but-missing",
            mailboxId: "hello@wiserchat.ai",
            rawSize: "123",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return {
          etag: "stored-receipt-etag",
          async text() {
            return JSON.stringify({
              state: "stored",
              updatedAt: "2026-07-13T09:01:00.000Z",
            });
          },
        };
      },
      async put() {
        cursorPersisted = true;
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail(
          "a missing stored projection requires operator review, not automatic restore",
        );
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
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.equal(result.projectionMissing, 1);
  assert.equal(cursorPersisted, true);
});

test("reconciliation advances after durably ledgering an archive failure", async () => {
  let cursorPersisted = false;
  let failureLedgered = false;
  const env = {
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return null;
      },
      async list() {
        return {
          objects: [{ key: "raw/2026/07/13/transient-failure.eml" }],
          truncated: true,
          cursor: "must-not-advance",
        };
      },
      async head() {
        throw new Error("simulated R2 read outage");
      },
      async put(key: string) {
        if (key.startsWith("system/reconciliation-failures/")) {
          failureLedgered = true;
        }
        if (key === "system/reconciliation-cursor.json") {
          cursorPersisted = true;
        }
        return {};
      },
      async delete() {},
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
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env);

  assert.equal(result.failed, 1);
  assert.equal(result.failureLedgered, 1);
  assert.equal(failureLedgered, true);
  assert.equal(cursorPersisted, true);
});

test("reconciliation holds its cursor when the failure ledger is unavailable", async () => {
  let cursorPersisted = false;
  const rawKey = "raw/2026/07/13/unledgered-failure.eml";
  const env = {
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return null;
      },
      async list() {
        return {
          objects: [{ key: rawKey }],
          truncated: true,
          cursor: "must-not-advance",
        };
      },
      async head() {
        throw new Error("simulated archive read outage");
      },
      async put(key: string) {
        if (key.startsWith("system/reconciliation-failures/")) {
          throw new Error("simulated failure-ledger outage");
        }
        if (key === "system/reconciliation-cursor.json") {
          cursorPersisted = true;
        }
        return {};
      },
      async delete() {},
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
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env);

  assert.equal(result.failed, 1);
  assert.equal(result.failureLedgered, 0);
  assert.equal(cursorPersisted, false);
});
