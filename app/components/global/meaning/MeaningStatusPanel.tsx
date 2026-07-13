import { Button } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	CloudSlashIcon,
	HourglassMediumIcon,
	LockSimpleIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import type { SemanticSearchResponse } from "../../../../shared/semantic-search.ts";

function mailboxStateLabel(state: SemanticSearchResponse["mailboxes"][number]["state"]): string {
	if (state === "complete") return "Ready";
	if (state === "building") return "Preparing";
	return "Unavailable";
}

export default function MeaningStatusPanel({
	response,
	error,
	isOnline,
	isLoading,
	onRetry,
}: {
	response: SemanticSearchResponse | null;
	error: string | null;
	isOnline: boolean;
	isLoading: boolean;
	onRetry(): void;
}) {
	const statusClass = "flex items-start gap-3 rounded-md px-4 py-3 text-sm leading-6";
	return (
		<div className="space-y-3 pt-5" aria-live="polite">
			{!isOnline && (
				<div className={`${statusClass} bg-kumo-warning-tint text-kumo-default`} role="status">
					<CloudSlashIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
					<p>You are offline. Meaning search will not retry or spend AI budget until you ask again.</p>
				</div>
			)}
			{error && (
				<div className={`${statusClass} flex-wrap justify-between bg-kumo-danger-tint text-kumo-danger`} role="alert">
					<div className="flex min-w-0 flex-1 items-start gap-3">
						<WarningCircleIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
						<p>{error} No previous evidence is being shown.</p>
					</div>
					<Button variant="secondary" onClick={onRetry} disabled={!isOnline || isLoading} className="min-h-11">Try again</Button>
				</div>
			)}
			{response?.accessChanged && (
				<div className={`${statusClass} bg-kumo-warning-tint text-kumo-default`} role="status">
					<LockSimpleIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
					<p>Mailbox access changed while this search ran. Removed content was discarded before these results were returned.</p>
				</div>
			)}
			{response?.state === "partial" && (
				<div className={`${statusClass} bg-kumo-warning-tint text-kumo-default`} role="status">
					<HourglassMediumIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
					<p>{response.results.length > 0 ? "Results may be incomplete while some Mailboxes are still preparing." : "No evidence is shown yet. This is not a no-results conclusion."}</p>
				</div>
			)}
			{response?.state === "building" && (
				<div className={`${statusClass} flex-wrap justify-between bg-kumo-fill text-kumo-default`} role="status">
					<div className="flex min-w-0 flex-1 items-start gap-3">
						<HourglassMediumIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
						<p>Your accessible Mailboxes are preparing their private meaning index. No evidence is ready yet.</p>
					</div>
					<Button variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={onRetry} disabled={!isOnline || isLoading} className="min-h-11">Check again</Button>
				</div>
			)}
			{response?.state === "unavailable" && (
				<div className={`${statusClass} flex-wrap justify-between bg-kumo-danger-tint text-kumo-danger`} role="alert">
					<div className="flex min-w-0 flex-1 items-start gap-3">
						<WarningCircleIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
						<p>Meaning search is unavailable right now. Your ordinary Mailboxes and search remain available.</p>
					</div>
					<Button variant="secondary" onClick={onRetry} disabled={!isOnline || isLoading} className="min-h-11">Try again</Button>
				</div>
			)}
			{response && response.mailboxes.length > 0 && (
				<details className="border-y border-kumo-line py-3 text-sm">
					<summary className="min-h-11 cursor-pointer py-3 font-medium text-kumo-default">Mailbox readiness</summary>
					<ul className="border-t border-kumo-line pt-2">
						{response.mailboxes.map((mailbox) => (
							<li key={mailbox.mailboxId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-kumo-subtle">
								<span className="break-all">{mailbox.mailboxAddress}</span>
								<span>{mailboxStateLabel(mailbox.state)}</span>
							</li>
						))}
					</ul>
				</details>
			)}
		</div>
	);
}
