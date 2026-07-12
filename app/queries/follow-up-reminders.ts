import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	FollowUpReminder,
	FollowUpReminderView,
} from "../../shared/follow-up-reminders.ts";
import {
	applyFollowUpReminderOperation,
	createFollowUpReminder,
	listFollowUpReminders,
	type CreateFollowUpReminderRequest,
	type FollowUpReminderOperationRequest,
} from "../services/follow-up-reminders.ts";

export const followUpReminderKeys = {
	list: (mailboxId: string) => ["follow-up-reminders", mailboxId] as const,
};

export type CreateFollowUpReminderVariables = CreateFollowUpReminderRequest & {
	mailboxId: string;
};

export type FollowUpReminderOperationVariables =
	FollowUpReminderOperationRequest & {
		mailboxId: string;
		reminderId: string;
	};

export function reconcileFollowUpReminderList(
	current: readonly FollowUpReminderView[] | undefined,
	reminder: FollowUpReminder,
): FollowUpReminderView[] {
	const prior = current?.find((item) => item.id === reminder.id);
	const withoutCurrent = (current ?? []).filter((item) => item.id !== reminder.id);
	if (reminder.state !== "active") return withoutCurrent;
	return [
		...withoutCurrent,
		{ ...reminder, preview: prior?.preview ?? null },
	].sort(
		(left, right) =>
			Date.parse(left.remindAt) - Date.parse(right.remindAt) ||
			left.id.localeCompare(right.id),
	);
}

export function useFollowUpReminders(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId
			? followUpReminderKeys.list(mailboxId)
			: ["follow-up-reminders", "disabled"],
		queryFn: () => listFollowUpReminders(mailboxId!),
		enabled: Boolean(mailboxId),
		staleTime: 30_000,
		refetchInterval: 30_000,
		retry: 1,
	});
}

function useReconcileFollowUpReminder() {
	const queryClient = useQueryClient();
	return (mailboxId: string, reminder: FollowUpReminder) => {
		queryClient.setQueryData<FollowUpReminderView[]>(
			followUpReminderKeys.list(mailboxId),
			(current) => reconcileFollowUpReminderList(current, reminder),
		);
		void queryClient.invalidateQueries({
			queryKey: followUpReminderKeys.list(mailboxId),
		});
	};
}

export function useCreateFollowUpReminder() {
	const reconcile = useReconcileFollowUpReminder();
	return useMutation({
		mutationFn: ({ mailboxId, ...input }: CreateFollowUpReminderVariables) =>
			createFollowUpReminder(mailboxId, input),
		onSuccess: (reminder, { mailboxId }) => reconcile(mailboxId, reminder),
	});
}

export function useFollowUpReminderOperation() {
	const reconcile = useReconcileFollowUpReminder();
	return useMutation({
		mutationFn: ({
			mailboxId,
			reminderId,
			...input
		}: FollowUpReminderOperationVariables) =>
			applyFollowUpReminderOperation(mailboxId, reminderId, input),
		onSuccess: (reminder, { mailboxId }) => reconcile(mailboxId, reminder),
	});
}
