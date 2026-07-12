import {
	ArrowLeftIcon,
	ArrowSquareOutIcon,
	CopyIcon,
	EnvelopeSimpleIcon,
	PaperclipIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type {
	MailPersonConversationSummary,
	MailPersonDetail,
	MailPersonTimelineItem,
} from "../../../shared/mail-people.ts";
import { formatBytes, formatDetailDate } from "~/lib/utils";
import { useUIStore } from "~/hooks/useUIStore";
import { ApiError } from "~/services/api";
import {
	useMailPerson,
	useMailPersonTimeline,
} from "~/queries/people";
import PersonRelationshipBrief from "./PersonRelationshipBrief.tsx";

function messageUrl(
	mailboxId: string,
	folderId: string,
	messageId: string,
): string {
	return `/mailbox/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(folderId)}?email=${encodeURIComponent(messageId)}`;
}

function directionLabel(direction: "sent" | "received"): string {
	return direction === "received" ? "Received" : "Sent";
}

function roleLabel(role: MailPersonTimelineItem["role"]): string {
	return role === "cc" ? "Cc" : role === "bcc" ? "Bcc" : role === "to" ? "To" : "From";
}

function MetricGrid({ person }: { person: MailPersonDetail }) {
	return (
		<dl className="grid grid-cols-2 border-y border-kumo-line text-sm sm:grid-cols-3">
			<div className="border-b border-e border-kumo-line px-4 py-3 sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Last contact</dt>
				<dd className="mt-1 font-medium text-kumo-default">{formatDetailDate(person.lastInteractionAt)}</dd>
			</div>
			<div className="border-b border-kumo-line px-4 py-3 sm:border-e sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">First contact</dt>
				<dd className="mt-1 font-medium text-kumo-default">{formatDetailDate(person.firstInteractionAt)}</dd>
			</div>
			<div className="border-b border-e border-kumo-line px-4 py-3 sm:border-e-0 sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Conversations</dt>
				<dd className="mt-1 font-medium tabular-nums text-kumo-default">{person.conversationCount}</dd>
			</div>
			<div className="border-b border-kumo-line px-4 py-3 sm:border-b-0 sm:border-e sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Received</dt>
				<dd className="mt-1 font-medium tabular-nums text-kumo-default">{person.receivedCount}</dd>
			</div>
			<div className="border-e border-kumo-line px-4 py-3 sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Sent</dt>
				<dd className="mt-1 font-medium tabular-nums text-kumo-default">{person.sentCount}</dd>
			</div>
			<div className="px-4 py-3 sm:px-5">
				<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Files</dt>
				<dd className="mt-1 font-medium tabular-nums text-kumo-default">{person.attachmentCount}</dd>
			</div>
		</dl>
	);
}

function ConversationRow({
	mailboxId,
	conversation,
}: {
	mailboxId: string;
	conversation: MailPersonConversationSummary;
}) {
	const contents = (
		<>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-semibold text-kumo-default">
					{conversation.subject || "(No subject)"}
				</span>
				<span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-kumo-subtle">
					<span>{directionLabel(conversation.latestDirection)}</span>
					<span aria-hidden="true">·</span>
					<span>{conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}</span>
					{conversation.unreadCount > 0 ? <span>{conversation.unreadCount} unread</span> : null}
					{conversation.attachmentCount > 0 ? <span>{conversation.attachmentCount} {conversation.attachmentCount === 1 ? "file" : "files"}</span> : null}
				</span>
			</span>
			<span className="shrink-0 text-xs text-kumo-subtle">{formatDetailDate(conversation.latestAt)}</span>
			<ArrowSquareOutIcon size={17} className="shrink-0" aria-hidden="true" />
		</>
	);
	return (
		<Link
			to={messageUrl(
				mailboxId,
				conversation.representativeFolderId,
				conversation.representativeMessageId,
			)}
			aria-label={`Open ${conversation.subject || "conversation"}`}
			className="flex min-h-16 items-start gap-3 px-4 py-3 hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring sm:px-5"
		>
			{contents}
		</Link>
	);
}

export default function PersonDetail({
	mailboxId,
	personId,
	showBack,
	focusHeading,
	onBack,
	onAccessRevoked,
}: {
	mailboxId: string;
	personId: string;
	showBack: boolean;
	focusHeading: boolean;
	onBack: () => void;
	onAccessRevoked: (mailboxId?: string, active?: boolean) => void;
}) {
	const detail = useMailPerson(mailboxId, personId);
	const person = detail.data?.status === "ready" ? detail.data.person : null;
	const timeline = useMailPersonTimeline(mailboxId, personId, Boolean(person));
	const headingRef = useRef<HTMLHeadingElement>(null);
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
	const startCompose = useUIStore((state) => state.startCompose);
	const accessRevoked = (detail.error instanceof ApiError && detail.error.status === 403) ||
		(timeline.error instanceof ApiError && timeline.error.status === 403);

	useEffect(() => {
		if (focusHeading && person) headingRef.current?.focus();
	}, [focusHeading, person]);

	useEffect(() => setCopyFeedback(null), [personId]);

	useEffect(() => {
		if (accessRevoked) onAccessRevoked();
	}, [accessRevoked, onAccessRevoked]);

	const recentFiles = useMemo(() => {
		const files: Array<{
			key: string;
			attachment: MailPersonTimelineItem["attachments"][number];
			message: MailPersonTimelineItem;
		}> = [];
		const seen = new Set<string>();
		for (const message of timeline.items) {
			for (const attachment of message.attachments) {
				const key = `${message.messageId}:${attachment.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				files.push({ key, attachment, message });
				if (files.length === 8) return files;
			}
		}
		return files;
	}, [timeline.items]);
	const openRelatedMessage = timeline.items[0] ?? null;

	if (detail.isPending) {
		return <div className="grid h-full place-items-center text-sm text-kumo-subtle" role="status" aria-live="polite">Loading relationship history…</div>;
	}
	if (accessRevoked) {
		return <div className="grid h-full place-items-center p-6 text-center text-sm text-kumo-subtle" role="status" aria-live="polite">Mailbox access changed. Returning to your mailboxes…</div>;
	}
	if (detail.data?.status === "building") {
		return (
			<div className="grid h-full place-items-center p-6 text-center" role="status" aria-live="polite">
				<div className="max-w-sm">
					<h2 className="font-semibold text-kumo-default">Building relationship history</h2>
					<p className="mt-2 text-sm leading-6 text-kumo-subtle">{detail.data.processedMessages.toLocaleString()} messages checked. This view refreshes when the next batch is ready.</p>
				</div>
			</div>
		);
	}
	if (detail.isError) {
		return (
			<div className="grid h-full place-items-center p-6" role="alert">
				<div className="max-w-sm text-center">
					<h2 className="font-semibold text-kumo-default">Relationship history could not load</h2>
					<p className="mt-2 text-sm leading-6 text-kumo-subtle">Access may have changed, or the request could not be completed.</p>
					<div className="mt-4 flex flex-wrap justify-center gap-2">
						{showBack ? <button type="button" onClick={onBack} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Back to people</button> : null}
						<button type="button" onClick={() => void detail.refetch()} className="min-h-11 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
					</div>
				</div>
			</div>
		);
	}
	if (!person) {
		return (
			<div className="grid h-full place-items-center p-6" role="alert">
				<div className="max-w-sm text-center">
					<h2 className="font-semibold text-kumo-default">Person no longer available</h2>
					<p className="mt-2 text-sm leading-6 text-kumo-subtle">Their eligible mail may have moved, been removed, or access may have changed.</p>
					<button type="button" onClick={onBack} className="mt-4 min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Back to people</button>
				</div>
			</div>
		);
	}

	const copyAddress = async () => {
		try {
			await navigator.clipboard.writeText(person.address);
			setCopyFeedback("Address copied.");
		} catch {
			setCopyFeedback("Address could not be copied. Select it from the heading instead.");
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col bg-kumo-base">
			<header className="shrink-0 border-b border-kumo-line px-4 py-3 sm:px-5">
				{showBack ? (
					<button type="button" onClick={onBack} className="mb-2 inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
						<ArrowLeftIcon size={18} aria-hidden="true" />
						Back to people
					</button>
				) : null}
				<div className="flex min-w-0 flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
					<div className="min-w-0">
						<h2 ref={headingRef} tabIndex={-1} className="break-words text-xl font-semibold tracking-tight text-kumo-default focus:outline-none">
							{person.displayName ?? person.address}
						</h2>
						<p className="mt-1 break-all text-sm text-kumo-strong">{person.address}</p>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							{person.domain}
							{person.nameProvenance === "imported" ? " · Name observed in imported mail" : ""}
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<button type="button" onClick={() => startCompose({ mode: "new", initialTo: person.address })} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-kumo-brand px-3 text-sm font-medium text-kumo-inverse hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
							<EnvelopeSimpleIcon size={17} aria-hidden="true" />
							Compose
						</button>
						<button type="button" onClick={() => void copyAddress()} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
							<CopyIcon size={17} aria-hidden="true" />
							Copy address
						</button>
						{openRelatedMessage ? (
							<Link to={messageUrl(mailboxId, openRelatedMessage.folder.id, openRelatedMessage.messageId)} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
								<ArrowSquareOutIcon size={17} aria-hidden="true" />
								Open related mail
							</Link>
						) : (
							<button type="button" disabled className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-subtle opacity-60">
								<ArrowSquareOutIcon size={17} aria-hidden="true" />
								Open related mail
							</button>
						)}
					</div>
				</div>
				{copyFeedback ? <p className="mt-2 text-sm text-kumo-subtle" role={copyFeedback.startsWith("Address copied") ? "status" : "alert"}>{copyFeedback}</p> : null}
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto">
				<MetricGrid person={person} />
				<dl className="grid grid-cols-2 border-b border-kumo-line text-sm">
					<div className="border-e border-kumo-line px-4 py-3 sm:px-5">
						<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Last received</dt>
						<dd className="mt-1 font-medium text-kumo-default">{person.lastInboundAt ? formatDetailDate(person.lastInboundAt) : "None"}</dd>
					</div>
					<div className="px-4 py-3 sm:px-5">
						<dt className="text-xs uppercase tracking-wide text-kumo-subtle">Last sent</dt>
						<dd className="mt-1 font-medium text-kumo-default">{person.lastOutboundAt ? formatDetailDate(person.lastOutboundAt) : "None"}</dd>
					</div>
				</dl>
				{person.importedMessageCount > 0 ? (
					<p className="border-b border-kumo-line px-4 py-2 text-xs text-kumo-subtle sm:px-5">
						Imported history contributes {person.importedMessageCount} {person.importedMessageCount === 1 ? "message" : "messages"} to this relationship.
					</p>
				) : null}

				<PersonRelationshipBrief
					key={personId}
					mailboxId={mailboxId}
					personId={personId}
					onAccessRevoked={onAccessRevoked}
				/>

				<section aria-labelledby="relationship-conversations-heading" className="border-b border-kumo-line py-5">
					<h3 id="relationship-conversations-heading" className="px-4 text-sm font-semibold text-kumo-default sm:px-5">Recent conversations</h3>
					{person.conversations.length > 0 ? (
						<div className="mt-2 divide-y divide-kumo-line">
							{person.conversations.map((conversation) => (
								<ConversationRow key={conversation.conversationId} mailboxId={mailboxId} conversation={conversation} />
							))}
						</div>
					) : <p className="px-4 pt-3 text-sm text-kumo-subtle sm:px-5">No eligible conversations remain.</p>}
				</section>

				{recentFiles.length > 0 ? (
					<section aria-labelledby="relationship-files-heading" className="border-b border-kumo-line py-5">
						<h3 id="relationship-files-heading" className="px-4 text-sm font-semibold text-kumo-default sm:px-5">Recent files</h3>
						<div className="mt-2 divide-y divide-kumo-line">
							{recentFiles.map(({ key, attachment, message }) => (
								<Link key={key} to={messageUrl(mailboxId, message.folder.id, message.messageId)} className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring sm:px-5">
									<PaperclipIcon size={17} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{attachment.filename}</span>
									<span className="shrink-0 text-xs text-kumo-subtle">{formatBytes(attachment.size)}</span>
								</Link>
							))}
						</div>
					</section>
				) : null}

				<section aria-labelledby="relationship-timeline-heading" className="py-5">
					<div className="flex items-baseline justify-between gap-3 px-4 sm:px-5">
						<h3 id="relationship-timeline-heading" className="text-sm font-semibold text-kumo-default">Mail history</h3>
						{timeline.items.length > 0 ? <span className="text-xs text-kumo-subtle">{timeline.items.length} messages loaded</span> : null}
					</div>
					{timeline.isPending || timeline.building ? (
						<p className="px-4 py-5 text-sm text-kumo-subtle sm:px-5" role="status" aria-live="polite">Loading message evidence…</p>
					) : timeline.isError && timeline.items.length === 0 ? (
						<div className="px-4 py-4 sm:px-5" role="alert">
							<p className="text-sm text-kumo-danger">Mail history could not load.</p>
							<button type="button" onClick={() => void timeline.refetch()} className="mt-2 min-h-11 rounded-md border border-kumo-line px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
						</div>
					) : timeline.items.length === 0 ? (
						<p className="px-4 py-5 text-sm text-kumo-subtle sm:px-5">No eligible messages remain.</p>
					) : (
						<div className="mt-2 divide-y divide-kumo-line">
							{timeline.items.map((item) => (
								<Link key={`${item.messageId}:${item.role}`} to={messageUrl(mailboxId, item.folder.id, item.messageId)} className="flex min-h-16 items-start gap-3 px-4 py-3 hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-kumo-ring sm:px-5">
									<span className="min-w-0 flex-1">
										<span className="block truncate text-sm font-medium text-kumo-default">{item.subject || "(No subject)"}</span>
										<span className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-kumo-subtle">
											<span>{directionLabel(item.direction)}</span>
											<span>{roleLabel(item.role)}</span>
											<span>{item.folder.name}</span>
											{item.origin === "admin_import" ? <span>Imported</span> : null}
											{item.attachments.length > 0 ? <span>{item.attachments.length} {item.attachments.length === 1 ? "file" : "files"}</span> : null}
										</span>
									</span>
									<span className="shrink-0 text-xs text-kumo-subtle">{formatDetailDate(item.date)}</span>
									<ArrowSquareOutIcon size={17} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
								</Link>
							))}
						</div>
					)}
					{timeline.items.length > 0 && timeline.isError ? (
						<div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-danger" role="alert">
							<span>More history could not load. Existing evidence is unchanged.</span>
							<button type="button" onClick={() => void (timeline.isFetchNextPageError ? timeline.fetchNextPage() : timeline.refetch())} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
						</div>
					) : null}
					{timeline.hasNextPage && !timeline.isFetchNextPageError ? (
						<div className="border-t border-kumo-line p-3 text-center">
							<button type="button" onClick={() => void timeline.fetchNextPage()} disabled={timeline.isFetchingNextPage} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50">
								{timeline.isFetchingNextPage ? "Loading more…" : "Load more history"}
							</button>
						</div>
					) : null}
				</section>
			</div>
		</div>
	);
}
