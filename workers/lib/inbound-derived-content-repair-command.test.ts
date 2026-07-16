import assert from "node:assert/strict";
import test from "node:test";
import type { InboundDerivedContentRepairCommand } from "./inbound-projection-contract.ts";
import { inboundDerivedContentRepairCommandFingerprint } from "./inbound-derived-content-repair-attempt.ts";

type RepairCommand = Omit<
  InboundDerivedContentRepairCommand,
  "commandFingerprint"
>;

function command(): RepairCommand {
  const attemptId = "123e4567-e89b-42d3-a456-426614174000";
  return {
    attemptId,
    emailId: "email-123",
    expectedGeneration: 4,
    markerId: "marker_12345678",
    body: "original body",
    attachments: [
      {
        id: "email-123-0",
        email_id: "email-123",
        filename: "proof-a.pdf",
        mimetype: "application/pdf",
        size: 8,
        content_id: "proof-a",
        disposition: "inline",
        r2_key: `attachments/email-123/${attemptId}/email-123-0/proof-a.pdf`,
      },
      {
        id: "email-123-1",
        email_id: "email-123",
        filename: "proof-b.txt",
        mimetype: "text/plain",
        size: 9,
        content_id: null,
        disposition: "attachment",
        r2_key: `attachments/email-123/${attemptId}/email-123-1/proof-b.txt`,
      },
    ],
    bodyObjects: [
      {
        id: "body-a",
        email_id: "email-123",
        part_index: 0,
        content_type: "text/html",
        charset: "utf-8",
        r2_key: `email-bodies/email-123/${attemptId}/0.body`,
        byte_length: 13,
      },
      {
        id: "body-b",
        email_id: "email-123",
        part_index: 1,
        content_type: "text/plain",
        charset: "us-ascii",
        r2_key: `email-bodies/email-123/${attemptId}/1.body`,
        byte_length: 7,
      },
    ],
  };
}

test("repair fingerprint covers the complete derived-content command", async () => {
  const original = command();
  const originalFingerprint =
    await inboundDerivedContentRepairCommandFingerprint(original);
  const mutations: Array<{
    field: string;
    apply(value: RepairCommand): void;
  }> = [
    { field: "attemptId", apply: (value) => { value.attemptId = "123e4567-e89b-42d3-b456-426614174000"; } },
    { field: "emailId", apply: (value) => { value.emailId = "email-456"; } },
    { field: "expectedGeneration", apply: (value) => { value.expectedGeneration = 5; } },
    { field: "markerId", apply: (value) => { value.markerId = "marker_87654321"; } },
    { field: "body", apply: (value) => { value.body = "changed body"; } },
    { field: "attachment.id", apply: (value) => { value.attachments[0]!.id = "attachment-c"; } },
    { field: "attachment.email_id", apply: (value) => { value.attachments[0]!.email_id = "email-456"; } },
    { field: "attachment.filename", apply: (value) => { value.attachments[0]!.filename = "changed.pdf"; } },
    { field: "attachment.mimetype", apply: (value) => { value.attachments[0]!.mimetype = "image/png"; } },
    { field: "attachment.size", apply: (value) => { value.attachments[0]!.size = 10; } },
    { field: "attachment.content_id", apply: (value) => { value.attachments[0]!.content_id = "changed"; } },
    { field: "attachment.disposition", apply: (value) => { value.attachments[0]!.disposition = "attachment"; } },
    { field: "attachment.r2_key", apply: (value) => { value.attachments[0]!.r2_key = "attempt/changed"; } },
    { field: "bodyObject.id", apply: (value) => { value.bodyObjects[0]!.id = "body-c"; } },
    { field: "bodyObject.email_id", apply: (value) => { value.bodyObjects[0]!.email_id = "email-456"; } },
    { field: "bodyObject.part_index", apply: (value) => { value.bodyObjects[0]!.part_index = 2; } },
    { field: "bodyObject.content_type", apply: (value) => { value.bodyObjects[0]!.content_type = "text/plain"; } },
    { field: "bodyObject.charset", apply: (value) => { value.bodyObjects[0]!.charset = "iso-8859-1"; } },
    { field: "bodyObject.r2_key", apply: (value) => { value.bodyObjects[0]!.r2_key = "attempt/body-changed"; } },
    { field: "bodyObject.byte_length", apply: (value) => { value.bodyObjects[0]!.byte_length = 14; } },
  ];

  for (const mutation of mutations) {
    const changed = structuredClone(original);
    mutation.apply(changed);
    assert.notEqual(
      await inboundDerivedContentRepairCommandFingerprint(changed),
      originalFingerprint,
      mutation.field,
    );
  }
});

test("repair fingerprint is stable across attachment and body-object ordering", async () => {
  const original = command();
  const reordered = structuredClone(original);
  reordered.attachments.reverse();
  reordered.bodyObjects.reverse();
  assert.equal(
    await inboundDerivedContentRepairCommandFingerprint(reordered),
    await inboundDerivedContentRepairCommandFingerprint(original),
  );
});
