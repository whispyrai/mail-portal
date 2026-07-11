import type { OutboundDeliveryStatus } from "~/types";

export type OutboundDeliveryAction = {
	kind: "cancel" | "retry";
	label: string;
	requiresDuplicateRiskConfirmation: boolean;
};

export function outboundDeliveryAction(
	status: OutboundDeliveryStatus,
	cancelRecoveryPending = false,
): OutboundDeliveryAction | null {
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
