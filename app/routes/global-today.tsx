import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { markGlobalTodayBriefStale, useGlobalTodayBrief } from "~/queries/global-today-brief";

function observedTodaySignature(response: ReturnType<typeof useGlobalToday>["data"]) {
	if (response?.state !== "ready" || !response.complete) return null;
	return JSON.stringify({
		day: response.day,
		currentMailboxCount: response.currentMailboxCount,
		mailboxes: response.mailboxes,
		failures: response.failures,
		totals: response.totals,
	});
}

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
	const deterministicTodayIsComplete = today.data?.state === "ready" && today.data.complete;
	const brief = useGlobalTodayBrief(timeZone, deterministicTodayIsComplete);
	const operation = useFollowUpReminderOperation();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const online = useOnlineState();
	const operationIds = useRef(new Map<string, string>());
	const refreshedAccessChange = useRef<string | null>(null);
	const priorAuthorizedMailboxIds = useRef<Set<string> | null>(null);
	const priorTodaySignature = useRef<string | null>(null);
	const [pendingReminderKeys, setPendingReminderKeys] = useState<Set<string>>(() => new Set());
	const [feedback, setFeedback] = useState<GlobalTodayFeedback | null>(null);
	const authorizationError = isGlobalTodayAuthorizationError(today.error);
	const briefError = brief.refreshError ?? brief.error;
	const briefAuthorizationError = isGlobalTodayAuthorizationError(briefError);

	useLayoutEffect(() => {
		if (authorizationError || briefAuthorizationError) {
			purgeAllCachedMailState(queryClient);
			const error = authorizationError ? today.error : briefError;
			window.location.replace(error instanceof Error && "status" in error && error.status === 401 ? "/login" : "/mailboxes");
			return;
		}
		const response = today.data;
		if (response?.state !== "ready") return;
		const current = authorizedGlobalTodayMailboxIds(response);
		if (priorAuthorizedMailboxIds.current) {
			purgeRemovedGlobalTodayMailboxes(queryClient, priorAuthorizedMailboxIds.current, current);
		}
		priorAuthorizedMailboxIds.current = current;
	}, [authorizationError, briefAuthorizationError, briefError, queryClient, today.data, today.error]);

	useLayoutEffect(() => {
		const signature = observedTodaySignature(today.data);
		if (!signature) return;
		if (priorTodaySignature.current && priorTodaySignature.current !== signature) {
			markGlobalTodayBriefStale(queryClient, timeZone);
		}
		priorTodaySignature.current = signature;
	}, [queryClient, timeZone, today.data]);

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
			markGlobalTodayBriefStale(queryClient, timeZone);
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
	}, [operation, pendingReminderKeys, queryClient, timeZone]);

	const safeBrief = useMemo(() => {
		const response = today.data;
		if (response?.state !== "ready") return undefined;
		if (!response.complete) return { state: "overview_incomplete" as const };
		const candidate = brief.data;
		if (!candidate || (candidate.state !== "generated" && candidate.state !== "cached")) return candidate;
		const mailboxes = new Set(response.mailboxes.map((mailbox) => mailbox.mailboxId));
		return candidate.items.every((item) =>
			mailboxes.has(item.candidate.mailboxId) && item.sources.every((source) => mailboxes.has(source.mailboxId)))
			? candidate
			: { state: "overview_incomplete" as const };
	}, [brief.data, today.data]);

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
		aiBrief={brief.isExplicitlyRefreshing ? undefined : safeBrief}
		aiBriefIsLoading={deterministicTodayIsComplete && (brief.isLoading || brief.isExplicitlyRefreshing)}
		aiBriefIsRefreshing={brief.isExplicitlyRefreshing}
		aiBriefError={deterministicTodayIsComplete && !briefAuthorizationError && briefError instanceof Error ? briefError : null}
		onRefreshAiBrief={() => { void brief.refresh().catch(() => undefined); }}
	/>;
}
