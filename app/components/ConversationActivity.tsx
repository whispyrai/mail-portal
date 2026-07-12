import { Button, Loader } from "@cloudflare/kumo";
import {
	CaretDownIcon,
	CaretUpIcon,
	ClockCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { useId, useState } from "react";
import { CONVERSATION_ACTIVITY_LABELS } from "../../shared/conversation-activity.ts";
import { useConversationActivity } from "../queries/conversation-activity.ts";
import { ConversationActivityApiError } from "../services/conversation-activity.ts";

export type ConversationActivityProps = {
	mailboxId: string;
	emailId: string;
	isSharedMailbox: boolean;
};

function occurredAtLabel(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function errorKind(error: unknown): "access" | "missing" | "unavailable" {
	if (error instanceof ConversationActivityApiError) {
		if (error.status === 403) return "access";
		if (error.status === 404) return "missing";
	}
	return "unavailable";
}

export default function ConversationActivity({
	mailboxId,
	emailId,
	isSharedMailbox,
}: ConversationActivityProps) {
	const [expanded, setExpanded] = useState(false);
	const contentId = useId();
	const activity = useConversationActivity(mailboxId, emailId, expanded);
	const failure = errorKind(activity.error);
	const accessChanged = activity.isError && failure === "access";
	const anchorMissing = activity.isError && failure === "missing";
	const initialError = activity.isError && activity.items.length === 0;
	const paginationError = activity.isFetchNextPageError;

	return (
		<section
			className="border-b border-kumo-line bg-kumo-base"
			aria-labelledby={`${contentId}-heading`}
		>
			<button
				type="button"
				className="flex min-h-12 w-full items-center gap-2 rounded-none px-4 text-left text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-brand sm:px-5"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				aria-controls={contentId}
			>
				<ClockCounterClockwiseIcon
					size={17}
					className="shrink-0 text-kumo-subtle"
					aria-hidden="true"
				/>
				<span id={`${contentId}-heading`} className="font-semibold">
					Activity
				</span>
				{expanded ? (
					<CaretUpIcon size={15} className="ms-auto shrink-0" aria-hidden="true" />
				) : (
					<CaretDownIcon size={15} className="ms-auto shrink-0" aria-hidden="true" />
				)}
			</button>

			{expanded && (
				<div id={contentId}>
					{isSharedMailbox && (
						<p className="border-t border-kumo-line bg-kumo-recessed px-4 py-2.5 text-xs leading-5 text-kumo-strong sm:px-5">
							Actions here affect this mailbox and identify who performed them.
						</p>
					)}

					{activity.isLoading ? (
						<div
							role="status"
							aria-live="polite"
							className="flex min-h-24 items-center justify-center gap-2 px-4 py-6 text-sm text-kumo-subtle"
						>
							<Loader size="sm" />
							Loading activity…
						</div>
					) : accessChanged ? (
						<div role="alert" className="px-4 pb-4 pt-3 text-sm sm:px-5">
							<p className="font-medium text-kumo-default">Mailbox access changed.</p>
							<p className="mt-1 leading-5 text-kumo-subtle">
								Activity is no longer available for this mailbox.
							</p>
						</div>
					) : anchorMissing ? (
						<div role="alert" className="px-4 pb-4 pt-3 text-sm sm:px-5">
							<p className="font-medium text-kumo-default">
								Conversation is no longer available.
							</p>
							<p className="mt-1 leading-5 text-kumo-subtle">
								Close this message and refresh the mailbox.
							</p>
						</div>
					) : initialError ? (
						<div role="alert" className="px-4 pb-4 pt-3 text-sm sm:px-5">
							<p className="font-medium text-kumo-default">Activity could not be loaded.</p>
							<p className="mt-1 leading-5 text-kumo-subtle">
								No mail was changed. Try again when you’re ready.
							</p>
							<Button
								className="mt-3 min-h-11"
								variant="secondary"
								onClick={() => activity.refetch()}
								disabled={activity.isFetching}
							>
								Retry
							</Button>
						</div>
					) : activity.items.length === 0 ? (
						<p role="status" className="px-4 pb-4 pt-2 text-sm text-kumo-subtle sm:px-5">
							No activity has been recorded for this conversation.
						</p>
					) : (
						<>
							<ol aria-label="Conversation activity" className="border-t border-kumo-line">
								{activity.items.map((item) => (
									<li
										key={item.id}
										className="relative grid min-w-0 grid-cols-[0.5rem_minmax(0,1fr)] gap-2.5 border-b border-kumo-line px-4 py-3 last:border-b-0 sm:px-5"
									>
										<span
											className="mt-1.5 h-2 w-2 rounded-full bg-kumo-subtle"
											aria-hidden="true"
										/>
										<div className="min-w-0">
											<p className="break-words text-sm font-medium leading-5 text-kumo-default">
												{CONVERSATION_ACTIVITY_LABELS[item.code]}
											</p>
											<p className="mt-0.5 break-words text-xs leading-5 text-kumo-subtle">
												{item.actor.label} · {occurredAtLabel(item.occurredAt)}
											</p>
										</div>
									</li>
								))}
							</ol>

							{paginationError && (
								<div role="alert" className="border-t border-kumo-line px-4 py-3 text-sm sm:px-5">
									<p className="text-kumo-danger">Earlier activity could not be loaded.</p>
									<Button
										className="mt-2 min-h-11"
										variant="secondary"
										onClick={() => activity.fetchNextPage()}
										disabled={activity.isFetchingNextPage}
									>
										Retry earlier activity
									</Button>
								</div>
							)}

							{activity.hasNextPage && !paginationError && (
								<div className="border-t border-kumo-line px-4 py-2.5 sm:px-5">
									<Button
										className="min-h-11 w-full sm:w-auto"
										variant="ghost"
										onClick={() => activity.fetchNextPage()}
										loading={activity.isFetchingNextPage}
										disabled={activity.isFetchingNextPage}
									>
										Load earlier
									</Button>
								</div>
							)}
						</>
					)}
				</div>
			)}
		</section>
	);
}
