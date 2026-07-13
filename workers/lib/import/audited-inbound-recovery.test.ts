import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import type { InboundArchivePointer } from "../../inbound-email.ts";
import { recoverInboundEmailWithAudit } from "./audited-inbound-recovery.ts";

test("audited recovery commits request before projection and completion after it", async () => {
  const operations: string[] = [];
  let stored: Record<string, unknown> | undefined;
  const pointer: InboundArchivePointer = {
    schemaVersion: 1,
    ingressId: "audited-recovery",
    rawKey: "raw/2026/07/13/audited-recovery.eml",
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
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
          async getEmail() {
            return stored ?? null;
          },
          async findThreadBySubject() {
            return null;
          },
          async createEmail(_folder, email) {
            operations.push("mailbox:projected");
            stored = email as unknown as Record<string, unknown>;
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
