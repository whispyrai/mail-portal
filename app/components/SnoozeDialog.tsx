import { Button, Dialog, Input } from "@cloudflare/kumo";
import { ArrowCounterClockwiseIcon, ClockIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
	customLocalSnoozeTime,
	snoozePresetTime,
	type SnoozePreset,
} from "~/lib/snooze-time";
import { useSnooze, useUnsnooze } from "~/queries/snooze";
import type { SnoozeScope } from "../../shared/snooze";

export interface SnoozeDialogTarget {
	emailId: string;
	folderId: string;
	conversationId?: string | null;
	conversationCount?: number;
}

function scopeFor(target: SnoozeDialogTarget, conversation: boolean): SnoozeScope {
	return conversation && target.conversationId
		? {
				kind: "conversation",
				conversationId: target.conversationId,
				emailId: target.emailId,
				folderId: target.folderId,
			}
		: { kind: "message", emailId: target.emailId };
}

function localInputDefault(now = new Date()): string {
	const tomorrow = snoozePresetTime("tomorrow", now);
	const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60_000);
	return local.toISOString().slice(0, 16);
}

export default function SnoozeDialog({
	mailboxId,
	target,
	open,
	onOpenChange,
	onComplete,
}: {
	mailboxId: string;
	target: SnoozeDialogTarget;
	open: boolean;
	onOpenChange(open: boolean): void;
	onComplete?: () => void;
}) {
	const canUseConversation = Boolean(
		target.conversationId && (target.conversationCount ?? 1) > 1,
	);
	const [conversation, setConversation] = useState(canUseConversation);
	const [customValue, setCustomValue] = useState(() => localInputDefault());
	const [error, setError] = useState("");
	const [committedScope, setCommittedScope] = useState<SnoozeScope | null>(null);
	const snooze = useSnooze();
	const unsnooze = useUnsnooze();
	const scope = useMemo(
		() => scopeFor(target, conversation),
		[conversation, target],
	);

	useEffect(() => {
		if (!open) return;
		setConversation(canUseConversation);
		setCustomValue(localInputDefault());
		setError("");
		setCommittedScope(null);
	}, [canUseConversation, open, target.emailId]);

	const commit = (wakeAt: Date) => {
		setError("");
		snooze.mutate(
			{ mailboxId, scope, wakeAt: wakeAt.toISOString() },
			{
				onSuccess: () => {
					setCommittedScope(scope);
					onComplete?.();
				},
				onError: (mutationError) => setError(
					mutationError instanceof Error ? mutationError.message : "Could not snooze this mail.",
				),
			},
		);
	};

	const applyPreset = (preset: SnoozePreset) => commit(snoozePresetTime(preset));
	const applyCustom = (event: React.FormEvent) => {
		event.preventDefault();
		try {
			commit(customLocalSnoozeTime(customValue));
		} catch (timeError) {
			setError(timeError instanceof Error ? timeError.message : "Choose a valid future time.");
		}
	};
	const undo = () => {
		if (!committedScope) return;
		setError("");
		unsnooze.mutate(
			{ mailboxId, scope: committedScope },
			{
				onSuccess: () => {
					onOpenChange(false);
					onComplete?.();
				},
				onError: (mutationError) => setError(
					mutationError instanceof Error ? mutationError.message : "Could not undo Snooze.",
				),
			},
		);
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog size="sm" className="w-[calc(100vw-1rem)] p-5 sm:w-auto sm:p-6">
				{committedScope ? (
					<>
						<Dialog.Title className="text-base font-semibold text-kumo-default">
							Mail snoozed
						</Dialog.Title>
						<Dialog.Description className="mt-2 text-sm text-kumo-subtle">
							It will return automatically. This changes the mailbox for every member.
						</Dialog.Description>
						{error && <p role="alert" className="mt-3 text-sm text-kumo-danger">{error}</p>}
						<div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
							<Button variant="secondary" onClick={() => onOpenChange(false)}>Done</Button>
							<Button
								icon={<ArrowCounterClockwiseIcon size={17} />}
								onClick={undo}
								disabled={unsnooze.isPending}
							>
								{unsnooze.isPending ? "Undoing…" : "Undo"}
							</Button>
						</div>
					</>
				) : (
					<>
						<Dialog.Title className="text-base font-semibold text-kumo-default">
							Snooze mail
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm text-kumo-subtle">
							Hide it until a chosen local time. Snooze and Return are mailbox-wide and visible to every shared member. A new reply wakes the conversation immediately.
						</Dialog.Description>
						{canUseConversation && (
							<fieldset className="mt-4">
								<legend className="text-sm font-medium text-kumo-default">Scope</legend>
								<div className="mt-2 grid grid-cols-2 gap-2">
									<Button
										type="button"
										variant={!conversation ? "primary" : "secondary"}
										aria-pressed={!conversation}
										onClick={() => setConversation(false)}
									>
										This message
									</Button>
									<Button
										type="button"
										variant={conversation ? "primary" : "secondary"}
										aria-pressed={conversation}
										onClick={() => setConversation(true)}
									>
										Conversation
									</Button>
								</div>
							</fieldset>
						)}
						<div className="mt-5 grid gap-2 sm:grid-cols-3">
							<Button type="button" variant="secondary" onClick={() => applyPreset("later_today")} disabled={snooze.isPending}>Later today</Button>
							<Button type="button" variant="secondary" onClick={() => applyPreset("tomorrow")} disabled={snooze.isPending}>Tomorrow</Button>
							<Button type="button" variant="secondary" onClick={() => applyPreset("next_week")} disabled={snooze.isPending}>Next week</Button>
						</div>
						<form onSubmit={applyCustom} className="mt-5 space-y-3 border-t border-kumo-line pt-4">
							<Input label="Custom local date and time" type="datetime-local" value={customValue} onChange={(event) => setCustomValue(event.target.value)} required />
							{error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
							<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
								<Dialog.Close render={(props) => <Button {...props} variant="secondary">Cancel</Button>} />
								<Button type="submit" icon={<ClockIcon size={17} />} disabled={snooze.isPending}>
									{snooze.isPending ? "Snoozing…" : "Snooze"}
								</Button>
							</div>
						</form>
					</>
				)}
			</Dialog>
		</Dialog.Root>
	);
}
