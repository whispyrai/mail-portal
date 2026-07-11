export const MIN_SCHEDULE_LEAD_MS = 60_000;
export const SEND_UNDO_WINDOW_MS = 10_000;

export type OutboundScheduleValidation =
	| {
			ok: true;
			requestedAt: string;
			undoUntil: string;
			scheduledFor?: string;
	  }
	| { ok: false; error: string };

export function outboundScheduleHorizon(now = new Date()): Date {
	const horizon = new Date(now);
	horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
	return horizon;
}

/**
 * Authoritative timing policy shared by every outbound enqueue route.
 * Scheduled mail has a lead window so a request that arrived too late cannot
 * silently turn into an immediate send.
 */
export function validateOutboundSchedule(
	scheduledFor: string | undefined,
	now = new Date(),
): OutboundScheduleValidation {
	const requestedAt = now.toISOString();
	if (!scheduledFor) {
		return {
			ok: true,
			requestedAt,
			undoUntil: new Date(now.getTime() + SEND_UNDO_WINDOW_MS).toISOString(),
		};
	}

	const scheduled = new Date(scheduledFor);
	if (
		!Number.isFinite(scheduled.getTime()) ||
		scheduled.getTime() - now.getTime() < MIN_SCHEDULE_LEAD_MS
	) {
		return {
			ok: false,
			error: "Scheduled delivery must be at least one minute in the future.",
		};
	}
	if (scheduled.getTime() > outboundScheduleHorizon(now).getTime()) {
		return {
			ok: false,
			error: "Scheduled delivery must be within one year.",
		};
	}

	return {
		ok: true,
		requestedAt,
		undoUntil: requestedAt,
		scheduledFor: scheduled.toISOString(),
	};
}
