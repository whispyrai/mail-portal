import { InternalFolders } from "../../shared/folders.ts";

export const MAILBOX_HOURLY_SEND_LIMIT = 20;
export const MAILBOX_DAILY_SEND_LIMIT = 100;

export type DispatchQuotaSnapshot = {
	sentLastHour: number;
	sentLastDay: number;
	activeReservations: number;
	oldestSentInHour?: string;
	oldestSentInDay?: string;
	now: string;
};

export type DispatchQuotaPlan =
	| { allowed: true }
	| {
			allowed: false;
			code: "mailbox_hourly_send_limit" | "mailbox_daily_send_limit";
			retryAt: string;
	  };

function retryAfterWindow(
	oldestSentAt: string | undefined,
	windowMs: number,
	now: string,
): string {
	const oldest = oldestSentAt ? Date.parse(oldestSentAt) : Number.NaN;
	const nowMs = Date.parse(now);
	const candidate = Number.isFinite(oldest)
		? oldest + windowMs + 1_000
		: nowMs + 60_000;
	return new Date(Math.max(candidate, nowMs + 1_000)).toISOString();
}

/**
 * Decide whether a claimed delivery may reach the provider. The active
 * reservation count includes the delivery being evaluated, so equality with a
 * limit is allowed and any count above it must wait.
 */
export function planDispatchQuota(
	snapshot: DispatchQuotaSnapshot,
): DispatchQuotaPlan {
	const hourlyReserved = snapshot.sentLastHour + snapshot.activeReservations;
	if (hourlyReserved > MAILBOX_HOURLY_SEND_LIMIT) {
		return {
			allowed: false,
			code: "mailbox_hourly_send_limit",
			retryAt: retryAfterWindow(
				snapshot.oldestSentInHour,
				60 * 60_000,
				snapshot.now,
			),
		};
	}

	const dailyReserved = snapshot.sentLastDay + snapshot.activeReservations;
	if (dailyReserved > MAILBOX_DAILY_SEND_LIMIT) {
		return {
			allowed: false,
			code: "mailbox_daily_send_limit",
			retryAt: retryAfterWindow(
				snapshot.oldestSentInDay,
				24 * 60 * 60_000,
				snapshot.now,
			),
		};
	}

	return { allowed: true };
}

export function nextBulkEnqueueAt(nowMs: number, randomFraction: number): number {
	const boundedFraction = Math.max(0, Math.min(0.999_999, randomFraction));
	return nowMs + 1_500 + Math.floor(boundedFraction * 1_000);
}

export const CANCELLED_OUTBOUND_FOLDER_ID = InternalFolders.RETIRED_OUTBOUND;

export function cancellationRecoveryPending(
	status: string,
	snapshotFolderId: string | null | undefined,
): boolean {
	return status === "cancelled" &&
		snapshotFolderId !== CANCELLED_OUTBOUND_FOLDER_ID;
}

export function planCancelledOutboundRecovery(input: {
	sourceDraftEquivalent: boolean;
}): {
	folderId: typeof CANCELLED_OUTBOUND_FOLDER_ID;
	createRecoveredDraft: boolean;
	deleteSnapshotAttachments: boolean;
} {
	return input.sourceDraftEquivalent
		? {
				folderId: CANCELLED_OUTBOUND_FOLDER_ID,
				createRecoveredDraft: false,
				deleteSnapshotAttachments: true,
			}
		: {
				folderId: CANCELLED_OUTBOUND_FOLDER_ID,
				createRecoveredDraft: true,
				deleteSnapshotAttachments: false,
			};
}
