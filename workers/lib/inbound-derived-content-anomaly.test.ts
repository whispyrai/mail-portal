import assert from "node:assert/strict";
import test from "node:test";
import {
  inboundDerivedContentAnomalyKey,
  isInboundDerivedContentAnomaly,
} from "./inbound-derived-content-anomaly.ts";
import {
  MAX_INBOUND_DERIVED_GENERATION,
  MAX_INBOUND_EMAIL_BYTES,
} from "./inbound-projection-contract.ts";

test("derived-content anomaly keys fence each ingress generation", () => {
  assert.equal(
    inboundDerivedContentAnomalyKey("id/with spaces", 7),
    "system/derived-content-anomalies/id%2Fwith%20spaces/7.json",
  );
});

test("derived-content anomaly validation accepts only server-shaped pending markers", () => {
  const marker = {
    schemaVersion: 1,
    kind: "inbound_derived_content_anomaly",
    status: "pending",
    markerId: "marker_12345678",
    ingressId: "ingress-1",
    mailboxId: "hello@wiserchat.ai",
    generation: 2,
    detectedAt: "2026-07-15T10:00:00.000Z",
    failures: [
      {
        objectType: "body",
        objectId: "body-1",
        expectedBytes: 100,
        actualBytes: 90,
        reason: "size_mismatch",
      },
    ],
  };
  assert.equal(isInboundDerivedContentAnomaly(marker), true);
  assert.equal(
    isInboundDerivedContentAnomaly({ ...marker, generation: 0 }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      generation: MAX_INBOUND_DERIVED_GENERATION + 1,
    }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      failures: [
        {
          ...marker.failures[0],
          expectedBytes: MAX_INBOUND_EMAIL_BYTES + 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      failures: [
        {
          ...marker.failures[0],
          actualBytes: MAX_INBOUND_EMAIL_BYTES + 1,
        },
      ],
    }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({ ...marker, failures: [] }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({ ...marker, privatePayload: "poison" }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      failures: [{ ...marker.failures[0], privatePayload: "poison" }],
    }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      resolvedAt: "2026-07-15T10:01:00.000Z",
      repairAuditId: "audit_12345678",
    }),
    false,
  );
  assert.equal(
    isInboundDerivedContentAnomaly({
      ...marker,
      status: "resolved",
      resolvedAt: "2026-07-15T10:01:00.000Z",
      repairAuditId: "audit_12345678",
    }),
    true,
  );
});
