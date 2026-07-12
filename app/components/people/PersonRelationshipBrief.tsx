import {
	ArrowsClockwiseIcon,
	CaretDownIcon,
	CaretUpIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type {
	RelationshipBriefCitation,
	RelationshipBriefClaim,
} from "~/services/relationship-brief";
import { useRelationshipBrief } from "~/queries/relationship-brief";

const REVIEW_GUIDANCE =
	"Review this AI-generated brief and its cited messages before acting.";

function messageUrl(
	mailboxId: string,
	folderId: string,
	messageId: string,
): string {
	return `/mailbox/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(folderId)}?email=${encodeURIComponent(messageId)}`;
}

function preparedLabel(value: string): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(new Date(value));
}

function CitationLinks({
	mailboxId,
	citations,
}: {
	mailboxId: string;
	citations: RelationshipBriefCitation[];
}) {
	return (
		<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1" aria-label="Cited messages">
			{citations.map((citation, index) => (
				<Link
					key={citation.messageId}
					to={messageUrl(mailboxId, citation.folderId, citation.messageId)}
					className="inline-flex min-h-11 items-center text-xs font-semibold text-kumo-link underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
					aria-label={`Open cited message ${index + 1}: ${citation.subject || "No subject"}`}
				>
					Source {index + 1} · {citation.subject || "(No subject)"} · {preparedLabel(citation.sentAt)}
				</Link>
			))}
		</div>
	);
}

function ClaimRows({
	mailboxId,
	claims,
	empty,
	meta,
}: {
	mailboxId: string;
	claims: RelationshipBriefClaim[];
	empty: string;
	meta?: (index: number) => ReactNode;
}) {
	if (claims.length === 0) {
		return <p className="mt-2 text-sm leading-6 text-kumo-subtle">{empty}</p>;
	}
	return (
		<ul className="mt-2 divide-y divide-kumo-line">
			{claims.map((claim, index) => (
				<li key={`${index}:${claim.text}`} className="py-3 first:pt-1 last:pb-0">
					{meta ? <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{meta(index)}</p> : null}
					<p className="whitespace-pre-wrap text-sm leading-6 text-kumo-strong">{claim.text}</p>
					<CitationLinks mailboxId={mailboxId} citations={claim.citations} />
				</li>
			))}
		</ul>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="border-t border-kumo-line px-4 py-5 first:border-t-0 sm:px-5">
			<h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">{title}</h4>
			{children}
		</section>
	);
}

export default function PersonRelationshipBrief({
	mailboxId,
	personId,
	onAccessRevoked,
}: {
	mailboxId: string;
	personId: string;
	onAccessRevoked: (mailboxId: string, active: boolean) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const intelligence = useRelationshipBrief(mailboxId, personId, onAccessRevoked);
	const response = intelligence.data;
	const ready = response?.state === "generated" || response?.state === "cached"
		? response
		: null;

	const request = (refresh: boolean) => {
		void intelligence.request(refresh).catch(() => {
			// The inline error state is authoritative; a 403 has already started
			// the synchronous revoked-Mailbox surface exit in the query seam.
		});
	};

	return (
		<section className="border-b border-kumo-line bg-kumo-base" aria-labelledby="relationship-brief-heading">
			<div className="flex min-h-14 items-center gap-2 bg-kumo-recessed px-4 sm:px-5">
				<button
					type="button"
					className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-start focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					aria-controls="relationship-brief-content"
				>
					<SparkleIcon size={18} weight="fill" className="shrink-0 text-kumo-brand" aria-hidden="true" />
					<span id="relationship-brief-heading" className="min-w-0 flex-1">
						<span className="block text-sm font-semibold text-kumo-default">Relationship brief</span>
						<span className="block text-xs font-normal text-kumo-subtle">Manual, cited AI guidance</span>
					</span>
					{ready ? <span className="shrink-0 text-xs font-medium text-kumo-subtle">{ready.state === "cached" ? "Cached" : "Prepared"}</span> : null}
					{expanded ? <CaretUpIcon size={16} aria-hidden="true" /> : <CaretDownIcon size={16} aria-hidden="true" />}
				</button>
				{expanded && ready ? (
					<button
						type="button"
						onClick={() => request(true)}
						disabled={intelligence.isLoading}
						className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50"
					>
						<ArrowsClockwiseIcon size={16} className={intelligence.isLoading ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />
						Refresh
					</button>
				) : null}
			</div>

			{expanded ? (
				<div id="relationship-brief-content">
					{intelligence.isLoading && !ready ? (
						<div className="px-4 py-7 sm:px-5" role="status" aria-live="polite">
							<p className="text-sm font-medium text-kumo-default">Preparing a private brief…</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">This reads eligible mail only. It cannot change, draft, or send anything.</p>
						</div>
					) : intelligence.error && !ready ? (
						<div className="px-4 py-6 sm:px-5" role="alert">
							<p className="text-sm font-medium text-kumo-default">The relationship brief could not be prepared.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">Relationship history below remains available and unchanged.</p>
							<button type="button" onClick={() => request(false)} className="mt-3 min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
						</div>
					) : !response ? (
						<div className="px-4 py-6 sm:px-5">
							<p className="text-sm font-medium text-kumo-default">A brief is available only when you ask for it.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">AI will review bounded eligible mail and return cited guidance. Nothing will be drafted or sent.</p>
							<button type="button" onClick={() => request(false)} className="mt-3 min-h-11 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Generate relationship brief</button>
						</div>
					) : response.state === "unavailable" ? (
						<div className="px-4 py-6 sm:px-5" role="status">
							<p className="text-sm font-medium text-kumo-default">No relationship brief is available yet.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">Eligible cited mail may have changed or may not yet support useful guidance. The relationship history below remains authoritative.</p>
							<button type="button" onClick={() => request(false)} className="mt-3 min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
						</div>
					) : response.state === "preparing" ? (
						<div className="px-4 py-6 sm:px-5" role="status">
							<p className="text-sm font-medium text-kumo-default">This private brief is already being prepared.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">No background polling is running. Check again when you are ready.</p>
							<button type="button" onClick={() => request(false)} className="mt-3 min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Check again</button>
						</div>
					) : response.state === "stale" ? (
						<div className="px-4 py-6 sm:px-5" role="status">
							<p className="text-sm font-medium text-kumo-default">Mail changed while the brief was being prepared.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">Outdated guidance was discarded. Generate again to review current evidence.</p>
							<button type="button" onClick={() => request(false)} className="mt-3 min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Generate current brief</button>
						</div>
					) : response.state === "budget_paused" ? (
						<div className="px-4 py-6 sm:px-5" role="status">
							<p className="text-sm font-medium text-kumo-default">AI guidance is paused by the team’s AI budget controls.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">The deterministic relationship history below remains fully available.</p>
						</div>
					) : ready ? (
						<div>
							{intelligence.isLoading ? (
								<p className="border-b border-kumo-line px-4 py-3 text-sm text-kumo-subtle sm:px-5" role="status" aria-live="polite">Refreshing from current cited mail… The existing brief remains visible.</p>
							) : intelligence.error ? (
								<p className="border-b border-kumo-line bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger sm:px-5" role="alert">Refresh could not be completed. The existing brief is unchanged.</p>
							) : null}
							<div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs text-kumo-subtle sm:px-5">
								<span>{ready.state === "cached" ? "Cached private brief" : "Private brief prepared"} · {preparedLabel(ready.generatedAt)}</span>
								<span className="font-semibold text-kumo-strong">Human review required</span>
							</div>
							<Section title="Recent topics">
								<ClaimRows mailboxId={mailboxId} claims={ready.brief.topics} empty="No recent topic was identified in the cited mail." />
							</Section>
							<Section title="Open questions">
								<ClaimRows mailboxId={mailboxId} claims={ready.brief.openQuestions} empty="No open question was identified in the cited mail." meta={(index) => ready.brief.openQuestions[index]?.askedBy === "us" ? "Asked by us" : "Asked by them"} />
							</Section>
							<Section title="Explicit commitments">
								<ClaimRows mailboxId={mailboxId} claims={ready.brief.commitments} empty="No explicit commitment was identified in the cited mail." meta={(index) => {
									const commitment = ready.brief.commitments[index];
									if (!commitment) return null;
									return `${commitment.madeBy === "us" ? "Made by us" : "Made by them"}${commitment.dueAt ? ` · Due ${preparedLabel(commitment.dueAt)}` : ""}`;
								}} />
							</Section>
							<Section title="Important conversations">
								{ready.brief.importantConversations.length === 0 ? <p className="mt-2 text-sm leading-6 text-kumo-subtle">No conversation was singled out from the cited mail.</p> : (
									<ul className="mt-2 divide-y divide-kumo-line">
										{ready.brief.importantConversations.map((conversation) => (
											<li key={conversation.conversationId} className="py-3 first:pt-1 last:pb-0">
												<p className="whitespace-pre-wrap text-sm leading-6 text-kumo-strong">{conversation.reason}</p>
												<CitationLinks mailboxId={mailboxId} citations={conversation.citations} />
											</li>
										))}
									</ul>
								)}
							</Section>
							<Section title="Suggested next step">
								<p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-kumo-strong">{ready.brief.suggestedNextStep.text}</p>
								<CitationLinks mailboxId={mailboxId} citations={ready.brief.suggestedNextStep.citations} />
								{ready.brief.requiresHumanReview && ready.brief.suggestedNextStep.requiresHumanReview ? (
									<p className="mt-4 border-t border-kumo-line pt-3 text-sm font-medium leading-6 text-kumo-default">{REVIEW_GUIDANCE}</p>
								) : null}
							</Section>
						</div>
					) : null}
				</div>
			) : null}
		</section>
	);
}
