import type { OutboundDeliveryStatus } from "~/types";

export type OutboundDeliveryAction = {
	kind: "cancel" | "retry";
	label: string;
	requiresDuplicateRiskConfirmation: boolean;
};

export function outboundDeliveryAction(
	status: OutboundDeliveryStatus,
	cancelRecoveryPending = false,
	storageIntegrityCode?: string,
	lastErrorCode?: string,
): OutboundDeliveryAction | null {
	if (storageIntegrityCode) return null;
	if (
		status === "failed" &&
		lastErrorCode &&
		new Set([
			"attachment_integrity_unverifiable",
			"attachment_metadata_mismatch",
			"attachment_size_mismatch",
			"attachment_content_mismatch",
			"attachment_missing",
			"snapshot_missing",
			"outbound_snapshot_invalid",
			"outbound_dispatch_metadata_invalid",
		]).has(lastErrorCode)
	) {
		return null;
	}
	if (
		status === "queued" ||
		status === "retrying" ||
		(status === "cancelled" && cancelRecoveryPending)
	) {
		return {
			kind: "cancel",
			label: status === "cancelled" ? "Finish cancellation" : "Cancel send",
			requiresDuplicateRiskConfirmation: false,
		};
	}
	if (status === "failed" || status === "unknown") {
		return {
			kind: "retry",
			label:
				status === "unknown" ? "Retry with duplicate risk" : "Retry send",
			requiresDuplicateRiskConfirmation: status === "unknown",
		};
	}
	return null;
}
