import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import { recoverInboundEmail } from "./recover-inbound.ts";

test("recoverInboundEmail preserves the ingress identity and received timestamp", async () => {
  let stored: Record<string, unknown> | undefined;
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async getEmail() {
          return stored ?? null;
        },
        async findThreadBySubject() {
          return null;
        },
        async createEmail(folder, email) {
          assert.equal(folder, "inbox");
          stored = email as unknown as Record<string, unknown>;
        },
      },
    },
    {
      from: { address: "sender@example.com", name: "Sender" },
      to: [{ address: "hello@wiserchat.ai", name: "Hello" }],
      subject: "Recovered",
      text: "Exact archived content",
      attachments: [],
      headers: [],
    } as Email,
    {
      ingressId: "original-ingress-id",
      archivedAt: "2026-07-13T09:30:00.000Z",
    },
  );

  assert.deepEqual(result, { status: "recovered", ambiguousCommit: false });
  assert.equal(stored?.id, "original-ingress-id");
  assert.equal(stored?.date, "2026-07-13T09:30:00.000Z");
  assert.equal(stored?.read, false);
});

test("recoverInboundEmail skips an existing stable ingress identity", async () => {
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async getEmail() {
          return { id: "existing" };
        },
        async findThreadBySubject() {
          assert.fail("duplicate must return first");
        },
        async createEmail() {
          assert.fail("duplicate must not be stored twice");
        },
      },
    },
    { attachments: [], headers: [] } as unknown as Email,
    { ingressId: "existing", archivedAt: "2026-07-13T09:30:00.000Z" },
  );

  assert.deepEqual(result, { status: "skipped", reason: "duplicate" });
});

test("recoverInboundEmail does not resurrect an intentional deletion", async () => {
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async isEmailDeleted() {
          return true;
        },
        async getEmail() {
          assert.fail("the deletion tombstone must be checked first");
        },
        async findThreadBySubject() {
          assert.fail("a deleted message must not be restored automatically");
        },
        async createEmail() {
          assert.fail("a deleted message must not be restored automatically");
        },
      },
    },
    { attachments: [], headers: [] } as unknown as Email,
    { ingressId: "deleted", archivedAt: "2026-07-13T09:30:00.000Z" },
  );

  assert.deepEqual(result, { status: "skipped", reason: "deleted" });
});
