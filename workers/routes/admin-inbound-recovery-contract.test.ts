import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Hono } from "hono";
import type { SessionClaims } from "../lib/auth.ts";
import type { Env } from "../types.ts";
import { adminInboundRecoveryApp } from "./admin-inbound-recovery.ts";

const source = readFileSync(
  new URL("./admin-inbound-recovery.ts", import.meta.url),
  "utf8",
);

test("manual recovery derives raw identity from a server-owned pointer after current-brand admission", () => {
  const domainCheck = source.indexOf("isAddressInConfiguredMailDomains(");
  const allowlistCheck = source.indexOf("allowed.length > 0");
  const activeMailboxCheck = source.indexOf("SELECT id FROM mailboxes");
  const pointerRead = source.indexOf("pointer = await readPointer(");
  const rawRead = source.indexOf("raw = await readVerifiedRaw(");
  assert.ok(domainCheck > 0);
  assert.ok(allowlistCheck > domainCheck);
  assert.ok(activeMailboxCheck > allowlistCheck);
  assert.ok(pointerRead > activeMailboxCheck);
  assert.ok(rawRead > pointerRead);
  assert.doesNotMatch(source, /rawKey\s*=\s*c\.req/);
  assert.doesNotMatch(source, /archivedAt\s*=\s*c\.req/);
});

test("manual recovery auto-selects restore or exact current-generation anomaly repair", () => {
  const manifestProjection = source.indexOf(
    "projectInboundDerivedContentManifest(",
  );
  const manifestFailure = source.indexOf(
    'Inbound derived-content manifest is invalid',
    manifestProjection,
  );
  const markerRead = source.indexOf(
    "inboundDerivedContentAnomalyKey(",
    manifestProjection,
  );
  assert.ok(manifestProjection > 0);
  assert.ok(manifestFailure > manifestProjection);
  assert.ok(markerRead > manifestFailure);
  assert.match(source, /manifest\.status === "live_inbound"/);
  assert.match(
    source,
    /inboundDerivedContentAnomalyKey\([\s\S]*ingressId,[\s\S]*manifest\.generation/,
  );
  assert.match(source, /value\.status !== "pending"/);
  assert.match(source, /value\.generation !== manifest\.generation/);
  assert.match(source, /repairInboundDerivedContent/);
  assert.match(source, /recoverStreamingInboundEmail/);
  assert.match(source, /error\.stage === "completion_audit"/);
  assert.match(source, /auditStatus: "incomplete"/);
  assert.doesNotMatch(source, /\.\.\.(?:audited|error)\.result/);
  assert.doesNotMatch(source, /\.\.\.marker\.value/);
  assert.doesNotMatch(source, /return c\.json\(\{ \.\.\.audited\.result/);
});

test("marker-resolution diagnostics never expose provider error messages", () => {
  const start = source.indexOf(
    "[mail-recovery] anomaly marker resolution degraded",
  );
  const end = source.indexOf("return c.json(adminRecoveryResult", start);
  const diagnostic = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.doesNotMatch(diagnostic, /errorMessage|error\.message|String\(error\)/);
});

test("unverified repair responses expose the safe audit identity for manual verification", () => {
  const start = source.indexOf('consumerError?.commitState === "unverified"');
  const end = source.indexOf("return c.json(", start + 100);
  const response = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.match(response, /commitStatus: "unverified"/);
  assert.match(response, /auditId/);
  assert.match(response, /recoveryGuidance/);
});

test("manual repair shares one attempt id and activates cleanup only after the pending command is durable", () => {
  const attemptIdentity = source.indexOf(
    "const attemptId = derived.projectionAttemptId",
  );
  const persist = source.indexOf("persistPendingRepairAttempt(", attemptIdentity);
  const activate = source.indexOf("derived.activateCommand(", persist);
  const repair = source.indexOf("mailbox.repairInboundDerivedContent!", activate);
  assert.notEqual(attemptIdentity, -1);
  assert.ok(attemptIdentity < persist);
  assert.ok(persist < activate);
  assert.ok(activate < repair);
});

for (const receiptBody of [
  "{malformed-json",
  JSON.stringify({ schemaVersion: 99, state: "archived" }),
]) {
  test("manual recovery uses the reconciler pointer when a malformed receipt has a matching pending anomaly", async () => {
    const mailboxId = "hello@wiserchat.ai";
    const ingressId = "mail-malformed-receipt";
    const rawKey = `raw/2026/07/15/${ingressId}.eml`;
    const reads: string[] = [];
    const pointer = {
      schemaVersion: 1,
      ingressId,
      rawKey,
      mailboxId,
      rawSize: 3,
      rawSha256: "a".repeat(64),
      archivedAt: "2026-07-15T09:00:00.000Z",
      etag: "raw-etag",
      version: "raw-version",
    };
    const env = {
      DOMAINS: "wiserchat.ai",
      EMAIL_ADDRESSES: [mailboxId],
      DB: {
        prepare() {
          return {
            bind() {
              return { async first() { return { id: mailboxId }; } };
            },
          };
        },
      },
      BUCKET: { async head() { return {}; } },
      RAW_MAIL_BUCKET: {
        async get(key: string) {
          reads.push(key);
          if (key === `receipts/${ingressId}.json`) {
            return { async text() { return receiptBody; } };
          }
          if (key === `system/inbound-recovery-pointers/${ingressId}.json`) {
            return { async text() { return JSON.stringify(pointer); } };
          }
          if (
            key ===
            `system/reconciliation-anomalies/${encodeURIComponent(rawKey)}.json`
          ) {
            return {
              async text() {
                return JSON.stringify({
                  detectedAt: "2026-07-15T09:30:00.000Z",
                  errorCode: "ADMISSION_DECISION_MISSING",
                  ingressId,
                  mailboxId,
                  rawKey,
                  status: "pending_operator_review",
                });
              },
            };
          }
          assert.fail(`unexpected R2 read: ${key}`);
        },
      },
      MAILBOX: {
        idFromName(value: string) { return value; },
        get() {
          return {
            async getInboundDerivedContentManifest() { return null; },
          };
        },
      },
    } as unknown as Env;
    const app = new Hono<{
      Bindings: Env;
      Variables: { session?: SessionClaims };
    }>();
    app.use("*", async (c, next) => {
      c.set("session", {
        sub: "admin-1",
        email: "admin@wiserchat.ai",
        role: "ADMIN",
        mailbox: mailboxId,
      });
      await next();
    });
    app.route("/", adminInboundRecoveryApp);

    const response = await app.request(
      `http://mail.wiserchat.ai/recover-inbound/${encodeURIComponent(mailboxId)}?ingressId=${ingressId}`,
      { method: "POST" },
      env,
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Inbound derived-content manifest is invalid",
    });
    assert.deepEqual(reads, [
      `receipts/${ingressId}.json`,
      `system/inbound-recovery-pointers/${ingressId}.json`,
      `system/reconciliation-anomalies/${encodeURIComponent(rawKey)}.json`,
    ]);
  });
}

test("manual recovery rejects a poisoned manifest before marker, raw, repair, or audit effects", async () => {
  const mailboxId = "hello@wiserchat.ai";
  const ingressId = "mail-123";
  const rawReads: string[] = [];
  const mailboxHeads: string[] = [];
  let repairCalls = 0;
  let rawWrites = 0;
  const env = {
    DOMAINS: "wiserchat.ai",
    EMAIL_ADDRESSES: [mailboxId],
    BRAND: "wiser",
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async first() {
                return { id: mailboxId };
              },
            };
          },
        };
      },
    },
    BUCKET: {
      async head(key: string) {
        mailboxHeads.push(key);
        return {};
      },
    },
    RAW_MAIL_BUCKET: {
      async get(key: string) {
        rawReads.push(key);
        if (key !== `receipts/${ingressId}.json`) return null;
        return {
          async text() {
            return JSON.stringify({
              schemaVersion: 1,
              ingressId,
              rawKey: `raw/2026/07/15/${ingressId}.eml`,
              mailboxId,
              rawSize: 3,
              rawSha256: "a".repeat(64),
              archivedAt: "2026-07-15T09:00:00.000Z",
              etag: "raw-etag",
              version: "raw-version",
            });
          },
        };
      },
      async put() {
        rawWrites += 1;
        return {};
      },
      async delete() {},
    },
    MAILBOX: {
      idFromName(value: string) {
        return value;
      },
      get() {
        return {
          async getInboundDerivedContentManifest() {
            return {
              status: "live_inbound",
              generation: 2,
              lastRepairMarkerId: "marker_12345678",
              attachments: [
                {
                  id: "duplicate-object-id",
                  r2Key: `attachments/${ingressId}/attempt-1/file.bin`,
                  byteLength: 3,
                },
              ],
              bodyObjects: [
                {
                  id: "duplicate-object-id",
                  r2Key: `email-bodies/${ingressId}/attempt-1/0.body`,
                  byteLength: 3,
                },
              ],
            };
          },
          async repairInboundDerivedContent() {
            repairCalls += 1;
            return { status: "repaired", generation: 3 };
          },
        };
      },
    },
  } as unknown as Env;
  const app = new Hono<{
    Bindings: Env;
    Variables: { session?: SessionClaims };
  }>();
  app.use("*", async (c, next) => {
    c.set("session", {
      sub: "admin-1",
      email: "admin@wiserchat.ai",
      role: "ADMIN",
      mailbox: mailboxId,
    });
    await next();
  });
  app.route("/", adminInboundRecoveryApp);

  const response = await app.request(
    `http://mail.wiserchat.ai/recover-inbound/${encodeURIComponent(mailboxId)}?ingressId=${ingressId}`,
    { method: "POST" },
    env,
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Inbound derived-content manifest is invalid",
  });
  assert.deepEqual(mailboxHeads, [`mailboxes/${mailboxId}.json`]);
  assert.deepEqual(rawReads, [`receipts/${ingressId}.json`]);
  assert.equal(repairCalls, 0);
  assert.equal(rawWrites, 0);
});
