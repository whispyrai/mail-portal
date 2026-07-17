import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import type { InboundArchivePointer } from "../../inbound-email.ts";
import { recoverInboundEmailWithAudit } from "./audited-inbound-recovery.ts";
import { AuditedInboundRecoveryError } from "./audited-inbound-recovery.ts";

const pointer: InboundArchivePointer = {
  schemaVersion: 1,
  ingressId: "repair-partial-success",
  rawKey: "raw/2026/07/15/repair-partial-success.eml",
  mailboxId: "hello@wiserchat.ai",
  rawSize: 100,
  rawSha256: "a".repeat(64),
  archivedAt: "2026-07-15T09:30:00.000Z",
  etag: "archive-etag",
  version: "archive-version",
};

test("completion-audit failure retains the committed repair result", async () => {
  await assert.rejects(
    recoverInboundEmailWithAudit(
      {
        auditBucket: {
          async put(key) {
            if (key.endsWith("-completed.json")) {
              throw new Error("simulated completion audit outage");
            }
            return {};
          },
        },
        dependencies: {
          bucket: { async put() {}, async delete() {} },
          mailbox: {} as never,
        },
        pointer,
        operator: { id: "admin-user", email: "admin@wiserchat.ai" },
        recover: async () => ({ status: "repaired", generation: 3 }),
      },
      {
        now: () => new Date("2026-07-15T10:00:00.000Z"),
        randomUUID: () => "audit-id",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AuditedInboundRecoveryError);
      assert.equal(error.stage, "completion_audit");
      assert.deepEqual(error.result, { status: "repaired", generation: 3 });
      return true;
    },
  );
});

test("completion audits and returned results project only allowed recovery fields", async () => {
  let completionAudit: Record<string, unknown> | undefined;
  async function poisonedRecovery(): Promise<{
    status: "repaired";
    generation: number;
    privatePayload: string;
  }> {
    return {
      status: "repaired",
      generation: 3,
      privatePayload: "poison",
    };
  }

  const recovered = await recoverInboundEmailWithAudit(
    {
      auditBucket: {
        async put(key, value) {
          if (key.endsWith("-completed.json")) {
            completionAudit = JSON.parse(value);
          }
          return {};
        },
      },
      dependencies: {
        bucket: { async put() {}, async delete() {} },
        mailbox: {
          async createEmail() {},
          async getEmail() {
            return null;
          },
          async resolveCanonicalThreadId() {
            return null;
          },
        },
      },
      pointer,
      operator: {
        id: "admin-user",
        email: "admin@wiserchat.ai",
        privatePayload: "poison",
      },
      recover: poisonedRecovery,
    },
    {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "audit-id",
    },
  );

  assert.deepEqual(recovered.result, { status: "repaired", generation: 3 });
  assert.deepEqual(completionAudit?.result, {
    status: "repaired",
    generation: 3,
  });
  assert.deepEqual(completionAudit?.operator, {
    id: "admin-user",
    email: "admin@wiserchat.ai",
  });
});

test("failure audits and degraded logs never expose projection or provider messages", async () => {
  const attachmentKey = "attachments/private-message/private-attempt/private.bin";
  let failureAudit = "";
  await assert.rejects(recoverInboundEmailWithAudit({
    auditBucket: {
      async put(key, value) {
        if (key.endsWith("-failed.json")) failureAudit = value;
        return {};
      },
    },
    dependencies: { bucket: { async put() {}, async delete() {} }, mailbox: {} as never },
    pointer,
    operator: { id: "admin-user", email: "admin@wiserchat.ai" },
    recover: async () => { throw new Error(`projection failed for ${attachmentKey}`); },
  }, {
    now: () => new Date("2026-07-15T10:00:00.000Z"),
    randomUUID: () => "audit-redaction",
  }));
  assert.equal(failureAudit.includes(attachmentKey), false);
  assert.equal(JSON.parse(failureAudit).errorCode, "MANUAL_RECOVERY_PROJECTION_FAILED");

  const bodyKey = "email-bodies/private-message/private-attempt/0.body";
  const logs: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  try {
    await assert.rejects(recoverInboundEmailWithAudit({
      auditBucket: {
        async put(key) {
          if (key.endsWith("-failed.json")) {
            const error = new Error(`audit provider failed for ${bodyKey}`);
            error.name = "ProviderErrorNamePoison";
            error.stack = "ProviderErrorStackPoison";
            throw error;
          }
          return {};
        },
      },
      dependencies: { bucket: { async put() {}, async delete() {} }, mailbox: {} as never },
      pointer,
      operator: { id: "admin-user", email: "admin@wiserchat.ai" },
      recover: async () => { throw new Error("projection failed"); },
    }, {
      now: () => new Date("2026-07-15T10:00:00.000Z"),
      randomUUID: () => "audit-provider-redaction",
    }));
  } finally {
    console.error = originalError;
  }
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(
    serializedLogs,
    /private-message|audit-provider-redaction|admin-user|admin@wiserchat\.ai|ProviderErrorNamePoison|ProviderErrorStackPoison/,
  );
  for (const [, fields] of logs) {
    assert.match(
      String((fields as Record<string, unknown>).auditRef),
      /^(?:[a-f0-9]{16}|unavailable)$/,
    );
    assert.match(
      String((fields as Record<string, unknown>).ingressRef),
      /^(?:[a-f0-9]{16}|unavailable)$/,
    );
  }
});

test("audited recovery commits request before projection and completion after it", async () => {
  const operations: string[] = [];
  let stored: Record<string, unknown> | undefined;
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "audited-recovery",
    rawKey: "raw/2026/07/13/audited-recovery.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };

  const recovered = await recoverInboundEmailWithAudit(
    {
      auditBucket: {
        async put(key, value) {
          const record = JSON.parse(value) as Record<string, unknown>;
          if (key.endsWith("-requested.json")) {
            operations.push("audit:requested");
            assert.equal(record.status, "requested");
          } else {
            operations.push("audit:completed");
            assert.equal(record.status, "completed");
          }
          return {};
        },
      },
      dependencies: {
        bucket: { async put() {}, async delete() {} },
        mailbox: {
          async getInboundDeletionAuthority() {
            return null;
          },
          async getInboundProjectionAuthority() {
            return stored ? { generation: 1 } : null;
          },
          async getEmail() {
            return stored ?? null;
          },
          async findThreadBySubject() {
            return null;
          },
          async createInboundEmail(command) {
            operations.push("mailbox:projected");
            assert.equal(command.folder, "inbox");
            assert.equal(command.mailboxAddress, pointer.mailboxId);
            assert.equal(command.allowTerminalRecovery, true);
            assert.deepEqual(command.archiveAuthority, pointer);
            stored = command.email as unknown as Record<string, unknown>;
            return { status: "stored" };
          },
        },
      },
      parsed: {
        from: { address: "sender@example.com" },
        to: [{ address: pointer.mailboxId }],
        subject: "Recovered",
        text: "Archived body",
        attachments: [],
        headers: [],
      } as Email,
      pointer,
      operator: { id: "admin-user", email: "admin@wiserchat.ai" },
    },
    {
      now: () => new Date("2026-07-13T10:00:00.000Z"),
      randomUUID: () => "audit-id",
    },
  );

  assert.deepEqual(operations, [
    "audit:requested",
    "mailbox:projected",
    "audit:completed",
  ]);
  assert.equal(recovered.auditId, "audit-id");
  assert.equal(recovered.result.status, "recovered");
});
