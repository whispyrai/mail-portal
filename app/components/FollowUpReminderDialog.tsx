import { Button, Dialog, Input } from "@cloudflare/kumo";
import {
	BellRingingIcon,
	CheckCircleIcon,
	ClockCounterClockwiseIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { customLocalSnoozeTime, snoozePresetTime } from "~/lib/snooze-time";
import {
	useCreateFollowUpReminder,
	useFollowUpReminderOperation,
} from "~/queries/follow-up-reminders";
import type { FollowUpReminder } from "../../shared/follow-up-reminders.ts";

export type FollowUpReminderDialogProps = {
	mailboxId: string;
	emailId: string;
	reminder?: FollowUpReminder | null;
	open: boolean;
	onOpenChange(open: boolean): void;
	onMutationSuccess?(reminder: FollowUpReminder): void;
};

export type FollowUpReminderControlProps = Omit<
	FollowUpReminderDialogProps,
	"open" | "onOpenChange"
> & {
	className?: string;
};

type SuccessKind = "set" | "moved" | "completed" | "removed";

function toLocalInput(date: Date): string {
	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

function formatLocalTime(value: string): string {
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "Unknown time";
	return new Intl.DateTimeFormat(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function errorMessage(error: unknown): string {
	return error instanceof Error
		? error.message
		: "The reminder could not be updated. Try again.";
}

const SUCCESS_COPY: Record<SuccessKind, { title: string; detail: string }> = {
	set: {
		title: "Reminder set",
		detail: "It is private to you. The email and shared mailbox were not changed.",
	},
	moved: {
		title: "Reminder rescheduled",
		detail: "Your private follow-up is scheduled for the new time.",
	},
	completed: {
		title: "Marked complete",
		detail: "Your private reminder is complete. The email was not changed.",
	},
	removed: {
		title: "Reminder removed",
		detail: "Your private reminder was removed. The email was not changed.",
	},
};

export function FollowUpReminderDialog({
	mailboxId,
	emailId,
	reminder,
	open,
	onOpenChange,
	onMutationSuccess,
}: FollowUpReminderDialogProps) {
	const createReminder = useCreateFollowUpReminder();
	const reminderOperation = useFollowUpReminderOperation();
	const [customValue, setCustomValue] = useState("");
	const [error, setError] = useState("");
	const [success, setSuccess] = useState<SuccessKind | null>(null);
	const requestIds = useRef(new Map<string, string>());
	const initializedContext = useRef<string | null>(null);
	const pending = createReminder.isPending || reminderOperation.isPending;

	useEffect(() => {
		if (!open) {
			initializedContext.current = null;
			return;
		}
		const context = `${mailboxId}:${emailId}`;
		if (initializedContext.current === context) return;
		initializedContext.current = context;
		setCustomValue(
			toLocalInput(
				reminder ? new Date(reminder.remindAt) : snoozePresetTime("tomorrow"),
			),
		);
		setError("");
		setSuccess(null);
		requestIds.current.clear();
		createReminder.reset();
		reminderOperation.reset();
	}, [emailId, mailboxId, open, reminder, createReminder, reminderOperation]);

	const requestId = (identity: string) => {
		const existing = requestIds.current.get(identity);
		if (existing) return existing;
		const created = `follow-up-${crypto.randomUUID()}`;
		requestIds.current.set(identity, created);
		return created;
	};

	const finish = (kind: SuccessKind, updated: FollowUpReminder) => {
		setSuccess(kind);
		setError("");
		onMutationSuccess?.(updated);
	};

	const choosePreset = (preset: "later_today" | "tomorrow" | "next_week") => {
		setCustomValue(toLocalInput(snoozePresetTime(preset)));
		setError("");
	};

	const saveTime = (event: React.FormEvent) => {
		event.preventDefault();
		setError("");
		let remindAt: string;
		try {
			remindAt = customLocalSnoozeTime(customValue).toISOString();
		} catch (timeError) {
			setError(errorMessage(timeError));
			return;
		}
		if (reminder) {
			reminderOperation.mutate(
				{
					mailboxId,
					reminderId: reminder.id,
					action: "snooze",
					operationId: requestId(`snooze:${reminder.version}:${remindAt}`),
					expectedVersion: reminder.version,
					remindAt,
				},
				{
					onSuccess: (updated) => finish("moved", updated),
					onError: (mutationError) => setError(errorMessage(mutationError)),
				},
			);
			return;
		}
		createReminder.mutate(
			{
				mailboxId,
				emailId,
				remindAt,
				idempotencyKey: requestId(`create:${emailId}:${remindAt}`),
			},
			{
				onSuccess: (created) => finish("set", created),
				onError: (mutationError) => setError(errorMessage(mutationError)),
			},
		);
	};

	const applyTerminalAction = (action: "complete" | "dismiss") => {
		if (!reminder) return;
		setError("");
		reminderOperation.mutate(
			{
				mailboxId,
				reminderId: reminder.id,
				action,
				operationId: requestId(`${action}:${reminder.version}`),
				expectedVersion: reminder.version,
			},
			{
				onSuccess: (updated) => finish(action === "complete" ? "completed" : "removed", updated),
				onError: (mutationError) => setError(errorMessage(mutationError)),
			},
		);
	};

	const changeOpen = (next: boolean) => {
		if (!pending) onOpenChange(next);
	};

	return (
		<Dialog.Root open={open} onOpenChange={changeOpen}>
			<Dialog size="sm" className="w-[calc(100vw-1rem)] max-h-[calc(100dvh-1rem)] overflow-y-auto p-5 sm:w-auto sm:p-6">
				{success ? (
					<div role="status">
						<CheckCircleIcon size={24} weight="duotone" className="text-kumo-success" aria-hidden="true" />
						<Dialog.Title className="mt-3 text-base font-semibold text-kumo-default">
							{SUCCESS_COPY[success].title}
						</Dialog.Title>
						<Dialog.Description className="mt-2 text-sm leading-6 text-kumo-subtle">
							{SUCCESS_COPY[success].detail}
						</Dialog.Description>
						<div className="mt-5 flex justify-end">
							<Button className="min-h-11 w-full sm:w-auto" onClick={() => changeOpen(false)}>Done</Button>
						</div>
					</div>
				) : (
					<>
						<p className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-kumo-subtle">
							Private follow-up
						</p>
						<Dialog.Title className="mt-2 text-lg font-semibold text-kumo-default">
							{reminder ? "Follow-up reminder" : "Remind me"}
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm leading-6 text-kumo-subtle">
							Only you can see this reminder, including in a shared mailbox. A new reply completes it automatically.
						</Dialog.Description>

						{reminder && (
							<div className="mt-4 border-y border-kumo-line py-4">
								<p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Currently due</p>
								<time dateTime={reminder.remindAt} className="mt-1 block text-sm font-medium text-kumo-default">
									{formatLocalTime(reminder.remindAt)}
								</time>
								<div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
									<Button className="min-h-11" variant="secondary" icon={<CheckCircleIcon size={17} />} disabled={pending} loading={reminderOperation.isPending && reminderOperation.variables?.action === "complete"} onClick={() => applyTerminalAction("complete")}>Mark complete</Button>
									<Button className="min-h-11" variant="ghost" icon={<TrashIcon size={17} />} disabled={pending} loading={reminderOperation.isPending && reminderOperation.variables?.action === "dismiss"} onClick={() => applyTerminalAction("dismiss")}>Remove reminder</Button>
								</div>
							</div>
						)}

						<form onSubmit={saveTime} className="mt-5">
							<fieldset disabled={pending}>
								<legend className="text-sm font-medium text-kumo-default">
									{reminder ? "Reschedule reminder" : "When should this follow-up appear?"}
								</legend>
								<div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
									<Button className="min-h-11" type="button" variant="secondary" onClick={() => choosePreset("later_today")}>Later today</Button>
									<Button className="min-h-11" type="button" variant="secondary" onClick={() => choosePreset("tomorrow")}>Tomorrow morning</Button>
									<Button className="min-h-11" type="button" variant="secondary" onClick={() => choosePreset("next_week")}>Next Monday</Button>
								</div>
								<div className="mt-4">
									<Input label="Local date and time" type="datetime-local" value={customValue} onChange={(event) => { setCustomValue(event.target.value); setError(""); }} required />
								</div>
							</fieldset>
							{error && <p role="alert" className="mt-3 text-sm leading-5 text-kumo-danger">{error}</p>}
							<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
								<Button className="min-h-11 w-full sm:w-auto" type="button" variant="secondary" disabled={pending} onClick={() => changeOpen(false)}>
									{reminder ? "Keep current reminder" : "Not now"}
								</Button>
								<Button className="min-h-11 w-full sm:w-auto" type="submit" icon={reminder ? <ClockCounterClockwiseIcon size={17} /> : <BellRingingIcon size={17} />} loading={pending} disabled={pending}>
									{reminder ? "Reschedule reminder" : "Set reminder"}
								</Button>
							</div>
						</form>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}

export function FollowUpReminderControl({
	mailboxId,
	emailId,
	reminder,
	onMutationSuccess,
	className,
}: FollowUpReminderControlProps) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				className={`min-h-11 ${className ?? ""}`}
				icon={<BellRingingIcon size={18} weight={reminder ? "fill" : "regular"} />}
				onClick={() => setOpen(true)}
			>
				{reminder ? "Edit reminder" : "Remind me"}
			</Button>
			<FollowUpReminderDialog mailboxId={mailboxId} emailId={emailId} reminder={reminder} open={open} onOpenChange={setOpen} onMutationSuccess={onMutationSuccess} />
		</>
	);
}
