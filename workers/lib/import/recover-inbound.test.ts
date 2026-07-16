import assert from "node:assert/strict";
import test from "node:test";
import type { Email } from "postal-mime";
import {
  recoverInboundEmail,
  recoverStreamingInboundEmail,
} from "./recover-inbound.ts";

test("recoverStreamingInboundEmail rebuilds from the archive without buffering MIME", async () => {
  let stored: Record<string, unknown> | undefined;
  const raw = new TextEncoder().encode(
    "From: sender@example.com\r\nTo: hello@wiserchat.ai\r\nSubject: Streamed recovery\r\n\r\nRecovered body",
  );

  const result = await recoverStreamingInboundEmail(
    {
      bucket: { async put() {}, async delete() {} },
      mailbox: {
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
      ingressId: "streamed-recovery",
      archivedAt: "2026-07-13T09:30:00.000Z",
      mailboxId: "hello@wiserchat.ai",
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
      ingressId: "original-ingress-id",
      archivedAt: "2026-07-13T09:30:00.000Z",
      mailboxId: "hello@wiserchat.ai",
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
    {
      ingressId: "existing",
      archivedAt: "2026-07-13T09:30:00.000Z",
      mailboxId: "hello@wiserchat.ai",
    },
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
    {
      ingressId: "deleted",
      archivedAt: "2026-07-13T09:30:00.000Z",
      mailboxId: "hello@wiserchat.ai",
    },
  );

  assert.deepEqual(result, { status: "skipped", reason: "deleted" });
});
