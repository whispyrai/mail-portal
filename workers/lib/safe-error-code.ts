const SAFE_DYNAMIC_ERROR_CODES = new Set([
	"IDEMPOTENCY_CHECK_FAILED",
	"MAILBOX_ACTIVE_CHECK_FAILED",
	"MAILBOX_ACTIVE_RECHECK_FAILED",
	"MAILBOX_MARKER_READ_FAILED",
	"MAILBOX_PROJECTION_FAILED",
	"RAW_ARCHIVE_READ_FAILED",
]);

const SAFE_FALLBACK_ERROR_CODES = new Set([
	"ARCHIVE_RECONCILIATION_FAILED",
	...SAFE_DYNAMIC_ERROR_CODES,
	"MANUAL_RECOVERY_FAILURE_AUDIT_FAILED",
	"MANUAL_RECOVERY_PROJECTION_FAILED",
	"QUEUE_RETRY_EXHAUSTED",
	"RAW_ARCHIVE_READ_FAILED",
	"RECONCILIATION_LEDGER_CLEANUP_FAILED",
	"RECONCILIATION_LEDGER_WRITE_FAILED",
]);

export function safeErrorCode(error: unknown, fallback: string): string {
	if (!SAFE_FALLBACK_ERROR_CODES.has(fallback)) {
		throw new Error("Safe error-code fallback is invalid");
	}
	if (!error || typeof error !== "object") return fallback;
	try {
		if (!("code" in error)) return fallback;
		return typeof error.code === "string" && SAFE_DYNAMIC_ERROR_CODES.has(error.code)
			? error.code
			: fallback;
	} catch {
		return fallback;
	}
}
