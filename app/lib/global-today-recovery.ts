import type { QueryClient } from "@tanstack/react-query";
import type { GlobalTodayReadyResponse } from "../../shared/global-today.ts";
import { useUIStore } from "../hooks/useUIStore.ts";
import { evictRevokedMailbox } from "../queries/mailbox-change-feed.ts";
import { ApiError } from "../services/api.ts";
import { FollowUpReminderApiError } from "../services/follow-up-reminders.ts";

export type GlobalTodayFeedback = {
	kind: "success" | "error";
	message: string;
	offerRefresh?: boolean;
	redirectTo?: "/login";
};

export function recoverGlobalTodayReminderError(
	error: unknown,
	mailboxId: string,
	queryClient: QueryClient,
): GlobalTodayFeedback {
	if (error instanceof FollowUpReminderApiError && error.status === 401) {
		purgeAllCachedMailState(queryClient);
		return {
			kind: "error",
			message: "Your session ended. Cached Mailbox content was removed.",
			redirectTo: "/login",
		};
	}
	if (error instanceof FollowUpReminderApiError && error.status === 403) {
		evictRevokedMailbox(queryClient, mailboxId);
		return {
			kind: "error",
			message: "Mailbox access changed. Removed content was discarded and Today is refreshing.",
		};
	}
	if (
		error instanceof FollowUpReminderApiError &&
		(error.status === 409 || error.code === "STATE_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT")
	) {
		return {
			kind: "error",
			message: "The follow-up changed elsewhere and was not updated here. Refresh before trying again.",
			offerRefresh: true,
		};
	}
	return {
		kind: "error",
		message: "The follow-up was not changed. Refresh and try again.",
		offerRefresh: true,
	};
}

export function authorizedGlobalTodayMailboxIds(response: GlobalTodayReadyResponse) {
	return new Set([
		...response.mailboxes.map((mailbox) => mailbox.mailboxId),
		...response.failures.map((failure) => failure.mailboxId),
	]);
}

export function purgeRemovedGlobalTodayMailboxes(
	queryClient: QueryClient,
	previous: ReadonlySet<string>,
	current: ReadonlySet<string>,
): string[] {
	const removed = [...previous].filter((mailboxId) => !current.has(mailboxId));
	for (const mailboxId of removed) {
		evictRevokedMailbox(queryClient, mailboxId, { preserveGlobalToday: true });
	}
	return removed;
}

export function isGlobalTodayAuthorizationError(error: unknown) {
	return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

export function purgeAllCachedMailState(queryClient: QueryClient) {
	queryClient.clear();
	const ui = useUIStore.getState();
	ui.closeCompose(false);
	ui.closePanel();
}
