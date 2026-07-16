import assert from "node:assert/strict";
import test from "node:test";
import {
  inboundIngressIdFromRawKey,
  inboundRawArchiveKey,
  inboundRawMinutePrefix,
  isInboundRawKeyForIngress,
} from "./inbound-raw-key.ts";

test("inbound raw keys accept exactly the legacy and minute-partitioned canonical shapes", () => {
  const accepted = [
    "raw/2026/07/16/mail_id-1.eml",
    "raw/2026/07/16/09/57/mail_id-1.eml",
    "raw/2028/02/29/23/59/mail_id-1.eml",
  ];
  const rejected = [
    "raw/2026/07/16/09/mail_id-1.eml",
    "raw/2026/07/16/09/57/extra/mail_id-1.eml",
    "raw/2026/02/30/09/57/mail_id-1.eml",
    "raw/2026/13/16/09/57/mail_id-1.eml",
    "raw/2026/07/16/24/00/mail_id-1.eml",
    "raw/2026/07/16/09/60/mail_id-1.eml",
    "raw/2026/7/16/09/57/mail_id-1.eml",
    "raw/2026/07/16/9/57/mail_id-1.eml",
    "raw/2026/07/16/09/57/mail%5Fid-1.eml",
    "raw/2026/07/16/09/57/mail_id-1.eml.json",
    "private/raw/2026/07/16/09/57/mail_id-1.eml",
  ];

  for (const rawKey of accepted) {
    assert.equal(isInboundRawKeyForIngress(rawKey, "mail_id-1"), true, rawKey);
    assert.equal(inboundIngressIdFromRawKey(rawKey), "mail_id-1", rawKey);
  }
  for (const rawKey of rejected) {
    assert.equal(isInboundRawKeyForIngress(rawKey, "mail_id-1"), false, rawKey);
    assert.equal(inboundIngressIdFromRawKey(rawKey), null, rawKey);
  }
  assert.equal(
    isInboundRawKeyForIngress(
      "raw/2026/07/16/09/57/mail_id-1.eml",
      "different-id",
    ),
    false,
  );
});

test("new inbound archives use their exact UTC minute partition", () => {
  const archivedAt = new Date("2026-07-16T09:57:42.123Z");
  assert.equal(
    inboundRawMinutePrefix(archivedAt),
    "raw/2026/07/16/09/57/",
  );
  assert.equal(
    inboundRawArchiveKey(archivedAt, "mail_id-1"),
    "raw/2026/07/16/09/57/mail_id-1.eml",
  );
});
