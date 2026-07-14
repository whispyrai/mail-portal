// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveImportId } from "./parse.ts";
import { importParsedEmail } from "./import-email.ts";

type CreatedEmail = {
  folder: string;
  email: Record<string, unknown>;
  attachments: Array<Record<string, unknown>>;
};

test("importParsedEmail preserves metadata, attachments, threads, and idempotency", async () => {
  const createdEmails: CreatedEmail[] = [];
  const storedAttachmentKeys: string[] = [];
  const storedEmailIds = new Set<string>();
  const mailbox = {
    async getEmail(id: string) {
      return storedEmailIds.has(id) ? { id } : null;
    },
    async findThreadBySubject() {
      return null;
    },
    async createEmail(
      folder: string,
      email: Record<string, unknown>,
      attachments: Array<Record<string, unknown>>,
    ) {
      createdEmails.push({ folder, email, attachments });
      if (typeof email.id === "string") storedEmailIds.add(email.id);
    },
  };
  const bucket = {
    async put(key: string, value: ArrayBuffer) {
      storedAttachmentKeys.push(key);
      return { size: value.byteLength };
    },
    async delete() {},
  };
  const parsed = {
    messageId: "<reply@zoho.example>",
    inReplyTo: "<root@zoho.example>",
    references: "<root@zoho.example>",
    date: "Wed, 15 Apr 2026 15:42:00 +0000",
    subject: "Re: Contract",
    from: { name: "Sender", address: "sender@example.com" },
    to: [{ name: "Hello", address: "hello@wiserchat.ai" }],
    cc: [{ name: "Copy", address: "copy@example.com" }],
    bcc: [],
    text: "Attached.",
    headers: [{ key: "message-id", value: "<reply@zoho.example>" }],
    headerLines: [],
    attachments: [
      {
        filename: "contract?.pdf",
        mimeType: "application/pdf",
        content: new Uint8Array([1, 2, 3]).buffer,
        disposition: "attachment",
      },
    ],
  };

  const imported = await importParsedEmail(
    { bucket, mailbox },
    parsed,
    "archive",
  );
  const duplicate = await importParsedEmail(
    { bucket, mailbox },
    parsed,
    "archive",
  );
  const expectedThreadId = await deriveImportId({
    messageId: "<root@zoho.example>",
  });

  assert.deepEqual(imported, {
    status: "imported",
    id: await deriveImportId({ messageId: "<reply@zoho.example>" }),
    folder: "archive",
  });
  assert.deepEqual(duplicate, {
    status: "skipped",
    reason: "duplicate",
    id: imported.id,
    folder: "archive",
  });
  assert.equal(createdEmails.length, 1);
  assert.equal(createdEmails[0]?.folder, "archive");
  assert.equal(createdEmails[0]?.email.date, "2026-04-15T15:42:00.000Z");
  assert.equal(createdEmails[0]?.email.read, true);
  assert.equal(createdEmails[0]?.email.thread_id, expectedThreadId);
  assert.equal(createdEmails[0]?.attachments[0]?.filename, "contract_.pdf");
  assert.equal(createdEmails[0]?.attachments[0]?.email_id, imported.id);
  assert.equal(storedAttachmentKeys.length, 1);
  assert.match(
    storedAttachmentKeys[0] ?? "",
    new RegExp(`^attachments/${imported.id}/`),
  );
});

test("importParsedEmail cleans partial objects and retries with stable attachment ids", async () => {
  const objects = new Map<string, unknown>();
  const storedEmailIds = new Set<string>();
  const attachmentIds: string[] = [];
  let failCreate = true;
  const mailbox = {
    async getEmail(id: string) {
      return storedEmailIds.has(id) ? { id } : null;
    },
    async findThreadBySubject() {
      return null;
    },
    async createEmail(
      _folder: string,
      email: Record<string, unknown>,
      attachments: Array<Record<string, unknown>>,
    ) {
      if (failCreate) {
        failCreate = false;
        throw new Error("simulated SQL failure");
      }
      if (typeof email.id === "string") storedEmailIds.add(email.id);
      for (const attachment of attachments) {
        if (typeof attachment.id === "string")
          attachmentIds.push(attachment.id);
      }
    },
  };
  const bucket = {
    async put(key: string, value: unknown) {
      objects.set(key, value);
      return {
        size:
          value instanceof ArrayBuffer
            ? value.byteLength
            : new TextEncoder().encode(String(value)).byteLength,
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
  };
  const parsed = {
    messageId: "<retry@zoho.example>",
    date: "Wed, 15 Apr 2026 15:42:00 +0000",
    subject: "Retry me",
    from: { address: "sender@example.com" },
    to: [{ address: "hello@wiserchat.ai" }],
    text: "One attachment",
    headers: [],
    headerLines: [],
    attachments: [
      {
        filename: "retry.txt",
        mimeType: "text/plain",
        content: new TextEncoder().encode("retry").buffer,
      },
    ],
  };

  await assert.rejects(
    () => importParsedEmail({ bucket, mailbox }, parsed, "inbox"),
    /simulated SQL failure/,
  );
  assert.equal(
    objects.size,
    0,
    "failed persistence removes already-written R2 objects",
  );

  const imported = await importParsedEmail(
    { bucket, mailbox },
    parsed,
    "inbox",
  );
  const expectedAttachmentId = `${imported.id}-0`;
  assert.deepEqual(attachmentIds, [expectedAttachmentId]);
  assert.deepEqual(
    [...objects.keys()],
    [`attachments/${imported.id}/${expectedAttachmentId}/retry.txt`],
  );
});
