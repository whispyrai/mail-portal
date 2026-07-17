import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import {
  exactRecoveryArchiveAuthority,
  recoverInboundEmail,
  recoverStreamingInboundEmail,
} from "./recover-inbound.ts";

function archiveAuthority(ingressId: string) {
  return {
    schemaVersion: 1 as const,
    ingressId,
    rawKey: `raw/2026/07/13/${ingressId}.eml`,
    mailboxId: "hello@wiserchat.ai",
    rawSize: 100,
    rawSha256: "a".repeat(64),
    archivedAt: "2026-07-13T09:30:00.000Z",
    etag: "archive-etag",
    version: "archive-version",
  };
}

test("manual recovery rejects an archive pointer without exact SHA authority", () => {
  const exact = archiveAuthority("weak-recovery-pointer");
  const { rawSha256: _rawSha256, ...weakPointer } = exact;
  assert.throws(
    () => exactRecoveryArchiveAuthority(weakPointer),
    /requires exact archive authority/,
  );
});

test("recoverStreamingInboundEmail rebuilds from the archive without buffering MIME", async () => {
  let stored: Record<string, unknown> | undefined;
  const raw = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Streamed recovery\r\n\r\nRecovered body",
  );

  const result = await recoverStreamingInboundEmail(
    {
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
          assert.equal(command.folder, "inbox");
          assert.equal(command.mailboxAddress, "hello@wiserchat.ai");
          assert.equal(command.allowTerminalRecovery, true);
          assert.deepEqual(
            command.archiveAuthority,
            archiveAuthority("streamed-recovery"),
          );
          stored = command.email as unknown as Record<string, unknown>;
			return { status: "stored", cleanupKeys: [] };
        },
      },
    },
    new ReadableStream({
      start(controller) {
        controller.enqueue(raw);
        controller.close();
      },
    }),
    {
      archiveAuthority: archiveAuthority("streamed-recovery"),
    },
    {
      async get() {
        assert.fail("inline recovery must not read a cleanup intent");
      },
      async put() {
        assert.fail("inline recovery must not create a cleanup intent");
      },
      async delete() {
        assert.fail("inline recovery must not delete a cleanup intent");
      },
    },
  );

  assert.deepEqual(result, { status: "recovered", ambiguousCommit: false });
  assert.equal(stored?.id, "streamed-recovery");
  assert.equal(stored?.body, "Recovered body");
});

test("recoverInboundEmail preserves the ingress identity and received timestamp", async () => {
  let stored: Record<string, unknown> | undefined;
  const result = await recoverInboundEmail(
    {
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
          assert.equal(command.folder, "inbox");
          assert.equal(command.mailboxAddress, "hello@wiserchat.ai");
          assert.equal(command.allowTerminalRecovery, true);
          assert.deepEqual(
            command.archiveAuthority,
            archiveAuthority("original-ingress-id"),
          );
          stored = command.email as unknown as Record<string, unknown>;
			return { status: "stored", cleanupKeys: [] };
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
      archiveAuthority: archiveAuthority("original-ingress-id"),
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
        async getInboundDeletionAuthority() {
          return null;
        },
        async getInboundProjectionAuthority(authority) {
          assert.deepEqual(authority, archiveAuthority("existing"));
          return { generation: 1 };
        },
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
    {
      archiveAuthority: archiveAuthority("existing"),
    },
  );

  assert.deepEqual(result, { status: "skipped", reason: "duplicate" });
});

test("recoverInboundEmail does not resurrect an intentional deletion", async () => {
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async getInboundDeletionAuthority(authority) {
          assert.deepEqual(authority, archiveAuthority("deleted"));
          return {
            generation: 2,
            deletedAt: "2026-07-13T10:00:00.000Z",
          };
        },
        async getInboundProjectionAuthority() {
          assert.fail("exact deletion must be checked first");
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
    {
      archiveAuthority: archiveAuthority("deleted"),
    },
  );

  assert.deepEqual(result, { status: "skipped", reason: "deleted" });
});

test("recoverInboundEmail rejects an unrelated same-ID mailbox collision", async () => {
  await assert.rejects(
    recoverInboundEmail(
      {
        bucket: { async put() {}, async delete() {} },
        mailbox: {
          async getInboundDeletionAuthority() {
            return null;
          },
          async getInboundProjectionAuthority() {
            return null;
          },
          async getEmail() {
            return { id: "unrelated-collision" };
          },
          async findThreadBySubject() {
            assert.fail("an unrelated collision must fail before projection");
          },
          async createInboundEmail() {
            assert.fail("an unrelated collision must never project");
          },
        },
      },
      { attachments: [], headers: [] } as unknown as Email,
      {
        archiveAuthority: archiveAuthority("unrelated-collision"),
      },
    ),
    /identity conflicts with mailbox state/,
  );
});

test("recoverInboundEmail suppresses a create-delete-lost-response race only with exact deletion authority", async () => {
  let deleted = false;
  const authority = archiveAuthority("recovery-delete-race");
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async getInboundDeletionAuthority(input) {
          assert.deepEqual(input, authority);
          return deleted
            ? {
                generation: 2,
                deletedAt: "2026-07-13T10:00:00.000Z",
              }
            : null;
        },
        async getInboundProjectionAuthority() {
          return null;
        },
        async getEmail() {
          return null;
        },
        async findThreadBySubject() {
          return null;
        },
        async createInboundEmail() {
          deleted = true;
          throw new Error("simulated lost response after commit and delete");
        },
      },
    },
    {
      from: { address: "sender@example.com" },
      to: [{ address: authority.mailboxId }],
      attachments: [],
      headers: [],
    } as Email,
    { archiveAuthority: authority },
  );

  assert.deepEqual(result, { status: "skipped", reason: "deleted" });
});

test("recoverInboundEmail accepts an ambiguous create only after exact projection authority appears", async () => {
  let stored = false;
  const authority = archiveAuthority("recovery-ambiguous-store");
  const result = await recoverInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
        async getInboundDeletionAuthority() {
          return null;
        },
        async getInboundProjectionAuthority(input) {
          assert.deepEqual(input, authority);
          return stored ? { generation: 1 } : null;
        },
        async getEmail() {
          return stored ? { id: authority.ingressId } : null;
        },
        async findThreadBySubject() {
          return null;
        },
        async createInboundEmail() {
          stored = true;
          throw new Error("simulated lost response after commit");
        },
      },
    },
    {
      from: { address: "sender@example.com" },
      to: [{ address: authority.mailboxId }],
      attachments: [],
      headers: [],
    } as Email,
    { archiveAuthority: authority },
  );

  assert.deepEqual(result, { status: "recovered", ambiguousCommit: true });
});
