import type {
	PushDeviceHealth,
	PushHealthResponse,
} from "~/services/push-health.ts";

export type PushHealthTone = "neutral" | "positive" | "warning" | "danger";

export interface PushHealthPresentation {
	title: string;
	description: string;
	tone: PushHealthTone;
	timestamp: string | null;
}

export function pushHealthPresentation(
	health: PushHealthResponse,
): PushHealthPresentation {
	switch (health.state) {
		case "not_configured":
			return {
				title: "Notification handoff unavailable",
				description: "Mail remains available in your Inbox.",
				tone: "danger",
				timestamp: null,
			};
		case "no_devices":
			return {
				title: "No enabled devices",
				description: "Enable notifications on this device to receive new-mail alerts.",
				tone: "neutral",
				timestamp: null,
			};
		case "healthy":
			return {
				title: "Ready for new mail",
				description: "Recent handoffs were accepted, or no notification has needed a handoff yet.",
				tone: "positive",
				timestamp: null,
			};
		case "retrying":
			return {
				title: "Retrying briefly",
				description: health.pendingCount > 1
					? `${health.pendingCount} notification handoffs are retrying. Your Inbox remains authoritative.`
					: "A notification handoff is retrying. Your Inbox remains authoritative.",
				tone: "warning",
				timestamp: null,
			};
		case "degraded":
			return {
				title: "Notification handoff needs attention",
				description: "Future mail remains safe in your Inbox even when a notification cannot be handed off.",
				tone: "danger",
				timestamp: null,
			};
	}
	throw new Error("Unsupported push health state");
}

export function pushDeviceHealthPresentation(
	device: PushDeviceHealth,
): PushHealthPresentation {
	switch (device.health) {
		case "never_attempted":
			return {
				title: "Ready",
				description: "No notification has been handed off yet.",
				tone: "neutral",
				timestamp: null,
			};
		case "accepted":
			return {
				title: "Accepted by push service",
				description: "Device display is not confirmed.",
				tone: "positive",
				timestamp: device.lastAcceptedAt ?? device.lastAttemptAt,
			};
		case "temporary_issue":
			return {
				title: "Temporary handoff issue",
				description: "The latest handoff hit a temporary issue. New mail remains safe in your Inbox.",
				tone: "warning",
				timestamp: device.lastAttemptAt,
			};
		case "reenable_required":
			return {
				title: "Enable again",
				description: "Open the portal on this device and enable notifications again.",
				tone: "danger",
				timestamp: device.lastAttemptAt,
			};
	}
	throw new Error("Unsupported push device health state");
}
