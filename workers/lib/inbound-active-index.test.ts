import assert from "node:assert/strict";
import test from "node:test";
import {
  inboundActiveMarkerKey,
  persistInboundActiveMarkerForRawKey,
  rawKeyFromInboundActiveMarkerKey,
} from "./inbound-active-index.ts";

test("active marker keys round-trip both canonical raw-key generations only", () => {
  const accepted = [
    "raw/2026/07/16/legacy-id.eml",
    "raw/2026/07/16/09/57/minute-id.eml",
  ];
  for (const rawKey of accepted) {
    const markerKey = inboundActiveMarkerKey(rawKey);
    assert.equal(rawKeyFromInboundActiveMarkerKey(markerKey), rawKey);
  }

  const rejected = [
    "raw/2026/07/16/09/57/extra/minute-id.eml",
    "raw/2026/07/16/09/99/minute-id.eml",
    "private/2026/07/16/09/57/minute-id.eml",
  ];
  for (const rawKey of rejected) {
    assert.equal(
      rawKeyFromInboundActiveMarkerKey(inboundActiveMarkerKey(rawKey)),
      null,
    );
  }
  assert.equal(
    rawKeyFromInboundActiveMarkerKey(
      "system/inbound-active/raw%2f2026%2f07%2f16%2flegacy-id.eml.json",
    ),
    null,
  );
});

test("active marker persistence rejects a raw-key and ingress identity mismatch", async () => {
  let putCalled = false;
  await assert.rejects(
    persistInboundActiveMarkerForRawKey(
      {
        async put() {
          putCalled = true;
          return {};
        },
      },
      "raw/2026/07/16/09/57/canonical-id.eml",
      "different-id",
    ),
    /identity is invalid/,
  );
  assert.equal(putCalled, false);
});
