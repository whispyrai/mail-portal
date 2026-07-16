import assert from "node:assert/strict";
import test from "node:test";
import type { InboundArchivePointer } from "./inbound-email.ts";
import { reconcileInboundArchives } from "./inbound-reconciliation.ts";

const derivedBucketWithoutDelete = {
  async head() {
    return null;
  },
};
import { inboundDerivedContentAnomalyKey } from "./lib/inbound-derived-content-anomaly.ts";

function pendingReconciliationAnomaly(
  ingressId: string,
  rawKey: string,
): string {
  return JSON.stringify({
    detectedAt: "2026-07-13T09:30:00.000Z",
    errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
    ingressId,
    mailboxId: "hello@wiserchat.ai",
    rawKey,
    status: "pending_operator_review",
  });
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

test("reconciliation generation-fences a content-free marker for missing derived objects", async () => {
  const ingressId = "derived-anomaly";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  let marker: Record<string, unknown> | undefined;
  const env = {
    DOMAINS: "wiserchat.ai",
    DB: {} as D1Database,
    BUCKET: {
      async head(key: string) {
        assert.equal(key, "attachments/derived-anomaly/exact.bin");
        return null;
      },
    },
    RAW_MAIL_BUCKET: {
      async list() {
        return { objects: [{ key: rawKey }], truncated: false };
      },
      async head() {
        return {
          key: rawKey,
          size: 123,
          etag: "raw-etag",
          version: "raw-version",
          customMetadata: {
            archivedAt: "2026-07-15T09:00:00.000Z",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "123",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (
          key === "system/reconciliation-cursor.json" ||
          key.startsWith("system/reconciliation-anomalies/")
        ) return null;
        if (key === `receipts/${ingressId}.json`) {
          return {
            etag: "receipt-etag",
            async text() {
              return JSON.stringify({
                state: "stored",
                updatedAt: "2026-07-15T09:00:00.000Z",
              });
            },
          };
        }
        assert.fail(`unexpected R2 read: ${key}`);
      },
      async put(key: string, value: string, options?: unknown) {
        if (key === "system/reconciliation-cursor.json") return {};
        assert.equal(key, inboundDerivedContentAnomalyKey(ingressId, 4));
        assert.deepEqual(options, {
          customMetadata: {
            generation: "4",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            status: "pending",
          },
          onlyIf: { etagDoesNotMatch: "*" },
        });
        marker = JSON.parse(value);
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("stored projections must not enqueue");
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
          async hasEmail() {
            return true;
          },
          async isEmailDeleted() {
            return false;
          },
          async getInboundDerivedContentManifest() {
            return {
              status: "live_inbound" as const,
              generation: 4,
              lastRepairMarkerId: null,
              attachments: [
                {
                  id: "attachment-id",
                  r2Key: "attachments/derived-anomaly/exact.bin",
                  byteLength: 91,
                },
              ],
              bodyObjects: [],
            };
          },
        };
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.pendingReview, 1);
  assert.equal(result.skipped, 0);
  assert.equal(marker?.kind, "inbound_derived_content_anomaly");
  assert.equal(marker?.status, "pending");
  assert.equal(marker?.generation, 4);
  assert.deepEqual(marker?.failures, [
    {
      objectType: "attachment",
      objectId: "attachment-id",
      expectedBytes: 91,
      actualBytes: null,
      reason: "missing",
    },
  ]);
  assert.equal("r2Key" in (marker ?? {}), false);
});

test("reconciliation rejects poisoned Mailbox manifests before R2 inspection or anomaly persistence", async () => {
  const ingressId = "manifest-poison";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const poison = "attachments/other-mail/private.bin";
  let derivedHeadCalls = 0;
  let anomalyWrites = 0;
  const logs: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]) => logs.push(args);
  console.log = capture;
  console.error = capture;
  let result;
  try {
    result = await reconcileInboundArchives({
      DOMAINS: "wiserchat.ai",
      DB: {} as D1Database,
      BUCKET: {
        async head() {
          derivedHeadCalls += 1;
          return null;
        },
      },
      RAW_MAIL_BUCKET: {
        async list(options: { prefix: string }) {
          return {
            objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
            truncated: false,
          };
        },
        async head() {
          return {
            key: rawKey,
            size: 123,
            etag: "raw-etag",
            version: "raw-version",
            customMetadata: {
              archivedAt: "2026-07-15T09:00:00.000Z",
              ingressId,
              mailboxId: "hello@wiserchat.ai",
              rawSize: "123",
              schemaVersion: "1",
            },
          };
        },
        async get(key: string) {
          if (key === `receipts/${ingressId}.json`) {
            return {
              etag: "receipt-etag",
              async text() {
                return JSON.stringify({
                  state: "stored",
                  updatedAt: "2026-07-15T09:00:00.000Z",
                });
              },
            };
          }
          return null;
        },
        async put(key: string) {
          if (key.startsWith("system/derived-content-anomalies/")) {
            anomalyWrites += 1;
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
              return {};
            },
            async hasEmail() {
              return true;
            },
            async isEmailDeleted() {
              return false;
            },
            async getInboundDerivedContentManifest() {
              return {
                status: "live_inbound",
                generation: 2,
                lastRepairMarkerId: "marker_12345678",
                attachments: [{ id: "attachment-1", r2Key: poison, byteLength: 10 }],
                bodyObjects: [],
              };
            },
          };
        },
      },
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(result.failed, 1);
  assert.equal(result.failureLedgered, 1);
  assert.equal(derivedHeadCalls, 0);
  assert.equal(anomalyWrites, 0);
  assert.equal(JSON.stringify(logs).includes(poison), false);
});

test("reconciliation preserves but never enqueues raw mail without a durable admission decision", async () => {
  const rawKey = "raw/2026/07/13/reconcile-missing-receipt.eml";
  const queued: InboundArchivePointer[] = [];
  let receipt: Record<string, unknown> | undefined;
  let sweepCursor: Record<string, unknown> | undefined;
  let anomaly: Record<string, unknown> | undefined;
  let recoveryPointer: Record<string, unknown> | undefined;
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
      async list(options: {
        prefix?: string;
        limit?: number;
        cursor?: string;
      }) {
        assert.deepEqual(options, { prefix: "raw/", limit: 7 });
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
    BUCKET: derivedBucketWithoutDelete,
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
              state: { privatePayload: "poison" },
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
  assert.deepEqual(anomaly, {
    detectedAt: "2026-07-13T10:00:00.000Z",
    errorCode: "RECEIPT_STATE_UNKNOWN",
    ingressId: "unknown-state",
    mailboxId: "hello@wiserchat.ai",
    rawKey,
    status: "pending_operator_review",
  });
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
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: mailboxDb(),
    BUCKET: {
      async head() {
        return {};
      },
    },
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
    scanned: 7,
    reenqueued: 3,
    skipped: 3,
    invalid: 0,
    failed: 0,
    projectionMissing: 0,
    pendingReview: 0,
    terminalized: 1,
    failureLedgered: 0,
  });
  assert.equal(states["dead-letter-stale"].state, "dead_lettered");
  assert.equal(states["dead-letter-stale"].errorCode, "QUEUE_RETRY_EXHAUSTED");
});

for (const testCase of [
  {
    name: "rejects archived mail for an inactive mailbox",
    dbState: "inactive" as const,
    expectedReceipt: "rejected",
    expectedResult: { terminalized: 1, failed: 0, failureLedgered: 0 },
  },
  {
    name: "durably ledgers a transient active-mailbox lookup failure",
    dbState: "unavailable" as const,
    expectedReceipt: undefined,
    expectedResult: { terminalized: 0, failed: 1, failureLedgered: 1 },
  },
]) {
  test(`reconciliation ${testCase.name}`, async () => {
    const ingressId = `reconcile-d1-${testCase.dbState}`;
    const rawKey = `raw/2026/07/15/${ingressId}.eml`;
    let receiptState: string | undefined;
    let failureLedgered = false;
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(testCase.dbState),
      BUCKET: {
        async head() {
          return {};
        },
      },
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
              archivedAt: "2026-07-15T09:00:00.000Z",
              ingressId,
              mailboxId: "hello@wiserchat.ai",
              rawSize: "123",
              schemaVersion: "1",
            },
          };
        },
        async get(key: string) {
          if (
            key === "system/reconciliation-cursor.json" ||
            key.startsWith("system/reconciliation-anomalies/")
          ) return null;
          assert.equal(key, `receipts/${ingressId}.json`);
          return {
            etag: "archived-receipt-etag",
            async text() {
              return JSON.stringify({
                state: "archived",
                updatedAt: "2026-07-15T09:00:00.000Z",
              });
            },
          };
        },
        async put(key: string, value: string) {
          if (key.startsWith("receipts/"))
            receiptState = JSON.parse(value).state;
          if (key.startsWith("system/reconciliation-failures/"))
            failureLedgered = true;
          return {};
        },
        async delete() {},
      },
      INBOUND_QUEUE: {
        async send() {
          assert.fail("unadmitted archived mail must not enqueue");
        },
      },
      MAILBOX: {
        idFromName() {
          assert.fail("archived admission must finish before Mailbox resolution");
        },
        get() {
          assert.fail("archived admission must finish before Mailbox resolution");
        },
      },
    };

    const result = await reconcileInboundArchives(env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    assert.equal(receiptState, testCase.expectedReceipt);
    assert.equal(result.terminalized, testCase.expectedResult.terminalized);
    assert.equal(result.failed, testCase.expectedResult.failed);
    assert.equal(
      result.failureLedgered,
      testCase.expectedResult.failureLedgered,
    );
    assert.equal(failureLedgered, testCase.expectedResult.failureLedgered === 1);
  });
}

test("reconciliation terminalizes an archived receipt whose declared size disagrees with durable raw bytes", async () => {
  const ingressId = "reconcile-size-mismatch";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  let rejected: Record<string, unknown> | undefined;
  const env = {
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: {
      prepare() {
        assert.fail("size mismatch must reject before D1 admission");
      },
    },
    BUCKET: {
      async head() {
        assert.fail("size mismatch must reject before mailbox admission");
      },
    },
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
            archivedAt: "2026-07-15T09:00:00.000Z",
            declaredRawSize: "124",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "123",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (
          key === "system/reconciliation-cursor.json" ||
          key.startsWith("system/reconciliation-anomalies/")
        ) return null;
        return {
          etag: "archived-etag",
          async text() {
            return JSON.stringify({
              state: "archived",
              updatedAt: "2026-07-15T09:00:00.000Z",
            });
          },
        };
      },
      async put(key: string, value: string) {
        if (key.startsWith("receipts/")) rejected = JSON.parse(value);
        return {};
      },
      async delete() {},
    },
    INBOUND_QUEUE: {
      async send() {
        assert.fail("size-mismatched mail must not enqueue");
      },
    },
    MAILBOX: {
      idFromName() {
        assert.fail("size mismatch must reject before Mailbox resolution");
      },
      get() {
        assert.fail("size mismatch must reject before Mailbox resolution");
      },
    },
  };

  const result = await reconcileInboundArchives(env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(rejected?.state, "rejected");
  assert.equal(rejected?.errorCode, "RAW_SIZE_INVALID");
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
    BUCKET: derivedBucketWithoutDelete,
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
              const anomalyIngressId = key.includes("pending-but-stored")
                ? "pending-but-stored"
                : "stored-and-stored";
              return pendingReconciliationAnomaly(
                anomalyIngressId,
                `raw/2026/07/13/${anomalyIngressId}.eml`,
              );
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
              queueRef: "d06683c38d7755ce",
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
  let finalReceipt: Record<string, unknown> | undefined;
  let resolvedAnomaly: Record<string, unknown> | undefined;
  let queueCalls = 0;
  const env = {
    BUCKET: derivedBucketWithoutDelete,
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
              return pendingReconciliationAnomaly(ingressId, rawKey);
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
        if (key.startsWith("receipts/")) finalReceipt = JSON.parse(value);
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
              queueRef: "d06683c38d7755ce",
              attempts: 10,
              errorCode: "QUEUE_RETRY_EXHAUSTED",
              recordedAt: "2026-07-13T09:45:00.000Z",
              privatePayload: "poison",
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
  assert.equal(finalReceipt?.state, "dead_lettered");
  assert.deepEqual(finalReceipt?.terminalFailure, {
    queueRef: "d06683c38d7755ce",
    attempts: 10,
    errorCode: "QUEUE_RETRY_EXHAUSTED",
    recordedAt: "2026-07-13T09:45:00.000Z",
  });
  assert.equal(resolvedAnomaly?.status, "resolved");
  assert.equal(
    resolvedAnomaly?.resolution,
    "terminal_failure_ledger_recovered",
  );
  assert.equal(queueCalls, 0);
});

test("reconciliation refuses malformed terminal-failure ledger fields", async () => {
  const ingressId = "malformed-terminal-ledger";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  const valid = {
    queueRef: "d06683c38d7755ce",
    attempts: 10,
    errorCode: "QUEUE_RETRY_EXHAUSTED",
    recordedAt: "2026-07-13T09:45:00.000Z",
  };
  for (const candidate of [
    { ...valid, queueRef: "raw-queue-message-id" },
    { ...valid, attempts: -1 },
    { ...valid, errorCode: "MANUAL_RECOVERY_PROJECTION_FAILED" },
    { ...valid, recordedAt: "not-a-timestamp" },
  ]) {
    let receiptWrites = 0;
    const result = await reconcileInboundArchives(
      {
        DOMAINS: "wiserchat.ai",
        DB: mailboxDb(),
        BUCKET: derivedBucketWithoutDelete,
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
            if (key.startsWith("system/reconciliation-anomalies/")) return null;
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
          async put(key: string) {
            if (key.startsWith("receipts/")) receiptWrites += 1;
            return {};
          },
          async delete() {},
        },
        INBOUND_QUEUE: {
          async send() {
            assert.fail("malformed terminal truth must not enqueue");
          },
        },
        MAILBOX: {
          idFromName(value: string) {
            return value;
          },
          get() {
            return {
              async getEmail() {
                return null;
              },
              async getInboundTerminalFailure() {
                return JSON.parse(JSON.stringify(candidate));
              },
            };
          },
        },
      },
      { now: () => new Date("2026-07-13T10:00:00.000Z") },
    );
    assert.equal(result.terminalized, 0);
    assert.equal(result.pendingReview, 1);
    assert.equal(receiptWrites, 0);
  }
});

test("reconciliation resolves a pending anomaly from an R2-only terminal receipt", async () => {
  const ingressId = "r2-terminal-recovery";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let resolvedAnomaly: Record<string, unknown> | undefined;
  const env = {
    BUCKET: derivedBucketWithoutDelete,
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
              return pendingReconciliationAnomaly(ingressId, rawKey);
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

test("reconciliation terminalizes a stale dead-letter intent without a Mailbox terminal ledger", async () => {
  const ingressId = "stale-dead-letter-without-ledger";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let terminalReceipt: Record<string, unknown> | undefined;
  let receiptCondition: string | undefined;
  let resolvedAnomaly: Record<string, unknown> | undefined;
  let queueCalls = 0;
  const env = {
    BUCKET: derivedBucketWithoutDelete,
    RAW_MAIL_BUCKET: {
      async list(options: { prefix: string }) {
        return {
          objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
          truncated: false,
        };
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
        if (key.includes("cursor.json")) return null;
        if (key.startsWith("system/reconciliation-anomalies/")) {
          return {
            etag: "anomaly-etag",
            async text() {
              return pendingReconciliationAnomaly(ingressId, rawKey);
            },
          };
        }
        if (key === `receipts/${ingressId}.json`) {
          return {
            etag: "stale-receipt-etag",
            async text() {
              return JSON.stringify({
                state: "dead_letter_pending",
                errorCode: "FORGED_UPPERCASE_CODE",
                updatedAt: "2026-07-13T09:00:00.000Z",
              });
            },
          };
        }
        return null;
      },
      async put(
        key: string,
        value: string,
        options?: { onlyIf?: { etagMatches?: string } },
      ) {
        if (key === `receipts/${ingressId}.json`) {
          terminalReceipt = JSON.parse(value);
          receiptCondition = options?.onlyIf?.etagMatches;
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          resolvedAnomaly = JSON.parse(value);
        }
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
          async hasEmail() {
            return false;
          },
          async isEmailDeleted() {
            return false;
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
  assert.equal(terminalReceipt?.state, "dead_lettered");
  assert.equal(terminalReceipt?.errorCode, "QUEUE_RETRY_EXHAUSTED");
  assert.equal(terminalReceipt?.reconciled, true);
  assert.equal(terminalReceipt?.updatedAt, "2026-07-13T10:00:00.000Z");
  assert.equal(receiptCondition, "stale-receipt-etag");
  assert.equal(resolvedAnomaly?.status, "resolved");
  assert.equal(resolvedAnomaly?.resolution, "dead_letter_intent_terminalized");
  assert.equal(queueCalls, 0);
});

test("reconciliation preserves the concurrent winner when stale dead-letter terminalization loses CAS", async () => {
  const ingressId = "stale-dead-letter-cas-loss";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let receiptWrites = 0;
  let anomalyWrites = 0;
  let queueCalls = 0;
  const env = {
    BUCKET: derivedBucketWithoutDelete,
    RAW_MAIL_BUCKET: {
      async list(options: { prefix: string }) {
        return {
          objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
          truncated: false,
        };
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
        if (key.includes("cursor.json")) return null;
        if (key.startsWith("system/reconciliation-anomalies/")) return null;
        if (key === `receipts/${ingressId}.json`) {
          return {
            etag: "stale-receipt-etag",
            async text() {
              return JSON.stringify({
                state: "dead_letter_pending",
                updatedAt: "2026-07-13T09:00:00.000Z",
              });
            },
          };
        }
        return null;
      },
      async put(key: string) {
        if (key === `receipts/${ingressId}.json`) {
          receiptWrites += 1;
          return null;
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          anomalyWrites += 1;
        }
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
          async hasEmail() {
            return false;
          },
          async isEmailDeleted() {
            return false;
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

  assert.equal(result.skipped, 1);
  assert.equal(result.terminalized, 0);
  assert.equal(receiptWrites, 1);
  assert.equal(anomalyWrites, 0);
  assert.equal(queueCalls, 0);
});

test("reconciliation gives a deletion tombstone priority over stale dead-letter state", async () => {
  const ingressId = "deleted-stale-projection";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let finalState: string | undefined;
  let queueCalls = 0;
  const env = {
    BUCKET: derivedBucketWithoutDelete,
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
    BUCKET: derivedBucketWithoutDelete,
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
          limit: 7,
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
    BUCKET: derivedBucketWithoutDelete,
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
  let failureLedgerValue = "";
  const attachmentKey = "attachments/private-message/private-attempt/private.bin";
  const env = {
    BUCKET: derivedBucketWithoutDelete,
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
        throw new Error(`simulated R2 read outage for ${attachmentKey}`);
      },
      async put(key: string, value: string) {
        if (key.startsWith("system/reconciliation-failures/")) {
          failureLedgered = true;
          failureLedgerValue = value;
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

  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  let result;
  try {
    result = await reconcileInboundArchives(env);
  } finally {
    console.error = originalError;
  }

  assert.equal(result.failed, 1);
  assert.equal(result.failureLedgered, 1);
  assert.equal(failureLedgered, true);
  assert.equal(cursorPersisted, true);
  assert.equal(failureLedgerValue.includes(attachmentKey), false);
  assert.equal(JSON.parse(failureLedgerValue).errorCode, "ARCHIVE_RECONCILIATION_FAILED");
  assert.equal(JSON.stringify(logs).includes(attachmentKey), false);
});

test("reconciliation holds its cursor when the failure ledger is unavailable", async () => {
  let cursorPersisted = false;
  const rawKey = "raw/2026/07/13/unledgered-failure.eml";
  const env = {
    BUCKET: derivedBucketWithoutDelete,
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

test("reconciliation emits one bounded terminal sweep summary on every exit path", async () => {
  const scenarios = [
    { name: "completed", expectedStatus: "succeeded" },
    { name: "cursor_superseded", expectedStatus: "partial" },
    { name: "list_failed", expectedStatus: "failed" },
    { name: "cursor_write_failed", expectedStatus: "failed" },
  ] as const;

  for (const scenario of scenarios) {
    const logs: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const originalLog = console.log;
    const originalError = console.error;
    const capture = (message: string, fields?: Record<string, unknown>) => {
      logs.push({ message, fields });
    };
    console.log = capture;
    console.error = capture;
    const env = {
      DOMAINS: "wiserchat.ai",
      DB: mailboxDb(),
      BUCKET: derivedBucketWithoutDelete,
      RAW_MAIL_BUCKET: {
        async get() {
          return null;
        },
        async list(options: { prefix: string }) {
          if (options.prefix === "raw/" && scenario.name === "list_failed") {
            throw new Error("list-error-message-poison");
          }
          const objects = options.prefix.includes("repair-attempts")
            ? [{ key: `${options.prefix}repair-attempt-poison.json` }]
            : options.prefix.includes("cleanup-intents")
              ? [{ key: `${options.prefix}cleanup-intent-poison.json` }]
              : [];
          return { objects, truncated: false };
        },
        async head() {
          return null;
        },
        async put(key: string) {
          if (key === "system/reconciliation-cursor.json") {
            if (scenario.name === "cursor_superseded") return null;
            if (scenario.name === "cursor_write_failed") {
              throw new Error("cursor-error-message-poison");
            }
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
    try {
      if (scenario.expectedStatus === "failed") {
        await assert.rejects(reconcileInboundArchives(env));
      } else {
        await reconcileInboundArchives(env);
      }
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const starts = logs.filter(
      (entry) => entry.message === "[mail-reconciliation] sweep started",
    );
    const terminals = logs.filter(
      (entry) => entry.message === "[mail-reconciliation] sweep completed",
    );
    assert.equal(starts.length, 1, `${scenario.name} has one sweep start`);
    assert.equal(terminals.length, 1, `${scenario.name} has one terminal summary`);
    assert.equal(terminals[0]?.fields?.status, scenario.expectedStatus);
    assert.equal(
      terminals[0]?.fields?.errorCode,
      scenario.expectedStatus === "failed"
        ? "RECONCILIATION_SWEEP_FAILED"
        : undefined,
    );
    assert.equal(terminals[0]?.fields?.repairScanned, 1);
    assert.equal(terminals[0]?.fields?.cleanupScanned, 1);
    assert.doesNotMatch(
      JSON.stringify(logs),
      /list-error-message-poison|cursor-error-message-poison|repair-attempt-poison|cleanup-intent-poison/,
    );
  }
});
