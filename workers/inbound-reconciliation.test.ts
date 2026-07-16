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

function inboundReceiptBody(
  pointer: {
    ingressId: string;
    rawKey: string;
    rawSize: number;
    archivedAt: string;
    etag?: string;
    version?: string;
    mailboxId?: string;
    rawSha256?: string;
  },
  state: string,
  updatedAt: string,
  details: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    ingressId: pointer.ingressId,
    rawKey: pointer.rawKey,
    mailboxId: pointer.mailboxId ?? "hello@wiserchat.ai",
    rawSize: pointer.rawSize,
    ...(pointer.rawSha256 === undefined
      ? {}
      : { rawSha256: pointer.rawSha256 }),
    archivedAt: pointer.archivedAt,
    etag: pointer.etag ?? "archive-etag",
    version: pointer.version ?? "archive-version",
    state,
    updatedAt,
    ...details,
  });
}

type MissingReceiptMailboxTruth =
  | "stored"
  | "deleted"
  | "dead_lettered"
  | "malformed_terminal"
  | "none";

function missingReceiptTruthFixture(
  truth: MissingReceiptMailboxTruth,
  options: {
    anomalyProofFails?: boolean;
    concurrentReceiptText?: string | null;
    failureLedgerWriteFails?: boolean;
    receiptCommits?: boolean;
    startWithPendingAnomaly?: boolean;
  } = {},
) {
  const ingressId = `missing-receipt-${truth}`;
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const truthReads: string[] = [];
  let reconstructedReceipt: Record<string, unknown> | undefined;
  let receiptCreateCondition: string | undefined;
  let pendingAnomaly: Record<string, unknown> | undefined =
    options.startWithPendingAnomaly === false
      ? undefined
      : JSON.parse(pendingReconciliationAnomaly(ingressId, rawKey));
  let resolvedAnomaly: Record<string, unknown> | undefined;
  let recoveryPointer: Record<string, unknown> | undefined;
  let queueCalls = 0;
  let receiptReads = 0;
  let cursorPersisted = false;
  let failureLedger: Record<string, unknown> | undefined;

  const env = {
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [],
    DB: mailboxDb(),
    BUCKET: derivedBucketWithoutDelete,
    RAW_MAIL_BUCKET: {
      async list(options: { prefix: string }) {
        return {
          objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
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
            archivedAt: "2026-07-15T09:00:00.000Z",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "321",
            rawSha256: "a".repeat(64),
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (key === "system/reconciliation-cursor.json") return null;
        if (key === `receipts/${ingressId}.json`) {
          receiptReads += 1;
          if (receiptReads === 1 || options.concurrentReceiptText === undefined)
            return null;
          if (options.concurrentReceiptText === null) return null;
          return {
            etag: "concurrent-receipt-etag",
            async text() {
              return options.concurrentReceiptText ?? "";
            },
          };
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          if (!pendingAnomaly) return null;
          return {
            etag: "pending-anomaly-etag",
            async text() {
              return JSON.stringify(pendingAnomaly);
            },
          };
        }
        return null;
      },
      async put(
        key: string,
        value: string,
        putOptions?: {
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
        },
      ) {
        if (key === `receipts/${ingressId}.json`) {
          reconstructedReceipt = JSON.parse(value);
          receiptCreateCondition = putOptions?.onlyIf?.etagDoesNotMatch;
          return options.receiptCommits === false
            ? null
            : { etag: "reconstructed-receipt-etag" };
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          if (options.anomalyProofFails) return null;
          const anomaly: Record<string, unknown> = JSON.parse(value);
          if (anomaly.status === "resolved") {
            resolvedAnomaly = anomaly;
            pendingAnomaly = undefined;
          } else {
            pendingAnomaly = anomaly;
          }
          return {};
        }
        if (key.startsWith("system/inbound-recovery-pointers/")) {
          recoveryPointer = JSON.parse(value);
          return {};
        }
        if (key.startsWith("system/reconciliation-failures/")) {
          if (options.failureLedgerWriteFails)
            throw new Error("simulated reconciliation failure-ledger outage");
          failureLedger = JSON.parse(value);
          return {};
        }
        if (key === "system/reconciliation-cursor.json") {
          cursorPersisted = true;
          return {};
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
            assert.fail("hasEmail is the available projection truth seam");
          },
          async isEmailDeleted() {
            truthReads.push("deleted");
            return truth === "deleted";
          },
          async hasEmail() {
            truthReads.push("stored");
            return truth === "stored";
          },
          async getInboundTerminalFailure() {
            truthReads.push("terminal");
            if (truth === "malformed_terminal") {
              return {
                queueRef: "provider-message-id",
                attempts: 10,
                errorCode: "QUEUE_RETRY_EXHAUSTED",
                recordedAt: "2026-07-15T09:45:00.000Z",
              };
            }
            if (truth !== "dead_lettered") return null;
            return {
              queueRef: "d06683c38d7755ce",
              attempts: 10,
              errorCode: "QUEUE_RETRY_EXHAUSTED",
              recordedAt: "2026-07-15T09:45:00.000Z",
            };
          },
        };
      },
    },
  };

  return {
    env,
    ingressId,
    rawKey,
    observations: {
      get pendingAnomaly() {
        return pendingAnomaly;
      },
      get queueCalls() {
        return queueCalls;
      },
      get cursorPersisted() {
        return cursorPersisted;
      },
      get failureLedger() {
        return failureLedger;
      },
      get receiptCreateCondition() {
        return receiptCreateCondition;
      },
      get reconstructedReceipt() {
        return reconstructedReceipt;
      },
      get recoveryPointer() {
        return recoveryPointer;
      },
      get resolvedAnomaly() {
        return resolvedAnomaly;
      },
      truthReads,
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
              return inboundReceiptBody(
                {
                  ingressId,
                  rawKey,
                  rawSize: 123,
                  archivedAt: "2026-07-15T09:00:00.000Z",
                  etag: "raw-etag",
                  version: "raw-version",
                },
                "stored",
                "2026-07-15T09:00:00.000Z",
              );
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
                return inboundReceiptBody(
                  {
                    ingressId,
                    rawKey,
                    rawSize: 123,
                    archivedAt: "2026-07-15T09:00:00.000Z",
                    etag: "raw-etag",
                    version: "raw-version",
                  },
                  "stored",
                  "2026-07-15T09:00:00.000Z",
                );
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

test("reconciliation reconstructs a missing stored receipt from Mailbox truth before admission review", async () => {
  const fixture = missingReceiptTruthFixture("stored");

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(result.pendingReview, 0);
  assert.equal(result.reenqueued, 0);
  assert.equal(fixture.observations.reconstructedReceipt?.state, "stored");
  assert.equal(
    fixture.observations.reconstructedReceipt?.errorCode,
    "MAILBOX_PROJECTION_RECOVERED",
  );
  assert.equal(fixture.observations.receiptCreateCondition, "*");
  assert.equal(fixture.observations.resolvedAnomaly?.status, "resolved");
  assert.equal(
    fixture.observations.resolvedAnomaly?.resolution,
    "mailbox_projection_stored",
  );
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
  assert.deepEqual(fixture.observations.truthReads, ["deleted", "stored"]);
});

test("reconciliation reconstructs a missing deleted receipt from the Mailbox tombstone first", async () => {
  const fixture = missingReceiptTruthFixture("deleted");

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(result.reenqueued, 0);
  assert.equal(fixture.observations.reconstructedReceipt?.state, "deleted");
  assert.equal(
    fixture.observations.reconstructedReceipt?.errorCode,
    "MAILBOX_PROJECTION_DELETED",
  );
  assert.equal(fixture.observations.receiptCreateCondition, "*");
  assert.equal(
    fixture.observations.resolvedAnomaly?.resolution,
    "mailbox_projection_deleted",
  );
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
  assert.deepEqual(fixture.observations.truthReads, ["deleted"]);
});

test("reconciliation reconstructs a missing dead-lettered receipt from the valid Mailbox terminal ledger", async () => {
  const fixture = missingReceiptTruthFixture("dead_lettered");

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.terminalized, 1);
  assert.equal(result.reenqueued, 0);
  assert.equal(
    fixture.observations.reconstructedReceipt?.state,
    "dead_lettered",
  );
  assert.deepEqual(
    fixture.observations.reconstructedReceipt?.terminalFailure,
    {
      queueRef: "d06683c38d7755ce",
      attempts: 10,
      errorCode: "QUEUE_RETRY_EXHAUSTED",
      recordedAt: "2026-07-15T09:45:00.000Z",
    },
  );
  assert.equal(fixture.observations.receiptCreateCondition, "*");
  assert.equal(
    fixture.observations.resolvedAnomaly?.resolution,
    "terminal_failure_ledger_recovered",
  );
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
  assert.deepEqual(fixture.observations.truthReads, [
    "deleted",
    "stored",
    "terminal",
  ]);
});

test("reconciliation keeps malformed missing-receipt terminal truth operator-visible", async () => {
  const fixture = missingReceiptTruthFixture("malformed_terminal");

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.pendingReview, 1);
  assert.equal(result.terminalized, 0);
  assert.equal(result.reenqueued, 0);
  assert.equal(fixture.observations.reconstructedReceipt, undefined);
  assert.equal(
    fixture.observations.pendingAnomaly?.errorCode,
    "DLQ_TERMINAL_LEDGER_MISSING",
  );
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
  assert.deepEqual(fixture.observations.truthReads, [
    "deleted",
    "stored",
    "terminal",
  ]);
});

test("reconciliation preserves the concurrent receipt winner when missing-receipt reconstruction loses CAS", async () => {
  const fixture = missingReceiptTruthFixture("stored", {
    receiptCommits: false,
    concurrentReceiptText: inboundReceiptBody(
      {
        ingressId: "missing-receipt-stored",
        rawKey: "raw/2026/07/15/missing-receipt-stored.eml",
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "stored",
      "2026-07-15T09:59:00.000Z",
    ),
  });

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.terminalized, 0);
  assert.equal(result.pendingReview, 0);
  assert.equal(result.reenqueued, 0);
  assert.equal(fixture.observations.receiptCreateCondition, "*");
  assert.equal(fixture.observations.resolvedAnomaly, undefined);
  assert.equal(fixture.observations.pendingAnomaly?.status, "pending_operator_review");
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
});

for (const compatibleWinner of [
  {
    truth: "deleted" as const,
    details: { errorCode: "MAILBOX_PROJECTION_DELETED", reconciled: true },
  },
  {
    truth: "dead_lettered" as const,
    details: {
      errorCode: "DLQ_TERMINAL_LEDGER_RECOVERED",
      reconciled: true,
      terminalFailure: {
        queueRef: "d06683c38d7755ce",
        attempts: 10,
        errorCode: "QUEUE_RETRY_EXHAUSTED",
        recordedAt: "2026-07-15T09:45:00.000Z",
      },
    },
  },
]) {
  test(`reconciliation preserves an exact ${compatibleWinner.truth} winner when missing-receipt reconstruction loses CAS`, async () => {
    const ingressId = `missing-receipt-${compatibleWinner.truth}`;
    const fixture = missingReceiptTruthFixture(compatibleWinner.truth, {
      receiptCommits: false,
      concurrentReceiptText: inboundReceiptBody(
        {
          ingressId,
          rawKey: `raw/2026/07/15/${ingressId}.eml`,
          rawSize: 321,
          rawSha256: "a".repeat(64),
          archivedAt: "2026-07-15T09:00:00.000Z",
        },
        compatibleWinner.truth,
        "2026-07-15T09:59:00.000Z",
        compatibleWinner.details,
      ),
    });

    const result = await reconcileInboundArchives(fixture.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.pendingReview, 0);
    assert.equal(fixture.observations.pendingAnomaly?.status, "pending_operator_review");
    assert.equal(fixture.observations.resolvedAnomaly, undefined);
    assert.equal(fixture.observations.queueCalls, 0);
  });
}

for (const concurrentWinner of [
  { name: "malformed", body: "not-json-provider-poison" },
  {
    name: "pointer-mismatched",
    body: inboundReceiptBody(
      {
        ingressId: "missing-receipt-stored",
        rawKey: "raw/2026/07/15/different-private-object.eml",
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "stored",
      "2026-07-15T09:59:00.000Z",
    ),
  },
  {
    name: "valid but backward",
    body: inboundReceiptBody(
      {
        ingressId: "missing-receipt-stored",
        rawKey: "raw/2026/07/15/missing-receipt-stored.eml",
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "archived",
      "2026-07-15T09:59:00.000Z",
    ),
  },
  { name: "post-CAS-loss absence", body: null },
]) {
  test(`reconciliation records receipt uncertainty when a ${concurrentWinner.name} winner beats stored reconstruction`, async () => {
    const fixture = missingReceiptTruthFixture("stored", {
      receiptCommits: false,
      concurrentReceiptText: concurrentWinner.body,
      startWithPendingAnomaly: false,
    });

    const result = await reconcileInboundArchives(fixture.env, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
    });

    assert.equal(result.pendingReview, 1);
    assert.equal(result.skipped, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.reenqueued, 0);
    assert.equal(fixture.observations.pendingAnomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
    assert.equal(fixture.observations.resolvedAnomaly, undefined);
    assert.equal(fixture.observations.recoveryPointer, undefined);
    assert.equal(fixture.observations.queueCalls, 0);
    assert.equal(fixture.observations.cursorPersisted, true);
  });
}

test("reconciliation uses the normal failure ledger when concurrent-winner uncertainty cannot be proven", async () => {
  const fixture = missingReceiptTruthFixture("stored", {
    anomalyProofFails: true,
    concurrentReceiptText: null,
    receiptCommits: false,
    startWithPendingAnomaly: false,
  });

  const result = await reconcileInboundArchives(fixture.env, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.pendingReview, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.failureLedgered, 1);
  assert.equal(fixture.observations.failureLedger?.errorCode, "ARCHIVE_RECONCILIATION_FAILED");
  assert.equal(fixture.observations.resolvedAnomaly, undefined);
  assert.equal(fixture.observations.recoveryPointer, undefined);
  assert.equal(fixture.observations.queueCalls, 0);
  assert.equal(fixture.observations.cursorPersisted, true);
});

test("reconciliation preserves but never enqueues raw mail without a durable admission decision", async () => {
  const rawKey = "raw/2026/07/13/reconcile-missing-receipt.eml";
  const queued: InboundArchivePointer[] = [];
  let receipt: Record<string, unknown> | undefined;
  let sweepCursor: Record<string, unknown> | undefined;
  let anomaly: Record<string, unknown> | undefined;
  let recoveryPointer: Record<string, unknown> | undefined;
  const mailboxTruthReads: string[] = [];
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
        assert.deepEqual(options, { prefix: "raw/", limit: 1 });
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
            mailboxTruthReads.push("stored");
            return null;
          },
          async isEmailDeleted() {
            mailboxTruthReads.push("deleted");
            return false;
          },
          async getInboundTerminalFailure() {
            mailboxTruthReads.push("terminal");
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
  assert.deepEqual(mailboxTruthReads, ["deleted", "stored", "terminal"]);
});

async function invalidPresentReceiptFixture(
  receiptText: (pointer: InboundArchivePointer) => string,
  options: {
    anomalyWriteFails?: boolean;
    anomalyWriteReturnsNull?: boolean;
    failureLedgerWriteFails?: boolean;
    receiptEtag?: string;
  } = {},
) {
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "invalid-present-receipt",
    rawKey: "raw/2026/07/15/invalid-present-receipt.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 321,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-15T09:00:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
  let anomaly: Record<string, unknown> | undefined;
  let failureLedger: Record<string, unknown> | undefined;
  let cursorPersisted = false;
  let receiptWrites = 0;
  let recoveryPointerWrites = 0;
  let queueCalls = 0;
  const logs: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]) => logs.push(args);
  console.log = capture;
  console.error = capture;
  const result = await (async () => {
    try {
      return await reconcileInboundArchives(
      {
        DOMAINS: "wiserchat.ai",
        DB: mailboxDb(),
        BUCKET: derivedBucketWithoutDelete,
        RAW_MAIL_BUCKET: {
          async list(options: { prefix: string }) {
            return {
              objects:
                options.prefix === "raw/" ? [{ key: pointer.rawKey }] : [],
              truncated: false,
            };
          },
          async head(key: string) {
            assert.equal(key, pointer.rawKey);
            return {
              key: pointer.rawKey,
              size: pointer.rawSize,
              etag: pointer.etag,
              version: pointer.version,
              customMetadata: {
                archivedAt: pointer.archivedAt,
                ingressId: pointer.ingressId,
                mailboxId: pointer.mailboxId,
                rawSize: String(pointer.rawSize),
                rawSha256: pointer.rawSha256,
                schemaVersion: "1",
              },
            };
          },
          async get(key: string) {
            if (key === "system/reconciliation-cursor.json") return null;
            if (key === `receipts/${pointer.ingressId}.json`) {
              return {
                etag: options.receiptEtag ?? "invalid-receipt-etag",
                async text() {
                  return receiptText(pointer);
                },
              };
            }
            return null;
          },
          async put(key: string, value: string) {
            if (key.startsWith("system/reconciliation-anomalies/")) {
              if (options.anomalyWriteFails)
                throw new Error("simulated anomaly ledger outage");
              if (options.anomalyWriteReturnsNull) return null;
              anomaly = JSON.parse(value);
            } else if (key.startsWith("system/reconciliation-failures/")) {
              if (options.failureLedgerWriteFails)
                throw new Error("simulated failure ledger outage");
              failureLedger = JSON.parse(value);
            } else if (key.startsWith("system/inbound-recovery-pointers/")) {
              recoveryPointerWrites += 1;
            } else if (key.startsWith("receipts/")) {
              receiptWrites += 1;
            } else if (key === "system/reconciliation-cursor.json") {
              cursorPersisted = true;
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
          idFromName() {
            assert.fail("an invalid-present receipt must not trigger reconstruction");
          },
          get() {
            assert.fail("an invalid-present receipt must not read Mailbox truth");
          },
        },
      },
      { now: () => new Date("2026-07-15T10:00:00.000Z") },
    );
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  })();

  return {
    anomaly,
    cursorPersisted,
    failureLedger,
    logs,
    pointer,
    queueCalls,
    receiptWrites,
    recoveryPointerWrites,
    result,
  };
}

test("reconciliation fails closed when a present receipt contains malformed JSON", async () => {
  const fixture = await invalidPresentReceiptFixture(
    () => "not-json-provider-poison",
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.anomaly?.status, "pending_operator_review");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    /not-json-provider-poison/,
  );
});

test("reconciliation fails closed when a present enqueued receipt omits its archive pointer", async () => {
  const fixture = await invalidPresentReceiptFixture(() =>
    JSON.stringify({
      state: "enqueued",
      updatedAt: "2026-07-15T09:00:00.000Z",
    }),
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

test("reconciliation fails closed when a full receipt points at a different raw archive", async () => {
  const fixture = await invalidPresentReceiptFixture((pointer) =>
    JSON.stringify({
      ...pointer,
      rawKey: "raw/2026/07/15/different-private-object.eml",
      state: "enqueued",
      updatedAt: "2026-07-15T09:00:00.000Z",
    }),
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    /different-private-object/,
  );
});

test("reconciliation fails closed when a retrying receipt omits its retry details", async () => {
  const fixture = await invalidPresentReceiptFixture((pointer) =>
    JSON.stringify({
      ...pointer,
      state: "retrying",
      updatedAt: "2026-07-15T09:00:00.000Z",
    }),
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

test("reconciliation fails closed when a full receipt has an invalid update timestamp", async () => {
  const fixture = await invalidPresentReceiptFixture((pointer) =>
    JSON.stringify({
      ...pointer,
      state: "enqueued",
      updatedAt: "not-a-timestamp",
    }),
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

test("reconciliation fails closed when a full receipt has no usable R2 ETag", async () => {
  const fixture = await invalidPresentReceiptFixture(
    (pointer) =>
      JSON.stringify({
        ...pointer,
        state: "enqueued",
        updatedAt: "2026-07-15T09:00:00.000Z",
      }),
    { receiptEtag: "" },
  );

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly?.errorCode, "RECEIPT_STATE_UNKNOWN");
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

test("reconciliation holds its cursor when invalid-receipt evidence and the failure ledger cannot commit", async () => {
  const fixture = await invalidPresentReceiptFixture(
    () => "not-json",
    {
      anomalyWriteReturnsNull: true,
      failureLedgerWriteFails: true,
    },
  );

  assert.equal(fixture.result.pendingReview, 0);
  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.anomaly, undefined);
  assert.equal(fixture.failureLedger, undefined);
  assert.equal(fixture.cursorPersisted, false);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

test("reconciliation advances only after an invalid-receipt evidence failure is durably ledgered", async () => {
  const fixture = await invalidPresentReceiptFixture(
    () => "not-json",
    { anomalyWriteFails: true },
  );

  assert.equal(fixture.result.pendingReview, 0);
  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 1);
  assert.equal(
    fixture.failureLedger?.errorCode,
    "ARCHIVE_RECONCILIATION_FAILED",
  );
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.receiptWrites, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.equal(fixture.queueCalls, 0);
});

async function postAdmissionRereadFixture(input: {
  admissionWriteOutcome: "committed" | "cas_lost";
  anomalyWriteLosesCas?: boolean;
  anomalyWriteFails?: boolean;
  allowAdmittedContinuation?: boolean;
  failureLedgerWriteFails?: boolean;
  ingressId: string;
  refreshedReceiptText: string | null;
}) {
  const ingressId = input.ingressId;
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const mailboxId = "hello@wiserchat.ai";
  let receiptReads = 0;
  let anomaly: Record<string, unknown> | undefined;
  let anomalyReadAfterCasLoss = false;
  let failureLedger: Record<string, unknown> | undefined;
  let failureLedgerDeletes = 0;
  let cursorPersisted = false;
  let recoveryPointerWrites = 0;
  let queueCalls = 0;
  let mailboxTruthReads = 0;
  let enqueueReceiptEtag: string | undefined;
  let admissionWriteCommitted = false;
  const writes: string[] = [];
  const logs: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]) => logs.push(args);
  console.log = capture;
  console.error = capture;
  let result;
  try {
    result = await reconcileInboundArchives(
      {
        DOMAINS: "wiserchat.ai",
        EMAIL_ADDRESSES: [],
        DB: mailboxDb(),
        BUCKET: {
          async head(key: string) {
            assert.equal(key, `mailboxes/${mailboxId}.json`);
            return {};
          },
        },
        RAW_MAIL_BUCKET: {
          async list(options: { prefix: string }) {
            return {
              objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
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
                archivedAt: "2026-07-15T09:00:00.000Z",
                ingressId,
                mailboxId,
                rawSize: "321",
                rawSha256: "a".repeat(64),
                schemaVersion: "1",
              },
            };
          },
          async get(key: string) {
            if (key === "system/reconciliation-cursor.json") return null;
            if (key === `receipts/${ingressId}.json`) {
              receiptReads += 1;
              if (receiptReads === 2) {
                if (input.refreshedReceiptText === null) return null;
                return {
                  etag: "refreshed-receipt-etag",
                  async text() {
                    return input.refreshedReceiptText ?? "";
                  },
                };
              }
              return {
                etag: "archived-receipt-etag",
                async text() {
                  return inboundReceiptBody(
                    {
                      ingressId,
                      rawKey,
                      rawSize: 321,
                      rawSha256: "a".repeat(64),
                      archivedAt: "2026-07-15T09:00:00.000Z",
                    },
                    "archived",
                    "2026-07-15T09:00:00.000Z",
                  );
                },
              };
            }
            if (key.startsWith("system/reconciliation-anomalies/")) {
              if (input.anomalyWriteLosesCas) {
                anomalyReadAfterCasLoss = true;
                return {
                  etag: "concurrent-anomaly-etag",
                  async text() {
                    return JSON.stringify({
                      detectedAt: "2026-07-15T09:59:59.000Z",
                      errorCode: "RECEIPT_STATE_UNKNOWN",
                      ingressId,
                      mailboxId,
                      rawKey,
                      status: "pending_operator_review",
                    });
                  },
                };
              }
              return null;
            }
            return null;
          },
          async put(
            key: string,
            value: string,
            options?: {
              customMetadata?: Record<string, string>;
              onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
            },
          ) {
            if (key === `receipts/${ingressId}.json`) {
              const state = JSON.parse(value).state;
              writes.push(state);
              if (state === "enqueued") {
                enqueueReceiptEtag = options?.onlyIf?.etagMatches;
                return { etag: "enqueued-receipt-etag" };
              }
              assert.equal(state, "admitted");
              assert.equal(options?.onlyIf?.etagMatches, "archived-receipt-etag");
              const result = input.admissionWriteOutcome === "committed"
                ? { etag: "admitted-receipt-etag" }
                : null;
              admissionWriteCommitted = result !== null;
              return result;
            }
            if (key.startsWith("system/reconciliation-anomalies/")) {
              writes.push("anomaly");
              if (input.anomalyWriteFails) {
                throw new Error("simulated post-admission anomaly outage");
              }
              assert.deepEqual(options, {
                customMetadata: {
                  errorCode: "RECEIPT_STATE_UNKNOWN",
                  status: "pending_operator_review",
                },
                onlyIf: { etagDoesNotMatch: "*" },
              });
              if (input.anomalyWriteLosesCas) return null;
              anomaly = JSON.parse(value);
              return { etag: "anomaly-etag" };
            }
            if (key.startsWith("system/reconciliation-failures/")) {
              writes.push("failure-ledger");
              if (input.failureLedgerWriteFails) {
                throw new Error("simulated reconciliation failure-ledger outage");
              }
              failureLedger = JSON.parse(value);
              return { etag: "failure-ledger-etag" };
            }
            if (key.startsWith("system/inbound-recovery-pointers/")) {
              recoveryPointerWrites += 1;
              return { etag: "recovery-pointer-etag" };
            }
            if (key === "system/reconciliation-cursor.json") {
              writes.push("cursor");
              cursorPersisted = true;
              return { etag: "cursor-etag" };
            }
            return {};
          },
          async delete(key: string) {
            if (key.startsWith("system/reconciliation-failures/")) {
              failureLedgerDeletes += 1;
            }
          },
        },
        INBOUND_QUEUE: {
          async send() {
            queueCalls += 1;
          },
        },
        MAILBOX: {
          idFromName() {
            mailboxTruthReads += 1;
            return mailboxId;
          },
          get() {
            mailboxTruthReads += 1;
            if (input.allowAdmittedContinuation) {
              return {
                async getEmail() { return null; },
                async hasEmail() { return false; },
                async isEmailDeleted() { return false; },
                async getInboundTerminalFailure() { return null; },
              };
            }
            throw new Error("receipt uncertainty must not read Mailbox truth");
          },
        },
      },
      { now: () => new Date("2026-07-15T10:00:00.000Z") },
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  return {
    anomaly,
    anomalyReadAfterCasLoss,
    admissionWriteCommitted,
    cursorPersisted,
    failureLedger,
    failureLedgerDeletes,
    ingressId,
    enqueueReceiptEtag,
    logs,
    mailboxId,
    mailboxTruthReads,
    queueCalls,
    rawKey,
    recoveryPointerWrites,
    result,
    writes,
  };
}

function assertPostAdmissionRereadFailedClosed(
  fixture: Awaited<ReturnType<typeof postAdmissionRereadFixture>>,
): void {
  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.deepEqual(fixture.anomaly, {
    detectedAt: "2026-07-15T10:00:00.000Z",
    errorCode: "RECEIPT_STATE_UNKNOWN",
    ingressId: fixture.ingressId,
    mailboxId: fixture.mailboxId,
    rawKey: fixture.rawKey,
    status: "pending_operator_review",
  });
  assert.deepEqual(fixture.writes, ["admitted", "anomaly", "cursor"]);
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    new RegExp(
      `${fixture.ingressId}|${fixture.rawKey}|${fixture.mailboxId}|provider-id-poison`,
    ),
  );
}

test("reconciliation records operator-review evidence when an admitted receipt reread is absent", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    ingressId: "post-admission-absent-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.admissionWriteCommitted, true);
  assertPostAdmissionRereadFailedClosed(fixture);
});

test("reconciliation records operator-review evidence when archived admission loses CAS to an absent winner", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "cas_lost",
    ingressId: "admission-cas-absent-private-ingress",
    refreshedReceiptText: null,
  });

  assertPostAdmissionRereadFailedClosed(fixture);
});

for (const uncertainWinner of [
  {
    name: "invalid",
    body: JSON.stringify({
      state: "admitted",
      updatedAt: "2026-07-15T10:00:00.000Z",
      privatePayload: "provider-id-poison",
    }),
  },
  {
    name: "backward archived",
    body: inboundReceiptBody(
      {
        ingressId: "admission-cas-backward-private-ingress",
        rawKey: "raw/2026/07/15/admission-cas-backward-private-ingress.eml",
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "archived",
      "2026-07-15T10:00:00.000Z",
    ),
  },
]) {
  test(`reconciliation records operator-review evidence when archived admission loses CAS to an ${uncertainWinner.name} winner`, async () => {
    const fixture = await postAdmissionRereadFixture({
      admissionWriteOutcome: "cas_lost",
      ingressId: uncertainWinner.name === "invalid"
        ? "admission-cas-invalid-private-ingress"
        : "admission-cas-backward-private-ingress",
      refreshedReceiptText: uncertainWinner.body,
    });

    assertPostAdmissionRereadFailedClosed(fixture);
  });
}

test("reconciliation continues archived admission CAS loss from a valid admitted winner ETag", async () => {
  const ingressId = "admission-cas-admitted-private-ingress";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "cas_lost",
    allowAdmittedContinuation: true,
    ingressId,
    refreshedReceiptText: inboundReceiptBody(
      {
        ingressId,
        rawKey,
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "admitted",
      "2026-07-15T09:59:00.000Z",
      { reconciled: true },
    ),
  });

  assert.equal(fixture.result.reenqueued, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.queueCalls, 1);
  assert.equal(fixture.enqueueReceiptEtag, "refreshed-receipt-etag");
  assert.deepEqual(fixture.writes, ["admitted", "enqueued", "cursor"]);
});

test("reconciliation records operator-review evidence when an admitted receipt reread is partial", async () => {
  const receiptPayloadPoison = "post-admission-receipt-payload-poison";
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    ingressId: "post-admission-partial-private-ingress",
    refreshedReceiptText: JSON.stringify({
      state: "admitted",
      updatedAt: "2026-07-15T10:00:00.000Z",
      privatePayload: receiptPayloadPoison,
    }),
  });

  assertPostAdmissionRereadFailedClosed(fixture);
  assert.doesNotMatch(JSON.stringify(fixture.logs), new RegExp(receiptPayloadPoison));
});

test("reconciliation records operator-review evidence when an admitted receipt reread regresses to archived", async () => {
  const ingressId = "post-admission-archived-private-ingress";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    ingressId,
    refreshedReceiptText: inboundReceiptBody(
      {
        ingressId,
        rawKey,
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "archived",
      "2026-07-15T10:00:00.000Z",
    ),
  });

  assertPostAdmissionRereadFailedClosed(fixture);
});

test("reconciliation preserves a valid concurrent enqueued winner after admitting an archived receipt", async () => {
  const ingressId = "post-admission-enqueued-private-ingress";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    ingressId,
    refreshedReceiptText: inboundReceiptBody(
      {
        ingressId,
        rawKey,
        rawSize: 321,
        rawSha256: "a".repeat(64),
        archivedAt: "2026-07-15T09:00:00.000Z",
      },
      "enqueued",
      "2026-07-15T10:00:00.000Z",
      { reconciled: true },
    ),
  });

  assert.equal(fixture.result.skipped, 1);
  assert.equal(fixture.result.pendingReview, 0);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly, undefined);
  assert.deepEqual(fixture.writes, ["admitted", "cursor"]);
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
});

test("reconciliation holds the cursor when post-admission receipt evidence and failure-ledger persistence both fail", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    anomalyWriteFails: true,
    failureLedgerWriteFails: true,
    ingressId: "post-admission-unledgered-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.result.pendingReview, 0);
  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly, undefined);
  assert.equal(fixture.failureLedger, undefined);
  assert.deepEqual(fixture.writes, [
    "admitted",
    "anomaly",
    "failure-ledger",
  ]);
  assert.equal(fixture.cursorPersisted, false);
  assert.equal(fixture.failureLedgerDeletes, 0);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    new RegExp(
      `${fixture.ingressId}|${fixture.rawKey}|${fixture.mailboxId}|provider-id-poison|simulated post-admission anomaly outage|simulated reconciliation failure-ledger outage`,
    ),
  );
});

test("reconciliation holds the cursor and prior evidence when CAS-lost admission uncertainty cannot be ledgered", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "cas_lost",
    anomalyWriteFails: true,
    failureLedgerWriteFails: true,
    ingressId: "admission-cas-unledgered-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.cursorPersisted, false);
  assert.equal(fixture.failureLedger, undefined);
  assert.equal(fixture.failureLedgerDeletes, 0);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    /admission-cas-unledgered-private-ingress|provider-id-poison|simulated post-admission anomaly outage|simulated reconciliation failure-ledger outage/,
  );
});

test("reconciliation advances after post-admission receipt evidence failure is durably ledgered", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    anomalyWriteFails: true,
    ingressId: "post-admission-ledgered-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.result.pendingReview, 0);
  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 1);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly, undefined);
  assert.equal(
    fixture.failureLedger?.errorCode,
    "ARCHIVE_RECONCILIATION_FAILED",
  );
  assert.equal(fixture.failureLedger?.rawKey, fixture.rawKey);
  assert.equal(fixture.failureLedgerDeletes, 0);
  assert.deepEqual(fixture.writes, [
    "admitted",
    "anomaly",
    "failure-ledger",
    "cursor",
  ]);
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    new RegExp(
      `${fixture.ingressId}|${fixture.rawKey}|${fixture.mailboxId}|provider-id-poison|simulated post-admission anomaly outage`,
    ),
  );
});

test("reconciliation uses the normal failure ledger for CAS-lost admission uncertainty", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "cas_lost",
    anomalyWriteFails: true,
    ingressId: "admission-cas-ledgered-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.result.failed, 1);
  assert.equal(fixture.result.failureLedgered, 1);
  assert.equal(fixture.failureLedger?.errorCode, "ARCHIVE_RECONCILIATION_FAILED");
  assert.equal(fixture.failureLedger?.rawKey, fixture.rawKey);
  assert.equal(fixture.failureLedgerDeletes, 0);
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
  assert.equal(fixture.recoveryPointerWrites, 0);
  assert.doesNotMatch(
    JSON.stringify(fixture.logs),
    /admission-cas-ledgered-private-ingress|provider-id-poison|simulated post-admission anomaly outage/,
  );
});

test("reconciliation accepts a matching concurrent receipt-state anomaly after losing create-only CAS", async () => {
  const fixture = await postAdmissionRereadFixture({
    admissionWriteOutcome: "committed",
    anomalyWriteLosesCas: true,
    ingressId: "post-admission-anomaly-cas-private-ingress",
    refreshedReceiptText: null,
  });

  assert.equal(fixture.result.pendingReview, 1);
  assert.equal(fixture.result.failed, 0);
  assert.equal(fixture.result.failureLedgered, 0);
  assert.equal(fixture.result.reenqueued, 0);
  assert.equal(fixture.anomaly, undefined);
  assert.equal(fixture.anomalyReadAfterCasLoss, true);
  assert.equal(fixture.failureLedger, undefined);
  assert.deepEqual(fixture.writes, ["admitted", "anomaly", "cursor"]);
  assert.equal(fixture.cursorPersisted, true);
  assert.equal(fixture.queueCalls, 0);
  assert.equal(fixture.mailboxTruthReads, 0);
});

type ExactWinnerBranch =
  | "rejected_admission"
  | "repair_state_deleted"
  | "repair_state_stored"
  | "terminal_ledger_dead_lettered"
  | "handoff_deleted";

async function exactConcurrentWinnerFixture(
  branch: ExactWinnerBranch,
  winner: "exact" | "absent" | "invalid",
) {
  const ingressId = `${branch}-${winner}-private-ingress`;
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  const mailboxId = "hello@wiserchat.ai";
  const targetState = branch === "rejected_admission"
    ? "rejected"
    : branch === "repair_state_stored"
      ? "stored"
      : branch === "terminal_ledger_dead_lettered"
        ? "dead_lettered"
        : "deleted";
  const initialState = branch === "rejected_admission"
    ? "archived"
    : branch === "handoff_deleted"
      ? "stored"
      : branch === "terminal_ledger_dead_lettered"
        ? "dead_letter_pending"
        : "rejected";
  const initialDetails = initialState === "stored"
    ? {}
    : initialState === "rejected"
      ? { errorCode: "MAILBOX_INACTIVE" }
      : initialState === "dead_letter_pending"
        ? {
            attempt: 11,
            delaySeconds: 300,
            errorCode: "RAW_ARCHIVE_READ_FAILED",
          }
        : {};
  const winnerDetails = targetState === "rejected"
    ? { reconciled: true, errorCode: "MAILBOX_INACTIVE" }
    : targetState === "stored"
      ? { reconciled: true, errorCode: "MAILBOX_PROJECTION_RECOVERED" }
      : targetState === "deleted"
        ? { reconciled: true, errorCode: "MAILBOX_PROJECTION_DELETED" }
        : {
            reconciled: true,
            errorCode: "DLQ_TERMINAL_LEDGER_RECOVERED",
            terminalFailure: {
              queueRef: "d06683c38d7755ce",
              attempts: 10,
              errorCode: "QUEUE_RETRY_EXHAUSTED",
              recordedAt: "2026-07-15T09:45:00.000Z",
            },
          };
  let receiptReads = 0;
  let attemptedState: string | undefined;
  let anomaly: Record<string, unknown> | undefined;
  let cursorPersisted = false;
  let queueCalls = 0;
  let recoveryPointerWrites = 0;
  let uncertaintyRecorded = false;
  const downstreamReadsAfterUncertainty: string[] = [];
  const branchReads: string[] = [];
  const logs: unknown[][] = [];
  const markRead = (name: string) => {
    if (uncertaintyRecorded) downstreamReadsAfterUncertainty.push(name);
    branchReads.push(name);
  };
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args: unknown[]) => logs.push(args);
  console.log = capture;
  console.error = capture;
  let result;
  try {
    result = await reconcileInboundArchives({
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(branch === "rejected_admission" ? "inactive" : "active"),
      BUCKET: derivedBucketWithoutDelete,
      RAW_MAIL_BUCKET: {
        async list(options: { prefix: string }) {
          return {
            objects: options.prefix === "raw/" ? [{ key: rawKey }] : [],
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
              archivedAt: "2026-07-15T09:00:00.000Z",
              ingressId,
              mailboxId,
              rawSize: "321",
              schemaVersion: "1",
            },
          };
        },
        async get(key: string) {
          if (key === "system/reconciliation-cursor.json") return null;
          if (key.startsWith("system/reconciliation-anomalies/")) return null;
          if (key === `receipts/${ingressId}.json`) {
            receiptReads += 1;
            if (receiptReads === 1) {
              return {
                etag: "initial-receipt-etag",
                async text() {
                  return inboundReceiptBody(
                    { ingressId, rawKey, rawSize: 321, archivedAt: "2026-07-15T09:00:00.000Z" },
                    initialState,
                    "2026-07-15T09:00:00.000Z",
                    initialDetails,
                  );
                },
              };
            }
            if (winner === "absent") return null;
            return {
              etag: "winner-receipt-etag",
              async text() {
                return winner === "invalid"
                  ? JSON.stringify({ state: targetState, privatePayload: "provider-id-poison" })
                  : inboundReceiptBody(
                      { ingressId, rawKey, rawSize: 321, archivedAt: "2026-07-15T09:00:00.000Z" },
                      targetState,
                      "2026-07-15T09:59:00.000Z",
                      winnerDetails,
                    );
              },
            };
          }
          return null;
        },
        async put(key: string, value: string) {
          if (key === `receipts/${ingressId}.json`) {
            attemptedState = JSON.parse(value).state;
            return null;
          }
          if (key.startsWith("system/reconciliation-anomalies/")) {
            anomaly = JSON.parse(value);
            uncertaintyRecorded = true;
            return { etag: "anomaly-etag" };
          }
          if (key.startsWith("system/inbound-recovery-pointers/")) {
            recoveryPointerWrites += 1;
            return {};
          }
          if (key === "system/reconciliation-cursor.json") {
            cursorPersisted = true;
            return {};
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
        idFromName(value: string) {
          markRead("mailbox_binding");
          return value;
        },
        get() {
          markRead("mailbox_stub");
          return {
            async isEmailDeleted() {
              markRead("deleted");
              return branch === "repair_state_deleted" || branch === "handoff_deleted";
            },
            async hasEmail() {
              markRead("stored");
              return branch === "repair_state_stored";
            },
            async getEmail() {
              markRead("get_email");
              return null;
            },
            async getInboundTerminalFailure() {
              markRead("terminal");
              return branch === "terminal_ledger_dead_lettered"
                ? {
                    queueRef: "d06683c38d7755ce",
                    attempts: 10,
                    errorCode: "QUEUE_RETRY_EXHAUSTED",
                    recordedAt: "2026-07-15T09:45:00.000Z",
                  }
                : null;
            },
          };
        },
      },
    }, { now: () => new Date("2026-07-15T10:00:00.000Z") });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return {
    anomaly,
    attemptedState,
    branchReads,
    cursorPersisted,
    downstreamReadsAfterUncertainty,
    ingressId,
    logs,
    mailboxId,
    queueCalls,
    rawKey,
    recoveryPointerWrites,
    result,
    targetState,
  };
}

for (const branch of [
  "rejected_admission",
  "repair_state_deleted",
  "repair_state_stored",
  "terminal_ledger_dead_lettered",
  "handoff_deleted",
] satisfies ExactWinnerBranch[]) {
  const expectedBranchReads: Record<ExactWinnerBranch, string[]> = {
    rejected_admission: [],
    repair_state_deleted: ["mailbox_binding", "mailbox_stub", "deleted"],
    repair_state_stored: [
      "mailbox_binding",
      "mailbox_stub",
      "deleted",
      "stored",
    ],
    terminal_ledger_dead_lettered: [
      "mailbox_binding",
      "mailbox_stub",
      "deleted",
      "stored",
      "terminal",
    ],
    handoff_deleted: ["mailbox_binding", "mailbox_stub", "deleted"],
  };
  test(`reconciliation preserves an exact ${branch} concurrent receipt winner`, async () => {
    const fixture = await exactConcurrentWinnerFixture(branch, "exact");
    assert.equal(fixture.attemptedState, fixture.targetState);
    assert.deepEqual(fixture.branchReads, expectedBranchReads[branch]);
    assert.equal(fixture.result.skipped, 1);
    assert.equal(fixture.result.pendingReview, 0);
    assert.equal(fixture.anomaly, undefined);
    assert.equal(fixture.queueCalls, 0);
  });

  for (const winner of ["absent", "invalid"] as const) {
    test(`reconciliation records uncertainty for a ${winner} ${branch} concurrent receipt winner`, async () => {
      const fixture = await exactConcurrentWinnerFixture(branch, winner);
      assert.equal(fixture.attemptedState, fixture.targetState);
      assert.deepEqual(fixture.branchReads, expectedBranchReads[branch]);
      assert.equal(fixture.result.pendingReview, 1);
      assert.equal(fixture.result.skipped, 0);
      assert.deepEqual(fixture.anomaly, {
        detectedAt: "2026-07-15T10:00:00.000Z",
        errorCode: "RECEIPT_STATE_UNKNOWN",
        ingressId: fixture.ingressId,
        mailboxId: fixture.mailboxId,
        rawKey: fixture.rawKey,
        status: "pending_operator_review",
      });
      assert.equal(fixture.cursorPersisted, true);
      assert.equal(fixture.queueCalls, 0);
      assert.equal(fixture.recoveryPointerWrites, 0);
      assert.deepEqual(fixture.downstreamReadsAfterUncertainty, []);
      assert.doesNotMatch(
        JSON.stringify(fixture.logs),
        new RegExp(`${fixture.ingressId}|${fixture.rawKey}|${fixture.mailboxId}|provider-id-poison`),
      );
    });
  }
}

test("reconciliation accepts the full rejected receipt written by inbound SMTP rejection", async () => {
  const ingressId = "legitimate-inbound-rejection";
  const rawKey = `raw/2026/07/15/${ingressId}.eml`;
  let anomalyWrites = 0;
  let queueCalls = 0;
  let receiptReads = 0;
  const env = {
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
            archivedAt: "2026-07-15T09:00:00.000Z",
            ingressId,
            mailboxId: "hello@wiserchat.ai",
            rawSize: "321",
            schemaVersion: "1",
          },
        };
      },
      async get(key: string) {
        if (
          key === "system/reconciliation-cursor.json" ||
          key.startsWith("system/reconciliation-anomalies/")
        ) {
          return null;
        }
        assert.equal(key, `receipts/${ingressId}.json`);
        return {
          etag: "rejected-receipt-etag",
          async text() {
            return inboundReceiptBody(
              {
                ingressId,
                rawKey,
                rawSize: 321,
                archivedAt: "2026-07-15T09:00:00.000Z",
              },
              "rejected",
              "2026-07-15T09:01:00.000Z",
            );
          },
        };
      },
      async put(key: string) {
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
            assert.fail("hasEmail is the available projection truth seam");
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
    now: () => new Date("2026-07-15T10:00:00.000Z"),
  });

  assert.equal(result.skipped, 1);
  assert.equal(result.pendingReview, 0);
  assert.equal(result.failed, 0);
  assert.equal(anomalyWrites, 0);
  assert.equal(queueCalls, 0);
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
            const receipt = JSON.parse(
              inboundReceiptBody(
                {
                  ingressId: "unknown-state",
                  rawKey,
                  rawSize: 123,
                  archivedAt: "2026-07-13T09:00:00.000Z",
                },
                "stored",
                "2026-07-13T09:00:00.000Z",
              ),
            );
            return JSON.stringify({
              ...receipt,
              state: { privatePayload: "poison" },
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

test("reconciliation preserves dead-letter handoffs while repairing stale and archived states", async () => {
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
    {
      state: string;
      updatedAt: string;
      attempt?: number;
      delaySeconds?: number;
      errorCode?: string;
    }
  > = {
    stored: { state: "stored", updatedAt: "2026-07-13T09:00:00.000Z" },
    recent: { state: "enqueued", updatedAt: "2026-07-13T09:55:00.000Z" },
    stale: { state: "enqueued", updatedAt: "2026-07-13T09:30:00.000Z" },
    archived: { state: "archived", updatedAt: "2026-07-13T09:59:00.000Z" },
    admitted: { state: "admitted", updatedAt: "2026-07-13T09:59:00.000Z" },
    "dead-letter-recent": {
      state: "dead_letter_pending",
      updatedAt: "2026-07-13T09:55:00.000Z",
      attempt: 11,
      delaySeconds: 300,
      errorCode: "RAW_ARCHIVE_READ_FAILED",
    },
    "dead-letter-stale": {
      state: "dead_letter_pending",
      updatedAt: "2026-07-13T09:30:00.000Z",
      attempt: 11,
      delaySeconds: 300,
      errorCode: "RAW_ARCHIVE_READ_FAILED",
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
                const { state, updatedAt, ...details } = receipt;
                return inboundReceiptBody(
                  {
                    ingressId,
                    rawKey: `raw/2026/07/13/${ingressId}.eml`,
                    rawSize: 123,
                    archivedAt: "2026-07-13T09:00:00.000Z",
                  },
                  state,
                  updatedAt,
                  details,
                );
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
    pendingReview: 1,
    terminalized: 0,
    failureLedgered: 0,
  });
  assert.equal(states["dead-letter-stale"].state, "dead_letter_pending");
  assert.equal(
    states["dead-letter-stale"].errorCode,
    "RAW_ARCHIVE_READ_FAILED",
  );
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
              return inboundReceiptBody(
                {
                  ingressId,
                  rawKey,
                  rawSize: 123,
                  archivedAt: "2026-07-15T09:00:00.000Z",
                },
                "archived",
                "2026-07-15T09:00:00.000Z",
              );
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
            return inboundReceiptBody(
              {
                ingressId,
                rawKey,
                rawSize: 123,
                archivedAt: "2026-07-15T09:00:00.000Z",
              },
              "archived",
              "2026-07-15T09:00:00.000Z",
            );
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
  const receiptVariants: Record<
    string,
    { state: string; details: Record<string, unknown> }
  > = {
    "pending-but-stored": {
      state: "dead_letter_pending",
      details: {
        attempt: 11,
        delaySeconds: 300,
        errorCode: "RAW_ARCHIVE_READ_FAILED",
      },
    },
    "terminal-but-stored": {
      state: "dead_lettered",
      details: { errorCode: "QUEUE_RETRY_EXHAUSTED" },
    },
    "quarantined-but-stored": {
      state: "quarantined",
      details: { errorCode: "MAILBOX_UNAVAILABLE" },
    },
    "rejected-but-stored": {
      state: "rejected",
      details: { errorCode: "MAILBOX_INACTIVE" },
    },
    "stored-and-stored": { state: "stored", details: {} },
  };
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
            const variant = receiptVariants[ingressId];
            return inboundReceiptBody(
              {
                ingressId,
                rawKey: `raw/2026/07/13/${ingressId}.eml`,
                rawSize: 321,
                archivedAt: "2026-07-13T09:00:00.000Z",
              },
              variant.state,
              "2026-07-13T09:00:00.000Z",
              variant.details,
            );
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
            return inboundReceiptBody(
              {
                ingressId,
                rawKey,
                rawSize: 321,
                archivedAt: "2026-07-13T09:00:00.000Z",
              },
              "dead_lettered",
              "2026-07-13T09:00:00.000Z",
              { errorCode: "QUEUE_RETRY_EXHAUSTED" },
            );
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
                return inboundReceiptBody(
                  {
                    ingressId,
                    rawKey,
                    rawSize: 321,
                    archivedAt: "2026-07-13T09:00:00.000Z",
                  },
                  "dead_lettered",
                  "2026-07-13T09:00:00.000Z",
                  { errorCode: "QUEUE_RETRY_EXHAUSTED" },
                );
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
            return inboundReceiptBody(
              {
                ingressId,
                rawKey,
                rawSize: 321,
                archivedAt: "2026-07-13T09:00:00.000Z",
              },
              "dead_lettered",
              "2026-07-13T09:45:00.000Z",
              { errorCode: "QUEUE_RETRY_EXHAUSTED" },
            );
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

test("reconciliation creates operator-review evidence for a fresh stale dead-letter intent without a Mailbox terminal ledger", async () => {
  const ingressId = "stale-dead-letter-without-ledger";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let receipt: Record<string, unknown> = JSON.parse(
    inboundReceiptBody(
      {
        ingressId,
        rawKey,
        rawSize: 321,
        archivedAt: "2026-07-13T09:00:00.000Z",
      },
      "dead_letter_pending",
      "2026-07-13T09:00:00.000Z",
      {
        attempt: 11,
        delaySeconds: 300,
        errorCode: "RAW_ARCHIVE_READ_FAILED",
      },
    ),
  );
  let anomaly: Record<string, unknown> | undefined;
  let anomalyCreateCondition: string | undefined;
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
          if (!anomaly) return null;
          return {
            etag: "anomaly-etag",
            async text() {
              return JSON.stringify(anomaly);
            },
          };
        }
        if (key === `receipts/${ingressId}.json`) {
          return {
            etag: "stale-receipt-etag",
            async text() {
              return JSON.stringify(receipt);
            },
          };
        }
        return null;
      },
      async put(
        key: string,
        value: string,
        options?: {
          onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
        },
      ) {
        if (key === `receipts/${ingressId}.json`) {
          receipt = JSON.parse(value);
        }
        if (key.startsWith("system/reconciliation-anomalies/")) {
          anomaly = JSON.parse(value);
          anomalyCreateCondition = options?.onlyIf?.etagDoesNotMatch;
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

  assert.equal(result.terminalized, 0);
  assert.equal(result.pendingReview, 1);
  assert.equal(receipt.state, "dead_letter_pending");
  assert.equal(receipt.attempt, 11);
  assert.equal(receipt.delaySeconds, 300);
  assert.equal(receipt.errorCode, "RAW_ARCHIVE_READ_FAILED");
  assert.equal(receipt.updatedAt, "2026-07-13T09:00:00.000Z");
  assert.deepEqual(anomaly, {
    detectedAt: "2026-07-13T10:00:00.000Z",
    errorCode: "DLQ_TERMINAL_LEDGER_MISSING",
    ingressId,
    mailboxId: "hello@wiserchat.ai",
    rawKey,
    status: "pending_operator_review",
  });
  assert.equal(anomalyCreateCondition, "*");
  assert.equal(queueCalls, 0);
});

test("reconciliation preserves the concurrent winner when Mailbox-ledger reconstruction loses CAS", async () => {
  const ingressId = "stale-dead-letter-cas-loss";
  const rawKey = `raw/2026/07/13/${ingressId}.eml`;
  let receiptWrites = 0;
  let receiptCondition: string | undefined;
  let anomalyWrites = 0;
  let queueCalls = 0;
  let receiptReads = 0;
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
          receiptReads += 1;
          return {
            etag: receiptReads === 1 ? "stale-receipt-etag" : "winner-receipt-etag",
            async text() {
              return inboundReceiptBody(
                {
                  ingressId,
                  rawKey,
                  rawSize: 321,
                  archivedAt: "2026-07-13T09:00:00.000Z",
                },
                receiptReads === 1 ? "dead_letter_pending" : "dead_lettered",
                receiptReads === 1
                  ? "2026-07-13T09:00:00.000Z"
                  : "2026-07-13T09:59:00.000Z",
                receiptReads === 1
                  ? {
                      attempt: 11,
                      delaySeconds: 300,
                      errorCode: "RAW_ARCHIVE_READ_FAILED",
                    }
                  : {
                      reconciled: true,
                      errorCode: "DLQ_TERMINAL_LEDGER_RECOVERED",
                      terminalFailure: {
                        queueRef: "d06683c38d7755ce",
                        attempts: 10,
                        errorCode: "QUEUE_RETRY_EXHAUSTED",
                        recordedAt: "2026-07-13T09:45:00.000Z",
                      },
                    },
              );
            },
          };
        }
        return null;
      },
      async put(
        key: string,
        _value: string,
        options?: { onlyIf?: { etagMatches?: string } },
      ) {
        if (key === `receipts/${ingressId}.json`) {
          receiptWrites += 1;
          receiptCondition = options?.onlyIf?.etagMatches;
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
            return {
              queueRef: "d06683c38d7755ce",
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

  assert.equal(result.skipped, 1);
  assert.equal(result.terminalized, 0);
  assert.equal(receiptWrites, 1);
  assert.equal(receiptCondition, "stale-receipt-etag");
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
            return inboundReceiptBody(
              {
                ingressId,
                rawKey,
                rawSize: 321,
                archivedAt: "2026-07-13T09:00:00.000Z",
              },
              "dead_letter_pending",
              "2026-07-13T09:00:00.000Z",
              {
                attempt: 11,
                delaySeconds: 300,
                errorCode: "RAW_ARCHIVE_READ_FAILED",
              },
            );
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
          limit: 1,
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
            return inboundReceiptBody(
              {
                ingressId: "stored-but-missing",
                rawKey,
                rawSize: 123,
                archivedAt: "2026-07-13T09:00:00.000Z",
              },
              "stored",
              "2026-07-13T09:01:00.000Z",
            );
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

test("active inbound recovery is reconciled before retained terminal raw history", async () => {
  const activeIngressId = "active-orphan";
  const activeRawKey = `raw/2026/07/16/${activeIngressId}.eml`;
  const terminalIngressId = "terminal-history";
  const terminalRawKey = `raw/2026/01/01/${terminalIngressId}.eml`;
  const activeMarkerKey =
    `system/inbound-active/${encodeURIComponent(activeRawKey)}.json`;
  const queued: InboundArchivePointer[] = [];

  const archive = (rawKey: string, ingressId: string) => ({
    key: rawKey,
    size: 321,
    etag: `${ingressId}-etag`,
    version: `${ingressId}-version`,
    customMetadata: {
      archivedAt:
        ingressId === activeIngressId
          ? "2026-07-16T09:55:00.000Z"
          : "2026-01-01T00:00:00.000Z",
      ingressId,
      mailboxId: "hello@wiserchat.ai",
      rawSize: "321",
      schemaVersion: "1",
    },
  });

  await reconcileInboundArchives(
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
        async list(options: { prefix: string }) {
          if (options.prefix === "system/inbound-active/") {
            return { objects: [{ key: activeMarkerKey }], truncated: false };
          }
          if (options.prefix === "raw/") {
            return { objects: [{ key: terminalRawKey }], truncated: false };
          }
          return { objects: [], truncated: false };
        },
        async head(key: string) {
          if (key === activeRawKey) return archive(activeRawKey, activeIngressId);
          if (key === terminalRawKey) {
            return archive(terminalRawKey, terminalIngressId);
          }
          if (key === `receipts/${activeIngressId}.json`) {
            return {
              etag: "active-enqueued-etag",
              customMetadata: { state: "enqueued" },
            };
          }
          return null;
        },
        async get(key: string) {
          if (
            key === "system/reconciliation-cursor.json" ||
            key === "system/inbound-active-cursor.json"
          ) return null;
          if (key === `receipts/${activeIngressId}.json`) {
            return {
              etag: "active-receipt-etag",
              async text() {
                return inboundReceiptBody(
                  {
                    ingressId: activeIngressId,
                    rawKey: activeRawKey,
                    rawSize: 321,
                    archivedAt: "2026-07-16T09:55:00.000Z",
                    etag: `${activeIngressId}-etag`,
                    version: `${activeIngressId}-version`,
                  },
                  "admitted",
                  "2026-07-16T09:55:00.000Z",
                );
              },
            };
          }
          if (key === `receipts/${terminalIngressId}.json`) {
            return {
              etag: "terminal-receipt-etag",
              async text() {
                return inboundReceiptBody(
                  {
                    ingressId: terminalIngressId,
                    rawKey: terminalRawKey,
                    rawSize: 321,
                    archivedAt: "2026-01-01T00:00:00.000Z",
                    etag: `${terminalIngressId}-etag`,
                    version: `${terminalIngressId}-version`,
                  },
                  "rejected",
                  "2026-01-01T00:00:00.000Z",
                  { errorCode: "MAILBOX_INACTIVE" },
                );
              },
            };
          }
          return null;
        },
        async put() {
          return { etag: "written-etag" };
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
            async isEmailDeleted() {
              return false;
            },
            async getInboundTerminalFailure() {
              return null;
            },
          };
        },
      },
    },
    { now: () => new Date("2026-07-16T10:00:00.000Z") },
  );

  assert.deepEqual(
    queued.map((pointer) => pointer.ingressId),
    [activeIngressId],
  );
});

test("a minute-partitioned raw archive without a marker is discovered behind retained terminal history", async () => {
  const orphanIngressId = "marker-crash-gap";
  const orphanRawKey =
    `raw/2026/07/16/09/57/${orphanIngressId}.eml`;
  const terminalIngressId = "retained-terminal-history";
  const terminalRawKey = `raw/2026/01/01/${terminalIngressId}.eml`;
  const markerKey =
    `system/inbound-active/${encodeURIComponent(orphanRawKey)}.json`;
  const writtenKeys: string[] = [];

  await reconcileInboundArchives(
    {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [],
      DB: mailboxDb(),
      BUCKET: derivedBucketWithoutDelete,
      RAW_MAIL_BUCKET: {
        async list(options: {
          prefix: string;
          limit: number;
          cursor?: string;
        }) {
          if (options.prefix === "raw/2026/07/16/09/57/") {
            assert.equal(options.cursor, undefined);
            return { objects: [{ key: orphanRawKey }], truncated: false };
          }
          if (options.prefix === "raw/") {
            return { objects: [{ key: terminalRawKey }], truncated: false };
          }
          return { objects: [], truncated: false };
        },
        async head(key: string) {
          if (key === `receipts/${orphanIngressId}.json`) return null;
          if (key === terminalRawKey) {
            return {
              key: terminalRawKey,
              size: 321,
              etag: "terminal-archive-etag",
              version: "terminal-archive-version",
              customMetadata: {
                archivedAt: "2026-01-01T00:00:00.000Z",
                ingressId: terminalIngressId,
                mailboxId: "hello@wiserchat.ai",
                rawSize: "321",
                schemaVersion: "1",
              },
            };
          }
          return null;
        },
        async get(key: string) {
          if (key === "system/inbound-recent-cursor.json") {
            return {
              etag: "recent-cursor-etag",
              async text() {
                return JSON.stringify({
                  minute: "2026-07-16T09:57:00.000Z",
                  cursor: null,
                  updatedAt: "2026-07-16T09:56:00.000Z",
                });
              },
            };
          }
          if (
            key === "system/inbound-active-cursor.json" ||
            key === "system/reconciliation-cursor.json"
          ) return null;
          if (key === `receipts/${terminalIngressId}.json`) {
            return {
              etag: "terminal-receipt-etag",
              async text() {
                return inboundReceiptBody(
                  {
                    ingressId: terminalIngressId,
                    rawKey: terminalRawKey,
                    rawSize: 321,
                    archivedAt: "2026-01-01T00:00:00.000Z",
                    etag: "terminal-archive-etag",
                    version: "terminal-archive-version",
                  },
                  "rejected",
                  "2026-01-01T00:00:00.000Z",
                  { errorCode: "MAILBOX_INACTIVE" },
                );
              },
            };
          }
          return null;
        },
        async put(key: string) {
          writtenKeys.push(key);
          return { etag: "written-etag" };
        },
        async delete() {},
      },
      INBOUND_QUEUE: {
        async send() {
          throw new Error("terminal history must not enqueue");
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
          };
        },
      },
    },
    { now: () => new Date("2026-07-16T10:00:00.000Z") },
  );

  assert.ok(writtenKeys.includes(markerKey));
});

test("recent raw discovery crosses closed UTC minute boundaries without skipping either partition", async () => {
  const rawKeys = [
    "raw/2026/07/16/09/59/rollover-before.eml",
    "raw/2026/07/16/10/00/rollover-after.eml",
  ];
  const markerKeys: string[] = [];
  let persistedCursor: Record<string, unknown> | undefined;

  await reconcileInboundArchives(
    {
      DOMAINS: "wiserchat.ai",
      DB: mailboxDb(),
      BUCKET: derivedBucketWithoutDelete,
      RAW_MAIL_BUCKET: {
        async list(options: { prefix: string }) {
          if (options.prefix === "raw/2026/07/16/09/59/") {
            return { objects: [{ key: rawKeys[0] }], truncated: false };
          }
          if (options.prefix === "raw/2026/07/16/10/00/") {
            return { objects: [{ key: rawKeys[1] }], truncated: false };
          }
          return { objects: [], truncated: false };
        },
        async head() {
          return null;
        },
        async get(key: string) {
          if (key === "system/inbound-recent-cursor.json") {
            return {
              etag: "recent-cursor-etag",
              async text() {
                return JSON.stringify({
                  minute: "2026-07-16T09:59:00.000Z",
                  cursor: null,
                  updatedAt: "2026-07-16T09:58:00.000Z",
                });
              },
            };
          }
          return null;
        },
        async put(key: string, value: string) {
          if (key.startsWith("system/inbound-active/")) markerKeys.push(key);
          if (key === "system/inbound-recent-cursor.json") {
            persistedCursor = JSON.parse(value);
          }
          return { etag: "written-etag" };
        },
        async delete() {},
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return { async getEmail() { return null; } };
        },
      },
    },
    { now: () => new Date("2026-07-16T10:01:30.000Z") },
  );

  assert.deepEqual(
    markerKeys,
    rawKeys.map(
      (rawKey) =>
        `system/inbound-active/${encodeURIComponent(rawKey)}.json`,
    ),
  );
  assert.deepEqual(persistedCursor, {
    minute: "2026-07-16T10:01:00.000Z",
    cursor: null,
    updatedAt: "2026-07-16T10:01:30.000Z",
  });
});

test("recent raw discovery resumes a truncated minute until more than 128 archives are indexed", async () => {
  const rawKeys = Array.from(
    { length: 129 },
    (_, index) =>
      `raw/2026/07/16/09/57/recent-${String(index).padStart(3, "0")}.eml`,
  );
  const markerKeys = new Set<string>();
  let cursorValue = JSON.stringify({
    minute: "2026-07-16T09:57:00.000Z",
    cursor: null,
    updatedAt: "2026-07-16T09:56:00.000Z",
  });
  let cursorEtag = "recent-cursor-0";
  let recentLists = 0;

  const env = {
    DOMAINS: "wiserchat.ai",
    DB: mailboxDb(),
    BUCKET: derivedBucketWithoutDelete,
    RAW_MAIL_BUCKET: {
      async list(options: {
        prefix: string;
        limit: number;
        cursor?: string;
      }) {
        if (options.prefix === "raw/2026/07/16/09/57/") {
          recentLists += 1;
          assert.equal(options.limit, 128);
          if (!options.cursor) {
            return {
              objects: rawKeys.slice(0, 128).map((key) => ({ key })),
              truncated: true,
              cursor: "after-128",
            };
          }
          assert.equal(options.cursor, "after-128");
          return { objects: [{ key: rawKeys[128] }], truncated: false };
        }
        return { objects: [], truncated: false };
      },
      async head() {
        return null;
      },
      async get(key: string) {
        if (key === "system/inbound-recent-cursor.json") {
          return {
            etag: cursorEtag,
            async text() {
              return cursorValue;
            },
          };
        }
        return null;
      },
      async put(key: string, value: string) {
        if (key.startsWith("system/inbound-active/")) markerKeys.add(key);
        if (key === "system/inbound-recent-cursor.json") {
          cursorValue = value;
          cursorEtag = `recent-cursor-${recentLists}`;
        }
        return { etag: cursorEtag };
      },
      async delete() {},
    },
    INBOUND_QUEUE: { async send() {} },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return { async getEmail() { return null; } };
      },
    },
  };
  const runtime = { now: () => new Date("2026-07-16T10:00:00.000Z") };

  await reconcileInboundArchives(env, runtime);
  assert.deepEqual(JSON.parse(cursorValue), {
    minute: "2026-07-16T09:57:00.000Z",
    cursor: "after-128",
    updatedAt: "2026-07-16T10:00:00.000Z",
  });
  assert.equal(markerKeys.size, 128);

  await reconcileInboundArchives(env, runtime);
  assert.deepEqual(JSON.parse(cursorValue), {
    minute: "2026-07-16T10:00:00.000Z",
    cursor: null,
    updatedAt: "2026-07-16T10:00:00.000Z",
  });
  assert.equal(markerKeys.size, 129);
});

test("recent raw discovery holds its checkpoint when candidate evidence cannot be read or indexed", async () => {
  for (const failure of ["receipt_head", "marker_write"]) {
    const ingressId = `recent-${failure}`;
    const rawKey = `raw/2026/07/16/09/57/${ingressId}.eml`;
    let recentCursorWrites = 0;

    await reconcileInboundArchives(
      {
        DOMAINS: "wiserchat.ai",
        DB: mailboxDb(),
        BUCKET: derivedBucketWithoutDelete,
        RAW_MAIL_BUCKET: {
          async list(options: { prefix: string }) {
            return {
              objects:
                options.prefix === "raw/2026/07/16/09/57/"
                  ? [{ key: rawKey }]
                  : [],
              truncated: false,
            };
          },
          async head(key: string) {
            if (
              key === `receipts/${ingressId}.json` &&
              failure === "receipt_head"
            ) {
              throw new Error("simulated receipt HEAD outage");
            }
            return null;
          },
          async get(key: string) {
            if (key === "system/inbound-recent-cursor.json") {
              return {
                etag: "recent-cursor-etag",
                async text() {
                  return JSON.stringify({
                    minute: "2026-07-16T09:57:00.000Z",
                    cursor: null,
                    updatedAt: "2026-07-16T09:56:00.000Z",
                  });
                },
              };
            }
            if (key === "system/inbound-recent-backstop-cursor.json") {
              return {
                etag: "backstop-cursor-etag",
                async text() {
                  return JSON.stringify({
                    minute: "2026-07-16T10:00:00.000Z",
                    cursor: null,
                    updatedAt: "2026-07-16T09:59:00.000Z",
                  });
                },
              };
            }
            return null;
          },
          async put(key: string) {
            if (
              key.startsWith("system/inbound-active/") &&
              failure === "marker_write"
            ) {
              throw new Error("simulated active marker outage");
            }
            if (key === "system/inbound-recent-cursor.json") {
              recentCursorWrites += 1;
            }
            return { etag: "written-etag" };
          },
          async delete() {},
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return { async getEmail() { return null; } };
          },
        },
      },
      { now: () => new Date("2026-07-16T10:00:00.000Z") },
    );

    assert.equal(recentCursorWrites, 0, failure);
  }
});

test("the first recent sweep covers the rollout propagation window in one run", async () => {
  const ingressId = "first-deploy-gap";
  const rawKey = `raw/2026/07/16/09/00/${ingressId}.eml`;
  const prefixes: string[] = [];
  let markerWritten = false;

  await reconcileInboundArchives(
    {
      DOMAINS: "wiserchat.ai",
      DB: mailboxDb(),
      BUCKET: derivedBucketWithoutDelete,
      RAW_MAIL_BUCKET: {
        async list(options: { prefix: string }) {
          if (/^raw\/\d{4}\//.test(options.prefix) && options.prefix !== "raw/") {
            prefixes.push(options.prefix);
          }
          return {
            objects:
              options.prefix === "raw/2026/07/16/09/00/"
                ? [{ key: rawKey }]
                : [],
            truncated: false,
          };
        },
        async head() {
          return null;
        },
        async get(key: string) {
          if (key === "system/inbound-recent-backstop-cursor.json") {
            return {
              etag: "backstop-cursor-etag",
              async text() {
                return JSON.stringify({
                  minute: "2026-07-16T10:00:00.000Z",
                  cursor: null,
                  updatedAt: "2026-07-16T09:59:00.000Z",
                });
              },
            };
          }
          return null;
        },
        async put(key: string) {
          if (
            key ===
            `system/inbound-active/${encodeURIComponent(rawKey)}.json`
          ) {
            markerWritten = true;
          }
          return { etag: "written-etag" };
        },
        async delete() {},
      },
      INBOUND_QUEUE: { async send() {} },
      MAILBOX: {
        idFromName(mailboxId: string) {
          return mailboxId;
        },
        get() {
          return { async getEmail() { return null; } };
        },
      },
    },
    { now: () => new Date("2026-07-16T10:00:30.000Z") },
  );

  assert.equal(prefixes[0], "raw/2026/07/16/09/00/");
  assert.equal(prefixes.at(-1), "raw/2026/07/16/09/59/");
  assert.equal(prefixes.length, 60);
  assert.equal(markerWritten, true);
});

test("a future recent cursor degrades visibly without listing or replacing its checkpoint", async () => {
  let recentLists = 0;
  let recentCursorWrites = 0;
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };

  try {
    await reconcileInboundArchives(
      {
        DOMAINS: "wiserchat.ai",
        DB: mailboxDb(),
        BUCKET: derivedBucketWithoutDelete,
        RAW_MAIL_BUCKET: {
          async list(options: { prefix: string }) {
            if (/^raw\/\d{4}\//.test(options.prefix)) recentLists += 1;
            return { objects: [], truncated: false };
          },
          async head() {
            return null;
          },
          async get(key: string) {
            if (key === "system/inbound-recent-cursor.json") {
              return {
                etag: "future-cursor-etag",
                async text() {
                  return JSON.stringify({
                    minute: "2026-07-16T10:01:00.000Z",
                    cursor: null,
                    updatedAt: "2026-07-16T09:59:00.000Z",
                  });
                },
              };
            }
            if (key === "system/inbound-recent-backstop-cursor.json") {
              return {
                etag: "backstop-cursor-etag",
                async text() {
                  return JSON.stringify({
                    minute: "2026-07-16T10:00:00.000Z",
                    cursor: null,
                    updatedAt: "2026-07-16T09:59:00.000Z",
                  });
                },
              };
            }
            return null;
          },
          async put(key: string) {
            if (key === "system/inbound-recent-cursor.json") {
              recentCursorWrites += 1;
            }
            return { etag: "written-etag" };
          },
          async delete() {},
        },
        INBOUND_QUEUE: { async send() {} },
        MAILBOX: {
          idFromName(mailboxId: string) {
            return mailboxId;
          },
          get() {
            return { async getEmail() { return null; } };
          },
        },
      },
      { now: () => new Date("2026-07-16T10:00:30.000Z") },
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(recentLists, 0);
  assert.equal(recentCursorWrites, 0);
  assert.deepEqual(
    logs.find(
      (args) =>
        args[0] === "[mail-reconciliation] recent raw sweep degraded",
    ),
    [
      "[mail-reconciliation] recent raw sweep degraded",
      {
        errorCode: "RECENT_RAW_SWEEP_FAILED",
        operation: "recent_raw_reconcile",
        status: "degraded",
      },
    ],
  );
});

test("the fixed recent backstop discovers an archive after it ages out of an uninitialized priority window", async () => {
  const ingressId = "aged-marker-outage";
  const rawKey = `raw/2026/07/16/00/00/${ingressId}.eml`;
  const markerKey =
    `system/inbound-active/${encodeURIComponent(rawKey)}.json`;
  let backstopCursorValue = JSON.stringify({
    minute: "2026-07-16T00:00:00.000Z",
    cursor: null,
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  let backstopCursorEtag = "backstop-cursor-0";
  let markerAvailable = false;
  let markerAttempts = 0;
  let markerWritten = false;
  let priorityCursorValue: string | undefined;
  let priorityCursorEtag: string | undefined;
  let now = new Date("2026-07-16T01:00:00.000Z");

  const env = {
    DOMAINS: "wiserchat.ai",
    DB: mailboxDb(),
    BUCKET: derivedBucketWithoutDelete,
    RAW_MAIL_BUCKET: {
      async list(options: { prefix: string }) {
        return {
          objects:
            options.prefix === "raw/2026/07/16/00/00/"
              ? [{ key: rawKey }]
              : [],
          truncated: false,
        };
      },
      async head() {
        return null;
      },
      async get(key: string) {
        if (
          key === "system/inbound-recent-cursor.json" &&
          priorityCursorValue &&
          priorityCursorEtag
        ) {
          return {
            etag: priorityCursorEtag,
            async text() {
              return priorityCursorValue ?? "";
            },
          };
        }
        if (key === "system/inbound-recent-backstop-cursor.json") {
          return {
            etag: backstopCursorEtag,
            async text() {
              return backstopCursorValue;
            },
          };
        }
        return null;
      },
      async put(key: string, value: string) {
        if (key === markerKey) {
          markerAttempts += 1;
          if (!markerAvailable) {
            throw new Error("simulated prolonged marker outage");
          }
          markerWritten = true;
          return { etag: "marker-etag" };
        }
        if (key === "system/inbound-recent-cursor.json") {
          priorityCursorValue = value;
          priorityCursorEtag = "priority-cursor-1";
        }
        if (key === "system/inbound-recent-backstop-cursor.json") {
          backstopCursorValue = value;
          backstopCursorEtag = "backstop-cursor-1";
        }
        return { etag: "written-etag" };
      },
      async delete() {},
    },
    INBOUND_QUEUE: { async send() {} },
    MAILBOX: {
      idFromName(mailboxId: string) {
        return mailboxId;
      },
      get() {
        return { async getEmail() { return null; } };
      },
    },
  };
  const runtime = { now: () => now };

  await reconcileInboundArchives(env, runtime);
  assert.equal(markerAttempts, 1);
  assert.equal(markerWritten, false);
  assert.equal(priorityCursorValue, undefined);
  assert.equal(
    JSON.parse(backstopCursorValue).minute,
    "2026-07-16T00:00:00.000Z",
  );

  markerAvailable = true;
  now = new Date("2026-07-16T02:05:00.000Z");
  await reconcileInboundArchives(env, runtime);

  assert.equal(markerWritten, true);
  assert.equal(
    JSON.parse(backstopCursorValue).minute,
    "2026-07-16T00:04:00.000Z",
  );
});

test("malformed active marker pages advance so a valid marker behind them is not starved", async () => {
  const ingressId = "valid-marker-behind-malformed-page";
  const rawKey = `raw/2026/07/16/09/55/${ingressId}.eml`;
  const validMarkerKey =
    `system/inbound-active/${encodeURIComponent(rawKey)}.json`;
  const malformedMarkerKeys = Array.from(
    { length: 8 },
    (_, index) => `system/inbound-active/invalid-${index}.json`,
  );
  let activeCursorValue: string | undefined;
  let activeCursorEtag: string | undefined;
  const activeListCursors: Array<string | undefined> = [];
  const queued: InboundArchivePointer[] = [];

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
      async list(options: { prefix: string; cursor?: string }) {
        if (options.prefix === "system/inbound-active/") {
          activeListCursors.push(options.cursor);
          return options.cursor
            ? { objects: [{ key: validMarkerKey }], truncated: false }
            : {
                objects: malformedMarkerKeys.map((key) => ({ key })),
                truncated: true,
                cursor: "after-malformed-page",
              };
        }
        return { objects: [], truncated: false };
      },
      async head(key: string) {
        if (key === rawKey) {
          return {
            key: rawKey,
            size: 321,
            etag: "valid-archive-etag",
            version: "valid-archive-version",
            customMetadata: {
              archivedAt: "2026-07-16T09:55:00.000Z",
              ingressId,
              mailboxId: "hello@wiserchat.ai",
              rawSize: "321",
              schemaVersion: "1",
            },
          };
        }
        if (key === `receipts/${ingressId}.json`) {
          return {
            key,
            size: 1,
            etag: "receipt-head-etag",
            version: "receipt-version",
            customMetadata: { state: "enqueued" },
          };
        }
        return null;
      },
      async get(key: string) {
        if (
          key === "system/inbound-active-cursor.json" &&
          activeCursorValue &&
          activeCursorEtag
        ) {
          return {
            etag: activeCursorEtag,
            async text() {
              return activeCursorValue ?? "";
            },
          };
        }
        if (
          key === "system/inbound-recent-cursor.json" ||
          key === "system/inbound-recent-backstop-cursor.json"
        ) {
          return {
            etag: `${key}-etag`,
            async text() {
              return JSON.stringify({
                minute: "2026-07-16T10:00:00.000Z",
                cursor: null,
                updatedAt: "2026-07-16T09:59:00.000Z",
              });
            },
          };
        }
        if (key === `receipts/${ingressId}.json`) {
          return {
            etag: "receipt-etag",
            async text() {
              return inboundReceiptBody(
                {
                  ingressId,
                  rawKey,
                  rawSize: 321,
                  archivedAt: "2026-07-16T09:55:00.000Z",
                  etag: "valid-archive-etag",
                  version: "valid-archive-version",
                },
                "admitted",
                "2026-07-16T09:55:00.000Z",
              );
            },
          };
        }
        return null;
      },
      async put(key: string, value: string) {
        if (key === "system/inbound-active-cursor.json") {
          activeCursorValue = value;
          activeCursorEtag = activeCursorEtag
            ? "active-cursor-2"
            : "active-cursor-1";
        }
        return { etag: "written-etag" };
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
        return { async getEmail() { return null; } };
      },
    },
  };
  const runtime = { now: () => new Date("2026-07-16T10:00:00.000Z") };

  await reconcileInboundArchives(env, runtime);
  assert.deepEqual(activeListCursors, [undefined]);
  assert.deepEqual(queued, []);

  await reconcileInboundArchives(env, runtime);
  assert.deepEqual(activeListCursors, [undefined, "after-malformed-page"]);
  assert.deepEqual(
    queued.map((pointer) => pointer.ingressId),
    [ingressId],
  );
});
