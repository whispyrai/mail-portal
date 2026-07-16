import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorCode } from "./safe-error-code.ts";

test("safe error codes admit only verified receipt retries and literal fallbacks", () => {
	assert.equal(
		safeErrorCode(
			{ code: "MAILBOX_MARKER_READ_FAILED" },
			"QUEUE_RETRY_EXHAUSTED",
		),
		"MAILBOX_MARKER_READ_FAILED",
	);
	for (const code of [
		"MANUAL_RECOVERY_PROJECTION_FAILED",
		"R2_OBJECT_UNAVAILABLE",
		"FORGED_UPPERCASE_CODE",
		"attachments/private/key",
		"lowercase_code",
		"A".repeat(65),
		123,
	]) {
		assert.equal(
			safeErrorCode({ code }, "ARCHIVE_RECONCILIATION_FAILED"),
			"ARCHIVE_RECONCILIATION_FAILED",
		);
	}
	assert.equal(
		safeErrorCode(
			new Error("attachments/private/key"),
			"MANUAL_RECOVERY_PROJECTION_FAILED",
		),
		"MANUAL_RECOVERY_PROJECTION_FAILED",
	);
	assert.throws(() =>
		safeErrorCode(undefined, "FORGED_FALLBACK"),
	);
});
