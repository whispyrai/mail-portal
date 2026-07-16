import {
  MAX_INBOUND_DERIVED_GENERATION,
  MAX_INBOUND_EMAIL_BYTES,
} from "./inbound-projection-contract.ts";

export const INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION = 1;

export type InboundDerivedContentAnomaly = {
  schemaVersion: typeof INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION;
  kind: "inbound_derived_content_anomaly";
  status: "pending" | "resolved";
  markerId: string;
  ingressId: string;
  mailboxId: string;
  generation: number;
  detectedAt: string;
  failures: Array<{
    objectType: "attachment" | "body";
    objectId: string;
    expectedBytes: number;
    actualBytes: number | null;
    reason: "missing" | "size_mismatch";
  }>;
  resolvedAt?: string;
  repairAuditId?: string;
};

const PENDING_ANOMALY_KEYS = [
  "detectedAt",
  "failures",
  "generation",
  "ingressId",
  "kind",
  "mailboxId",
  "markerId",
  "schemaVersion",
  "status",
] as const;

const RESOLVED_ANOMALY_KEYS = [
  ...PENDING_ANOMALY_KEYS,
  "repairAuditId",
  "resolvedAt",
] as const;

const ANOMALY_FAILURE_KEYS = [
  "actualBytes",
  "expectedBytes",
  "objectId",
  "objectType",
  "reason",
] as const;

function hasExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.some((candidate) => candidate === key))
  );
}

export function inboundDerivedContentAnomalyKey(
  ingressId: string,
  generation: number,
): string {
  return `system/derived-content-anomalies/${encodeURIComponent(ingressId)}/${generation}.json`;
}

export function isInboundDerivedContentAnomaly(
  value: unknown,
): value is InboundDerivedContentAnomaly {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    hasExactKeys(
      record,
      record.status === "resolved"
        ? RESOLVED_ANOMALY_KEYS
        : PENDING_ANOMALY_KEYS,
    ) &&
    record.schemaVersion === INBOUND_DERIVED_CONTENT_ANOMALY_SCHEMA_VERSION &&
    record.kind === "inbound_derived_content_anomaly" &&
    (record.status === "pending" || record.status === "resolved") &&
    typeof record.markerId === "string" &&
    /^[a-zA-Z0-9_-]{8,100}$/.test(record.markerId) &&
    typeof record.ingressId === "string" &&
    typeof record.mailboxId === "string" &&
    Number.isSafeInteger(record.generation) &&
    (record.generation as number) >= 1 &&
    (record.generation as number) <= MAX_INBOUND_DERIVED_GENERATION &&
    typeof record.detectedAt === "string" &&
    Number.isFinite(Date.parse(record.detectedAt)) &&
    Array.isArray(record.failures) &&
    record.failures.length > 0 &&
    record.failures.every((failure) => {
      if (!failure || typeof failure !== "object" || Array.isArray(failure)) {
        return false;
      }
      const item = failure as Record<string, unknown>;
      return (
        hasExactKeys(item, ANOMALY_FAILURE_KEYS) &&
        (item.objectType === "attachment" || item.objectType === "body") &&
        typeof item.objectId === "string" &&
        Number.isSafeInteger(item.expectedBytes) &&
        (item.expectedBytes as number) >= 0 &&
        (item.expectedBytes as number) <= MAX_INBOUND_EMAIL_BYTES &&
        (item.actualBytes === null ||
          (Number.isSafeInteger(item.actualBytes) &&
            (item.actualBytes as number) >= 0 &&
            (item.actualBytes as number) <= MAX_INBOUND_EMAIL_BYTES)) &&
        (item.reason === "missing" || item.reason === "size_mismatch")
      );
    }) &&
    (record.status === "pending"
      ? true
      : typeof record.resolvedAt === "string" &&
        Number.isFinite(Date.parse(record.resolvedAt)) &&
        typeof record.repairAuditId === "string" &&
        /^[a-zA-Z0-9_-]{8,100}$/.test(record.repairAuditId))
  );
}
