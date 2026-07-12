import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import MailboxSplitView from "~/components/MailboxSplitView";
import TodayWorkspace, {
	type TodayMutationFeedback,
	type TodayReminderAction,
} from "~/components/TodayWorkspace";
import {
	reminderOperationIdentity,
	stableReminderOperationId,
} from "~/lib/today-workspace";
import {
	useFollowUpReminderOperation,
	useFollowUpReminders,
} from "~/queries/follow-up-reminders";
import { useUIStore } from "~/hooks/useUIStore";

function originLabel(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	}).format(new Date(value));
}

function rescheduledLabel(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

export default function TodayRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const reminders = useFollowUpReminders(mailboxId);
	const operation = useFollowUpReminderOperation();
	const { selectedEmailId, selectEmail, closePanel } = useUIStore();
	const [now, setNow] = useState(() => new Date());
	const [mutationFeedback, setMutationFeedback] =
		useState<TodayMutationFeedback | null>(null);
	const operationIds = useRef(new Map<string, string>());
	const feedbackByMailbox = useRef(new Map<string, TodayMutationFeedback>());
	const pendingByMailbox = useRef(new Map<string, string>());
	const [, setPendingRevision] = useState(0);
	const mailboxContext = useRef(mailboxId);

	useEffect(() => {
		closePanel();
		mailboxContext.current = mailboxId;
		setNow(new Date());
		setMutationFeedback(
			mailboxId ? feedbackByMailbox.current.get(mailboxId) ?? null : null,
		);
		const timer = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(timer);
	}, [closePanel, mailboxId]);

	const handleAction = useCallback(
		(input: TodayReminderAction) => {
			if (!mailboxId || pendingByMailbox.current.has(mailboxId)) return;
			const { reminder, action } = input;
			const remindAt = input.action === "snooze" ? input.remindAt : undefined;
			const identity = reminderOperationIdentity({
				mailboxId,
				reminderId: reminder.id,
				action,
				expectedVersion: reminder.version,
				remindAt,
			});
			const operationId = stableReminderOperationId(
				operationIds.current,
				identity,
			);
			const origin = originLabel(reminder.baselineMessageDate);
			const base = {
				mailboxId,
				reminderId: reminder.id,
				operationId,
				expectedVersion: reminder.version,
			};
			const variables = input.action === "snooze"
				? { ...base, action: "snooze" as const, remindAt: input.remindAt }
				: { ...base, action: input.action };

			const pendingFeedback: TodayMutationFeedback = {
				kind: "pending",
				reminderId: reminder.id,
				message: `Updating the follow-up from ${origin}…`,
			};
			pendingByMailbox.current.set(mailboxId, reminder.id);
			feedbackByMailbox.current.set(mailboxId, pendingFeedback);
			setMutationFeedback(pendingFeedback);
			setPendingRevision((revision) => revision + 1);
			void operation.mutateAsync(variables)
				.then(() => {
					operationIds.current.delete(identity);
					const message = input.action === "complete"
						? `Follow-up from ${origin} marked complete.`
						: input.action === "dismiss"
							? `Follow-up from ${origin} dismissed.`
							: `Follow-up from ${origin} rescheduled for ${rescheduledLabel(remindAt!)}.`;
					const successFeedback: TodayMutationFeedback = {
						kind: "success",
						reminderId: reminder.id,
						message,
					};
					feedbackByMailbox.current.set(mailboxId, successFeedback);
					if (mailboxContext.current === mailboxId) {
						setMutationFeedback(successFeedback);
					}
				})
				.catch((error) => {
					const detail = error instanceof Error
						? error.message
						: "The follow-up could not be updated.";
					const errorFeedback: TodayMutationFeedback = {
						kind: "error",
						reminderId: reminder.id,
						message: `Follow-up from ${origin} was not updated. ${detail} Retry the same action to continue safely.`,
					};
					feedbackByMailbox.current.set(mailboxId, errorFeedback);
					if (mailboxContext.current === mailboxId) {
						setMutationFeedback(errorFeedback);
					}
				})
				.finally(() => {
					pendingByMailbox.current.delete(mailboxId);
					if (mailboxContext.current === mailboxId) {
						setPendingRevision((revision) => revision + 1);
					}
				});
		},
		[mailboxId, operation],
	);
	const pendingReminderId = mailboxId
		? pendingByMailbox.current.get(mailboxId) ?? null
		: null;

	return (
		<MailboxSplitView selectedEmailId={selectedEmailId}>
			<TodayWorkspace
				reminders={reminders.data ?? []}
				isLoading={reminders.isLoading}
				error={reminders.error}
				isMutating={Boolean(pendingReminderId)}
				mutationReminderId={pendingReminderId}
				mutationFeedback={mutationFeedback}
				now={now}
				onOpenConversation={(reminder) =>
					selectEmail(reminder.baselineMessageId)
				}
				onAction={handleAction}
				onRetry={() => reminders.refetch()}
				onDismissFeedback={() => {
					if (mailboxId) feedbackByMailbox.current.delete(mailboxId);
					setMutationFeedback(null);
				}}
			/>
		</MailboxSplitView>
	);
}
