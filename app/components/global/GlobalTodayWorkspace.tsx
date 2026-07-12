import { Button, Loader } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	CloudSlashIcon,
	EnvelopeOpenIcon,
	LockSimpleIcon,
	SunHorizonIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router";
import { ReminderRow, type TodayReminderAction } from "~/components/TodayWorkspace";
import { globalTodayReminderOrder, type GlobalTodayReadyResponse, type GlobalTodayResponse } from "../../../shared/global-today.ts";

function dayLabel(localDate: string) {
	return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(new Date(`${localDate}T12:00:00`));
}

function timeLabel(value: string) {
	return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function LoadingState() {
	return (
		<div className="h-full overflow-y-auto bg-kumo-base" role="status" aria-label="Gathering your Mailboxes">
			<div className="mx-auto w-full max-w-6xl animate-pulse px-4 py-7 sm:px-7 sm:py-10 lg:px-10 lg:py-12">
				<div className="border-b border-kumo-line pb-7">
					<div className="h-4 w-44 rounded bg-kumo-fill" />
					<div className="mt-4 h-10 w-40 rounded bg-kumo-fill" />
					<div className="mt-4 h-5 max-w-xl rounded bg-kumo-fill" />
				</div>
				<div className="py-8 sm:py-10">
					<div className="h-6 w-36 rounded bg-kumo-fill" />
					<div className="mt-4 h-28 rounded-md border border-kumo-line bg-kumo-recessed" />
					<div className="mt-10 h-6 w-32 rounded bg-kumo-fill" />
					<div className="mt-4 space-y-3">
						<div className="h-36 rounded-md border border-kumo-line bg-kumo-recessed" />
						<div className="h-36 rounded-md border border-kumo-line bg-kumo-recessed" />
					</div>
				</div>
				<span className="sr-only"><Loader size="base" /> Gathering your Mailboxes…</span>
			</div>
		</div>
	);
}

function MailboxPulse({ snapshot }: { snapshot: GlobalTodayReadyResponse["mailboxes"][number] }) {
	return (
		<article className="border-t border-kumo-line py-5 first:border-t-0">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="flex flex-wrap items-center gap-2">
						<h3 className="font-semibold text-kumo-default">{snapshot.address}</h3>
						<span className="text-xs text-kumo-subtle">{snapshot.type === "PERSONAL" ? "Personal" : "Shared"}</span>
					</div>
					<p className="mt-1 text-sm text-kumo-subtle">
						{snapshot.unreadConversationCount === 0 ? "No unread Inbox conversations" : `${snapshot.unreadConversationCount} unread Inbox conversation${snapshot.unreadConversationCount === 1 ? "" : "s"}`}
						{snapshot.type === "SHARED" ? ". Read state is shared by the Mailbox." : "."}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Link to={`/mailbox/${encodeURIComponent(snapshot.mailboxId)}/emails/inbox`} className="inline-flex min-h-11 items-center rounded-md border border-kumo-line bg-kumo-base px-3 text-sm font-medium text-kumo-default no-underline hover:bg-kumo-tint">Open inbox</Link>
					<Link to={`/mailbox/${encodeURIComponent(snapshot.mailboxId)}/today`} className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-kumo-default no-underline hover:bg-kumo-tint">Mailbox Today</Link>
				</div>
			</div>
			{snapshot.unreadPreviews.length > 0 && (
				<ul className="mt-4 divide-y divide-kumo-line border-y border-kumo-line" aria-label={`Newest unread in ${snapshot.address}`}>
					{snapshot.unreadPreviews.map((preview) => (
						<li key={`${snapshot.mailboxId}:${preview.messageId}`}>
							<Link to={`/mailbox/${encodeURIComponent(snapshot.mailboxId)}/open/${encodeURIComponent(preview.messageId)}`} className="grid min-h-14 gap-1 px-1 py-3 no-underline hover:bg-kumo-tint sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
								<span className="min-w-0"><span className="block truncate text-sm font-medium text-kumo-default">{preview.subject}</span><span className="mt-0.5 block truncate text-xs text-kumo-subtle">{preview.sender}</span></span>
								<time className="text-xs text-kumo-subtle" dateTime={preview.date}>{timeLabel(preview.date)}</time>
							</Link>
						</li>
					))}
				</ul>
			)}
		</article>
	);
}

export default function GlobalTodayWorkspace({
	response,
	isLoading,
	isRefreshing,
	error,
	isOnline,
	pendingReminderKeys,
	feedback,
	onOpenConversation,
	onAction,
	onRetry,
}: {
	response?: GlobalTodayResponse;
	isLoading: boolean;
	isRefreshing: boolean;
	error: Error | null;
	isOnline: boolean;
	pendingReminderKeys: ReadonlySet<string>;
	feedback: { kind: "success" | "error"; message: string; offerRefresh?: boolean } | null;
	onOpenConversation(mailboxId: string, messageId: string): void;
	onAction(action: TodayReminderAction): void;
	onRetry(): void;
}) {
	if (isLoading && !response) return <LoadingState />;
	if (error && !response) return (
		<div className="grid h-full place-items-center overflow-y-auto px-4 py-12 text-center" role="alert"><div className="max-w-md"><WarningCircleIcon size={38} className="mx-auto text-kumo-danger" /><h1 className="mt-4 text-xl font-semibold text-kumo-default">Today could not be loaded</h1><p className="mt-2 text-sm leading-6 text-kumo-subtle">No Mailbox was changed. Check your connection and try again.</p><Button variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry} disabled={!isOnline} className="mt-5 min-h-11">Try again</Button></div></div>
	);
	if (!response) return null;
	if (response.state === "capacity_exceeded") return (
		<div className="grid h-full place-items-center overflow-y-auto px-4 py-12 text-center" role="alert"><div className="max-w-lg"><WarningCircleIcon size={38} className="mx-auto text-kumo-danger" /><h1 className="mt-4 text-xl font-semibold text-kumo-default">Today needs a larger safe window</h1><p className="mt-2 text-sm leading-6 text-kumo-subtle">This account has {response.actual} {response.resource}. The current verified limit is {response.limit}, so nothing was silently omitted.</p><Button variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry} disabled={!isOnline} className="mt-5 min-h-11">Retry</Button></div></div>
	);

	const reminders = response.mailboxes.flatMap((mailbox) => mailbox.reminders).sort(globalTodayReminderOrder);
	const now = Date.now();
	const dayEnd = Date.parse(response.day.endAt);
	const attention = reminders.filter((reminder) => Date.parse(reminder.remindAt) < dayEnd);
	const upcoming = reminders.filter((reminder) => Date.parse(reminder.remindAt) >= dayEnd);
	const mailboxById = new Map(response.mailboxes.map((mailbox) => [mailbox.mailboxId, mailbox]));
	const allFailed = response.mailboxes.length === 0 && response.failures.length > 0;
	const hasNoMailboxes = response.currentMailboxCount === 0;
	const personalOnly = response.currentMailboxCount === 1 && response.mailboxes[0]?.type === "PERSONAL";
	const isClear = response.complete && response.totals?.privateRemindersDue === 0 && response.totals.unreadConversations === 0;
	const summary = isClear
		? "Nothing needs attention right now."
		: response.complete && response.totals
			? personalOnly
				? `${response.totals.privateRemindersDue} private follow-up${response.totals.privateRemindersDue === 1 ? "" : "s"} due and ${response.totals.unreadConversations} unread conversation${response.totals.unreadConversations === 1 ? "" : "s"} in ${response.mailboxes[0]!.address}.`
				: `${response.totals.privateRemindersDue} private follow-up${response.totals.privateRemindersDue === 1 ? "" : "s"} due and ${response.totals.unreadConversations} unread conversation${response.totals.unreadConversations === 1 ? "" : "s"} across ${response.currentMailboxCount} Mailboxes.`
			: `${response.mailboxes.length} of ${response.currentMailboxCount} Mailboxes are current. Partial totals are hidden.`;

	return (
		<div className="h-full overflow-y-auto bg-kumo-base">
			<div className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-7 sm:py-10 lg:px-10 lg:py-12">
				<header className="grid gap-6 border-b border-kumo-line pb-7 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
					<div>
						<p className="flex items-center gap-2 text-sm font-medium text-kumo-subtle"><SunHorizonIcon size={18} aria-hidden="true" /> {dayLabel(response.day.localDate)}</p>
						<h1 className="mt-3 text-3xl font-semibold tracking-tight text-kumo-default sm:text-4xl">Today</h1>
						<p className="mt-3 max-w-2xl text-base leading-7 text-kumo-strong">
							{summary}
						</p>
					</div>
					<div className="flex items-center gap-3">
						{isRefreshing && <span className="text-xs text-kumo-subtle" role="status">Refreshing…</span>}
						<Button variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry} loading={isRefreshing} disabled={!isOnline || isRefreshing} className="min-h-11">Refresh</Button>
					</div>
				</header>

				<div className="space-y-3 pt-6">
					{!isOnline && <div className="flex items-start gap-3 rounded-md bg-kumo-warning-tint px-4 py-3 text-sm text-kumo-default" role="status"><CloudSlashIcon size={18} className="mt-0.5 shrink-0" /><p>You are offline. This mounted view may be outdated; it will reauthorize when you reconnect.</p></div>}
					{error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-kumo-warning-tint px-4 py-3 text-sm text-kumo-default" role="alert"><p>Today could not refresh. The visible snapshot may be outdated.</p><Button variant="secondary" onClick={onRetry} disabled={!isOnline || isRefreshing} className="min-h-11">Try again</Button></div>}
					{response.accessChanged && <div className="flex items-start gap-3 rounded-md bg-kumo-warning-tint px-4 py-3 text-sm text-kumo-default" role="status"><LockSimpleIcon size={18} className="mt-0.5 shrink-0" /><p>Mailbox access changed while Today was loading. Removed content was discarded and the overview is refreshing safely.</p></div>}
					{pendingReminderKeys.size > 0 && <p className="sr-only" role="status">Updating one private follow-up reminder.</p>}
					{feedback && <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-3 text-sm ${feedback.kind === "error" ? "bg-kumo-danger-tint text-kumo-danger" : "bg-kumo-success-tint text-kumo-default"}`} role={feedback.kind === "error" ? "alert" : "status"}><p>{feedback.message}</p>{feedback.offerRefresh && <Button variant="secondary" onClick={onRetry} disabled={!isOnline || isRefreshing} className="min-h-11">Refresh</Button>}</div>}
				</div>

				{hasNoMailboxes ? <section className="grid min-h-72 place-items-center py-10 text-center"><div className="max-w-md"><LockSimpleIcon size={38} weight="thin" className="mx-auto text-kumo-subtle" /><h2 className="mt-4 text-lg font-semibold text-kumo-default">No Mailboxes are available yet</h2><p className="mt-2 text-sm leading-6 text-kumo-subtle">Today will gather your work here after you receive access to a Mailbox.</p><Link to="/mailboxes" className="mt-5 inline-flex min-h-11 items-center rounded-md border border-kumo-line bg-kumo-base px-4 text-sm font-medium text-kumo-default no-underline hover:bg-kumo-tint">Open Mailboxes</Link></div></section> : allFailed ? <section className="grid min-h-72 place-items-center py-10 text-center" role="alert"><div className="max-w-md"><WarningCircleIcon size={38} className="mx-auto text-kumo-danger" /><h2 className="mt-4 text-lg font-semibold text-kumo-default">No Mailbox snapshot is current</h2><p className="mt-2 text-sm leading-6 text-kumo-subtle">Your Mailboxes are still available individually. Retry this overview when the connection recovers.</p><Button variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry} disabled={!isOnline} className="mt-5 min-h-11">Retry overview</Button></div></section> : (
					<div className="py-8 sm:py-10">
						<section aria-labelledby="attention-now-title">
							<div className="flex items-end justify-between gap-4 pb-3"><div><h2 id="attention-now-title" className="text-lg font-semibold text-kumo-default">Attention now</h2><p className="mt-1 text-sm text-kumo-subtle">Your private reminders that are overdue or due today.</p></div><span className="text-sm tabular-nums text-kumo-subtle">{attention.length}</span></div>
							{attention.length === 0 ? <div className="flex min-h-36 items-center gap-4 border-y border-kumo-line py-6"><EnvelopeOpenIcon size={34} weight="thin" className="shrink-0 text-kumo-subtle" /><div><p className="font-medium text-kumo-default">{isClear ? "Nothing needs attention right now" : "Nothing needs personal follow-up right now"}</p><p className="mt-1 text-sm text-kumo-subtle">{isClear ? "Every accessible Mailbox is shown below with a zero count." : "Unread Mailbox conversations still appear below."}</p></div></div> : <ul className="border-y border-kumo-line" aria-label="Private reminders needing attention">{attention.map((reminder) => { const mailbox = mailboxById.get(reminder.mailboxAddress)!; const key = `${reminder.mailboxAddress}:${reminder.id}`; return <ReminderRow key={key} reminder={reminder} group={Date.parse(reminder.remindAt) < now ? "overdue" : "today"} mailboxContext={{ address: mailbox.address, type: mailbox.type }} mutationsDisabled={pendingReminderKeys.has(key)} isPendingOrigin={pendingReminderKeys.has(key)} onOpenConversation={() => onOpenConversation(reminder.mailboxAddress, reminder.baselineMessageId)} onAction={onAction} />; })}</ul>}
						</section>

						<section className="pt-10" aria-labelledby="mailbox-pulse-title">
							<div className="flex items-end justify-between gap-4 pb-3"><div><h2 id="mailbox-pulse-title" className="text-lg font-semibold text-kumo-default">Mailbox pulse</h2><p className="mt-1 text-sm text-kumo-subtle">Mailbox-wide unread state, without changing it.</p></div><span className="text-sm tabular-nums text-kumo-subtle">{response.mailboxes.length}</span></div>
							<div className="border-y border-kumo-line">{response.mailboxes.map((snapshot) => <MailboxPulse key={snapshot.mailboxId} snapshot={snapshot} />)}</div>
						</section>

						{response.failures.length > 0 && <section className="pt-8" aria-labelledby="unavailable-mailboxes-title"><h2 id="unavailable-mailboxes-title" className="text-base font-semibold text-kumo-default">Not current</h2><ul className="mt-3 divide-y divide-kumo-line border-y border-kumo-line">{response.failures.map((failure) => <li key={failure.mailboxId} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="text-sm font-medium text-kumo-default">{failure.address}</p><p className="mt-1 text-xs text-kumo-subtle">{failure.reason === "timeout" ? "The Mailbox took too long to answer." : "The Mailbox snapshot is temporarily unavailable."} No content was returned.</p></div><Button variant="secondary" onClick={onRetry} disabled={!isOnline || isRefreshing} aria-label={`Refresh overview to retry ${failure.address}`} className="min-h-11">Refresh overview</Button></li>)}</ul></section>}

						{upcoming.length > 0 && <details className="mt-10 border-y border-kumo-line py-4"><summary className="cursor-pointer text-base font-semibold text-kumo-default">Coming up <span className="ml-2 text-sm font-normal text-kumo-subtle">{upcoming.length}</span></summary><ul className="mt-3 border-t border-kumo-line">{upcoming.map((reminder) => { const mailbox = mailboxById.get(reminder.mailboxAddress)!; const key = `${reminder.mailboxAddress}:${reminder.id}`; return <ReminderRow key={key} reminder={reminder} group="upcoming" mailboxContext={{ address: mailbox.address, type: mailbox.type }} mutationsDisabled={pendingReminderKeys.has(key)} isPendingOrigin={pendingReminderKeys.has(key)} onOpenConversation={() => onOpenConversation(reminder.mailboxAddress, reminder.baselineMessageId)} onAction={onAction} />; })}</ul></details>}
					</div>
				)}
			</div>
		</div>
	);
}
