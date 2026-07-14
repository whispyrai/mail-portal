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
    skipped: 0,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    pendingReview: 1,
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

test("reconciliation degrades the aggregate for an unknown receipt state", async () => {
  const rawKey = "raw/2026/07/13/unknown-state.eml";
  let anomaly: Record<string, unknown> | undefined;
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
            ingressId: "unknown-state",
            mailboxId: "hello@wiserchat.ai",
            rawSize: "123",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        return {
          etag: "unknown-state-etag",
          async text() {
            return JSON.stringify({
              state: "future-state",
              updatedAt: "2026-07-13T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("system/reconciliation-anomalies/"))
          anomaly = JSON.parse(value);
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("unknown receipt states must not enqueue");
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

  assert.equal(result.pendingReview, 1);
  assert.equal(result.skipped, 0);
  assert.equal(anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(anomaly?.status, "pending_operator_review");
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
          async getEmail(ingressId: string) {
            return ingressId === "stored" ? {} : null;
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
    pendingReview: 1,
    terminalized: 0,
    failureLedgered: 0,
  });
  assert.equal(states["dead-letter-stale"].state, "dead_letter_pending");
});

test("reconciliation heals stale terminal receipts from Mailbox truth", async () => {
  const ingressIds = [
    "pending-but-stored",
    "terminal-but-stored",
    "quarantined-but-stored",
    "rejected-but-stored",
    "stored-and-stored",
  ];
  const finalStates: Record<string, string> = {};
  const resolvedAnomalies: Array<Record<string, unknown>> = [];
  const env = {
    RAW_MAIL_BUCKET: {
      async list() {
        return {
          objects: ingressIds.map((ingressId) => ({
            key: `raw/2026/07/13/${ingressId}.eml`,
          })),
          truncated: false,
        };
      },
      async head(key: string) {
        const ingressId = key.slice(key.lastIndexOf("/") + 1, -4);
        return {
          key,
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
        if (key.startsWith("system/reconciliation-anomalies/")) {
          if (
            !key.includes("pending-but-stored") &&
            !key.includes("stored-and-stored")
          )
            return null;
          return {
            etag: "pending-anomaly-etag",
            async text() {
              return JSON.stringify({
                errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
                status: "pending_operator_review",
              });
            },
          };
        }
        const ingressId = key.slice("receipts/".length, -".json".length);
        return {
          etag: `${ingressId}-receipt-etag`,
          async text() {
            return JSON.stringify({
              state: {
                "pending-but-stored": "dead_letter_pending",
                "terminal-but-stored": "dead_lettered",
                "quarantined-but-stored": "quarantined",
                "rejected-but-stored": "rejected",
                "stored-and-stored": "stored",
              }[ingressId],
              updatedAt: "2026-07-13T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("system/reconciliation-anomalies/")) {
          resolvedAnomalies.push(JSON.parse(value));
          return {};
        }
        if (key.startsWith("receipts/")) {
          const ingressId = key.slice("receipts/".length, -".json".length);
          finalStates[ingressId] = JSON.parse(value).state;
        }
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("stored Mailbox truth must not be re-enqueued");
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
          async getInboundTerminalFailure() {
            return {
              queueMessageId: "stale-terminal-ledger",
              attempts: 10,
              errorCode: "QUEUE_RETRY_EXHAUSTED",
              recordedAt: "2026-07-13T09:30:00.000Z",
            };
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.deepEqual(finalStates, {
    "pending-but-stored": "stored",
    "terminal-but-stored": "stored",
    "quarantined-but-stored": "stored",
    "rejected-but-stored": "stored",
  });
  assert.equal(resolvedAnomalies.length, 2);
  assert.ok(
    resolvedAnomalies.every(
      (anomaly) =>
        anomaly.status === "resolved" &&
        anomaly.resolution === "mailbox_projection_stored",
    ),
  );
  assert.equal(result.terminalized, 4);
  assert.equal(result.skipped, 1);
  assert.equal(result.pendingReview, 0);
  assert.equal(result.reenqueued, 0);
});

test("reconciliation restores a terminal receipt from the independent Mailbox ledger", async () => {
  const ingressId = "terminal-ledger-recovery";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let finalState: string | undefined;
  let resolvedAnomaly: Record<string, unknown> | undefined;
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
        if (key.startsWith("system/reconciliation-anomalies/")) {
          return {
            etag: "pending-anomaly-etag",
            async text() {
              return JSON.stringify({
                errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
                status: "pending_operator_review",
              });
            },
          };
        }
        return {
          etag: "stale-receipt-etag",
          async text() {
            return JSON.stringify({
              state: "dead_lettered",
              updatedAt: "2026-07-13T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("receipts/")) finalState = JSON.parse(value).state;
        if (key.startsWith("system/reconciliation-anomalies/"))
          resolvedAnomaly = JSON.parse(value);
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
  assert.equal(resolvedAnomaly?.status, "resolved");
  assert.equal(
    resolvedAnomaly?.resolution,
    "terminal_failure_ledger_recovered",
  );
  assert.equal(queueCalls, 0);
});

test("reconciliation resolves a pending anomaly from an R2-only terminal receipt", async () => {
  const ingressId = "r2-terminal-recovery";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let resolvedAnomaly: Record<string, unknown> | undefined;
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
        if (key.startsWith("system/reconciliation-anomalies/")) {
          return {
            etag: "pending-anomaly-etag",
            async text() {
              return JSON.stringify({
                errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
                status: "pending_operator_review",
              });
            },
          };
        }
        return {
          etag: "terminal-receipt-etag",
          async text() {
            return JSON.stringify({
              state: "dead_lettered",
              updatedAt: "2026-07-13T09:45:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("system/reconciliation-anomalies/"))
          resolvedAnomaly = JSON.parse(value);
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("terminal receipts must not enqueue");
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
            return null;
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-13T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(result.pendingReview, 0);
  assert.equal(resolvedAnomaly?.status, "resolved");
  assert.equal(resolvedAnomaly?.resolution, "terminal_receipt_persisted");
});

test("reconciliation gives a deletion tombstone priority over stale dead-letter state", async () => {
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
              state: "dead_letter_pending",
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
    pendingReview: 0,
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
