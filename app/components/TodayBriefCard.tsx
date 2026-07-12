import { Badge, Button, Loader } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import type {
	TodayBriefCounts,
	TodayBriefItem,
	TodayBriefResponse,
} from "~/services/today-brief";

export type TodayBriefCardProps = {
	brief: TodayBriefResponse | undefined;
	isLoading: boolean;
	error: Error | null;
	onRetry(): void;
	onOpenSource(messageId: string): void;
};

function countSummary(counts: TodayBriefCounts): string {
	const reminderLabel = counts.privateRemindersDue === 1
		? "private follow-up due"
		: "private follow-ups due";
	const unreadLabel = counts.unreadConversations === 1
		? "unread conversation in this mailbox"
		: "unread conversations in this mailbox";
	return `${counts.privateRemindersDue} ${reminderLabel} · ${counts.unreadConversations} ${unreadLabel}`;
}

function reasonLabel(reason: TodayBriefItem["candidate"]["reasons"][number]) {
	if (reason === "overdue_reminder") return "Overdue follow-up";
	if (reason === "today_reminder") return "Due today";
	return "Unread in mailbox";
}

function preparedLabel(value: string): string | null {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function SourceLinks({
	item,
	onOpenSource,
}: {
	item: TodayBriefItem;
	onOpenSource(messageId: string): void;
}) {
	const messageIds = item.messageIds.length > 0
		? item.messageIds
		: [item.candidate.sourceEmailId];
	return (
		<div className="flex flex-wrap items-center gap-1.5" aria-label="Source evidence">
			<span className="me-1 text-xs font-medium text-kumo-subtle">Evidence</span>
			{messageIds.map((messageId, index) => (
				<Button
					key={messageId}
					type="button"
					variant="ghost"
					size="sm"
					className="min-h-11"
					icon={<ArrowSquareOutIcon size={14} />}
					onClick={() => onOpenSource(messageId)}
					aria-label={`Open cited source message ${index + 1} for ${item.candidate.subject}`}
				>
					Source {index + 1}
				</Button>
			))}
		</div>
	);
}

function FocusItem({
	item,
	index,
	onOpenSource,
}: {
	item: TodayBriefItem;
	index: number;
	onOpenSource(messageId: string): void;
}) {
	return (
		<li className="grid gap-4 border-t border-kumo-line px-4 py-5 first:border-t-0 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:px-5">
			<span className="hidden pt-0.5 text-sm font-semibold tabular-nums text-kumo-subtle sm:block" aria-hidden="true">
				{String(index + 1).padStart(2, "0")}
			</span>
			<article className="min-w-0">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<h3 className="min-w-0 break-words font-semibold text-kumo-default">
						{item.candidate.subject || "Conversation"}
					</h3>
					<span className="text-sm text-kumo-subtle">
						{item.candidate.counterparty || "Unknown sender"}
					</span>
				</div>
				<p className="mt-1 text-xs font-medium text-kumo-subtle">
					{item.candidate.reasons.map(reasonLabel).join(" · ")}
				</p>

				<div className="mt-4 grid gap-4 md:grid-cols-2 md:gap-6">
					<div>
						<p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Why now</p>
						<p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-kumo-strong">
							{item.whyNow}
						</p>
					</div>
					<div>
						<p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Suggested next step</p>
						<p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-kumo-strong">
							{item.suggestedNextStep}
						</p>
					</div>
				</div>

				<div className="mt-3">
					<SourceLinks item={item} onOpenSource={onOpenSource} />
				</div>
			</article>
		</li>
	);
}

export default function TodayBriefCard({
	brief,
	isLoading,
	error,
	onRetry,
	onOpenSource,
}: TodayBriefCardProps) {
	const preparedAt = brief && (brief.state === "generated" || brief.state === "cached")
		? preparedLabel(brief.generatedAt)
		: null;
	const canRefresh = Boolean(
		brief &&
		!isLoading &&
		!error &&
		brief.state !== "preparing" &&
		brief.state !== "stale",
	);

	return (
		<section className="mb-8 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base" aria-labelledby="today-ai-brief-heading">
			<header className="flex flex-wrap items-start justify-between gap-3 bg-kumo-recessed px-4 py-4 sm:px-5">
				<div className="flex min-w-0 items-start gap-3">
					<SparkleIcon size={19} weight="fill" className="mt-0.5 shrink-0 text-kumo-brand" aria-hidden="true" />
					<div>
						<div className="flex flex-wrap items-center gap-2">
							<h2 id="today-ai-brief-heading" className="font-semibold text-kumo-default">AI focus brief</h2>
							<Badge variant="outline">AI guidance</Badge>
							<Badge variant="outline">Human review required</Badge>
						</div>
						<p className="mt-1 text-sm leading-5 text-kumo-subtle">
							A cited, read-only view of what may deserve attention. Your reminder sections below stay authoritative.
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					{brief?.state === "generated" && (
						<span className="text-xs font-medium text-kumo-subtle">Prepared{preparedAt ? ` ${preparedAt}` : ""}</span>
					)}
					{brief?.state === "cached" && (
						<span className="text-xs font-medium text-kumo-subtle">Cached{preparedAt ? ` · ${preparedAt}` : ""}</span>
					)}
					{canRefresh && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="min-h-11"
							icon={<ArrowClockwiseIcon size={15} />}
							onClick={onRetry}
						>
							Refresh
						</Button>
					)}
				</div>
			</header>

			{isLoading ? (
				<div role="status" className="flex min-h-36 items-center justify-center gap-3 px-4 py-8 text-sm text-kumo-subtle">
					<Loader size="sm" />
					Preparing a private brief from this mailbox…
				</div>
			) : error ? (
				<div role="alert" className="px-4 py-6 sm:px-5">
					<p className="text-sm font-medium text-kumo-default">The AI brief could not be prepared.</p>
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">Reminders below remain fully available.</p>
					<Button className="mt-3 min-h-11" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry}>
						Try again
					</Button>
				</div>
			) : brief?.state === "budget_paused" ? (
				<div role="status" className="px-4 py-6 sm:px-5">
					<p className="text-sm font-medium text-kumo-default">AI guidance is paused by the team’s budget controls.</p>
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">Reminders below remain fully available. {countSummary(brief.counts)}</p>
				</div>
			) : brief?.state === "preparing" ? (
				<div role="status" className="px-4 py-6 sm:px-5">
					<p className="text-sm font-medium text-kumo-default">Your private brief is already being prepared.</p>
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">Another open tab started the same brief. Today remains fully available, and this view will check again automatically.</p>
				</div>
			) : brief?.state === "stale" ? (
				<div role="status" className="px-4 py-6 sm:px-5">
					<p className="text-sm font-medium text-kumo-default">Mail changed while this brief was being prepared.</p>
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">The outdated guidance was not shown. Reminders below remain fully available.</p>
					<Button className="mt-3 min-h-11" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry}>
						Try again
					</Button>
				</div>
			) : brief?.state === "no_attention" ? (
				<div role="status" className="px-4 py-6 sm:px-5">
					<p className="text-sm font-medium text-kumo-default">No additional attention items right now.</p>
					<p className="mt-1 text-sm leading-5 text-kumo-subtle">{countSummary(brief.counts)}. Reminders below remain fully available.</p>
				</div>
			) : brief && (brief.state === "generated" || brief.state === "cached") ? (
				<div>
					<div className="border-b border-kumo-line px-4 py-3 text-sm text-kumo-subtle sm:px-5">
						{countSummary(brief.counts)}
						{brief.omittedCount > 0 ? ` · ${brief.omittedCount} lower-priority candidate${brief.omittedCount === 1 ? "" : "s"} omitted` : ""}
					</div>
					<ol aria-label="AI focus items">
						{brief.items.map((item, index) => (
							<FocusItem
								key={item.candidate.candidateId}
								item={item}
								index={index}
								onOpenSource={onOpenSource}
							/>
						))}
					</ol>
				</div>
			) : null}
		</section>
	);
}
