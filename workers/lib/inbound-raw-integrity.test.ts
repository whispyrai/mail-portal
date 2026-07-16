import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { InboundArchivePointer } from "../inbound-email.ts";
import { inboundRawArchiveMatchesPointer } from "./inbound-raw-integrity.ts";

const rawSha256 = createHash("sha256").update("raw").digest("hex");

const pointer: InboundArchivePointer = {
  schemaVersion: 1,
  ingressId: "mail-123",
  rawKey: "raw/2026/07/15/mail-123.eml",
  mailboxId: "hello@wiserchat.ai",
  rawSize: 3,
  rawSha256,
  archivedAt: "2026-07-15T09:00:00.000Z",
  etag: "raw-etag",
  version: "raw-version",
};

function rawArchive() {
  return {
    key: pointer.rawKey,
    size: pointer.rawSize,
    etag: pointer.etag,
    version: pointer.version,
    customMetadata: {
      schemaVersion: String(pointer.schemaVersion),
      ingressId: pointer.ingressId,
      mailboxId: pointer.mailboxId,
      rawSize: String(pointer.rawSize),
      archivedAt: pointer.archivedAt,
      rawSha256,
    },
    checksums: {
      sha256: Uint8Array.from(
        createHash("sha256").update("raw").digest(),
      ).buffer,
    },
  };
}

test("raw archive identity matches only the exact durable pointer", () => {
  assert.equal(inboundRawArchiveMatchesPointer(rawArchive(), pointer), true);
});

for (const testCase of [
  { name: "schema version", field: "schemaVersion", poison: "2" },
  { name: "ingress id", field: "ingressId", poison: "other-mail" },
  { name: "mailbox id", field: "mailboxId", poison: "other@wiserchat.ai" },
  { name: "raw size", field: "rawSize", poison: "4" },
  {
    name: "archive timestamp",
    field: "archivedAt",
    poison: "2026-07-15T10:00:00.000Z",
  },
  { name: "checksum", field: "rawSha256", poison: "b".repeat(64) },
]) {
  test(`raw archive identity rejects poisoned ${testCase.name} metadata`, () => {
    const raw = rawArchive();
    raw.customMetadata[testCase.field] = testCase.poison;
    assert.equal(inboundRawArchiveMatchesPointer(raw, pointer), false);
  });
}
