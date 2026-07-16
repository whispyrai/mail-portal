const ANOMALY_LEDGER_PREFIX = "system/reconciliation-anomalies/";

export type ReconciliationAnomalyErrorCode =
  | "ADMISSION_DECISION_MISSING"
  | "DLQ_TERMINAL_LEDGER_MISSING"
  | "DLQ_TERMINAL_RECEIPT_ETAG_MISSING"
  | "RAW_ARCHIVE_METADATA_INVALID"
  | "RECEIPT_STATE_UNKNOWN"
  | "STORED_PROJECTION_MISSING";

export type PendingReconciliationAnomaly =
  | { errorCode: "RAW_ARCHIVE_METADATA_INVALID" }
  | {
      errorCode: Exclude<
        ReconciliationAnomalyErrorCode,
        "RAW_ARCHIVE_METADATA_INVALID"
      >;
      ingressId: string;
      mailboxId: string;
    };

export type StoredPendingReconciliationAnomaly = {
  detectedAt: string;
  errorCode: ReconciliationAnomalyErrorCode;
  ingressId?: string;
  mailboxId?: string;
  rawKey: string;
  status: "pending_operator_review";
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function inboundReconciliationAnomalyKey(rawKey: string): string {
  return `${ANOMALY_LEDGER_PREFIX}${encodeURIComponent(rawKey)}.json`;
}

export function isStoredPendingReconciliationAnomaly(
  value: unknown,
): value is StoredPendingReconciliationAnomaly {
  if (!isRecord(value)) return false;
  const baseKeys = ["detectedAt", "errorCode", "rawKey", "status"];
  const identifiedKeys = [...baseKeys, "ingressId", "mailboxId"];
  const expectedKeys =
    value.errorCode === "RAW_ARCHIVE_METADATA_INVALID"
      ? baseKeys
      : identifiedKeys;
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => expectedKeys.includes(key))
  ) {
    return false;
  }
  const errorCodes = new Set<unknown>([
    "ADMISSION_DECISION_MISSING",
    "DLQ_TERMINAL_LEDGER_MISSING",
    "DLQ_TERMINAL_RECEIPT_ETAG_MISSING",
    "RAW_ARCHIVE_METADATA_INVALID",
    "RECEIPT_STATE_UNKNOWN",
    "STORED_PROJECTION_MISSING",
  ]);
  return (
    errorCodes.has(value.errorCode) &&
    typeof value.rawKey === "string" &&
    typeof value.detectedAt === "string" &&
    Number.isFinite(Date.parse(value.detectedAt)) &&
    value.status === "pending_operator_review" &&
    (value.errorCode === "RAW_ARCHIVE_METADATA_INVALID" ||
      (typeof value.ingressId === "string" &&
        typeof value.mailboxId === "string"))
  );
}
