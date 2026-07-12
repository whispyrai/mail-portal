import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import GlobalTodayWorkspace from "~/components/global/GlobalTodayWorkspace";
import type { TodayReminderAction } from "~/components/TodayWorkspace";
import {
	authorizedGlobalTodayMailboxIds,
	isGlobalTodayAuthorizationError,
	purgeAllCachedMailState,
	purgeRemovedGlobalTodayMailboxes,
	recoverGlobalTodayReminderError,
	type GlobalTodayFeedback,
} from "~/lib/global-today-recovery";
import { reminderOperationIdentity, stableReminderOperationId } from "~/lib/today-workspace";
import { useFollowUpReminderOperation } from "~/queries/follow-up-reminders";
import { globalTodayKeys, useGlobalToday } from "~/queries/global-today";

function useOnlineState() {
	const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
	useEffect(() => {
		const update = () => setOnline(navigator.onLine);
		window.addEventListener("online", update);
		window.addEventListener("offline", update);
		return () => {
			window.removeEventListener("online", update);
			window.removeEventListener("offline", update);
		};
	}, []);
	return online;
}

export default function GlobalTodayRoute() {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	const today = useGlobalToday(timeZone);
	const operation = useFollowUpReminderOperation();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const online = useOnlineState();
	const operationIds = useRef(new Map<string, string>());
	const refreshedAccessChange = useRef<string | null>(null);
	const priorAuthorizedMailboxIds = useRef<Set<string> | null>(null);
	const [pendingReminderKeys, setPendingReminderKeys] = useState<Set<string>>(() => new Set());
	const [feedback, setFeedback] = useState<GlobalTodayFeedback | null>(null);
	const authorizationError = isGlobalTodayAuthorizationError(today.error);

	useLayoutEffect(() => {
		if (authorizationError) {
			purgeAllCachedMailState(queryClient);
			window.location.replace(today.error instanceof Error && "status" in today.error && today.error.status === 401 ? "/login" : "/mailboxes");
			return;
		}
		const response = today.data;
		if (response?.state !== "ready") return;
		const current = authorizedGlobalTodayMailboxIds(response);
		if (priorAuthorizedMailboxIds.current) {
			purgeRemovedGlobalTodayMailboxes(queryClient, priorAuthorizedMailboxIds.current, current);
		}
		priorAuthorizedMailboxIds.current = current;
	}, [authorizationError, queryClient, today.data, today.error]);

	useEffect(() => {
		const response = today.data;
		if (response?.state !== "ready" || !response.accessChanged || refreshedAccessChange.current === response.generatedAt) return;
		refreshedAccessChange.current = response.generatedAt;
		void today.refetch();
	}, [today.data, today.refetch]);

	const handleAction = useCallback((input: TodayReminderAction) => {
		const mailboxId = input.reminder.mailboxAddress;
		const key = `${mailboxId}:${input.reminder.id}`;
		if (pendingReminderKeys.has(key)) return;
		const remindAt = input.action === "snooze" ? input.remindAt : undefined;
		const identity = reminderOperationIdentity({ mailboxId, reminderId: input.reminder.id, action: input.action, expectedVersion: input.reminder.version, remindAt });
		const operationId = stableReminderOperationId(operationIds.current, identity);
		setPendingReminderKeys((current) => new Set(current).add(key));
		setFeedback(null);
		const variables = input.action === "snooze" ? {
			mailboxId,
			reminderId: input.reminder.id,
			operationId,
			expectedVersion: input.reminder.version,
			action: "snooze" as const,
			remindAt: input.remindAt,
		} : {
			mailboxId,
			reminderId: input.reminder.id,
			operationId,
			expectedVersion: input.reminder.version,
			action: input.action,
		};
		void operation.mutateAsync(variables).then(() => {
			operationIds.current.delete(identity);
			setFeedback({ kind: "success", message: input.action === "complete" ? "Follow-up marked complete." : input.action === "dismiss" ? "Follow-up dismissed." : "Follow-up rescheduled." });
			void queryClient.invalidateQueries({ queryKey: globalTodayKeys.all });
		}).catch((error) => {
			const recovery = recoverGlobalTodayReminderError(error, mailboxId, queryClient);
			setFeedback(recovery);
			if (recovery.redirectTo) {
				window.location.replace(recovery.redirectTo);
				return;
			}
			if (!recovery.offerRefresh) {
				void queryClient.invalidateQueries({ queryKey: globalTodayKeys.all });
			}
		}).finally(() => {
			setPendingReminderKeys((current) => {
				const next = new Set(current);
				next.delete(key);
				return next;
			});
		});
	}, [operation, pendingReminderKeys, queryClient]);

	return <GlobalTodayWorkspace
		response={authorizationError ? undefined : today.data}
		isLoading={today.isLoading}
		isRefreshing={today.isFetching}
		error={today.error instanceof Error ? today.error : null}
		isOnline={online}
		pendingReminderKeys={pendingReminderKeys}
		feedback={feedback}
		onOpenConversation={(mailboxId, messageId) => navigate(`/mailbox/${encodeURIComponent(mailboxId)}/open/${encodeURIComponent(messageId)}`)}
		onAction={handleAction}
		onRetry={() => void today.refetch()}
	/>;
}
