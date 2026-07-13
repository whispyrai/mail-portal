import { Button } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, PaperclipIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import { useId } from "react";
import { getFolderDisplayName } from "../../../../shared/folders.ts";
import type { SemanticSearchResult } from "../../../../shared/semantic-search.ts";
import { semanticSearchExcerptPreview } from "../../../lib/semantic-search-session.ts";

function formatResultDate(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

export default function MeaningResultRow({
	result,
	expanded,
	onExpandedChange,
}: {
	result: SemanticSearchResult;
	expanded: boolean;
	onExpandedChange(expanded: boolean): void;
}) {
	const excerptId = useId();
	const collapsedExcerpt = semanticSearchExcerptPreview(result.excerpt);
	const canExpand = collapsedExcerpt !== result.excerpt;
	const attachment = result.source === "attachment" ? result : null;
	const evidenceHref = attachment
		? `/mailbox/${encodeURIComponent(result.mailboxId)}/attachments?selected=${encodeURIComponent(attachment.attachmentId)}`
		: `/mailbox/${encodeURIComponent(result.mailboxId)}/open/${encodeURIComponent(result.messageId)}`;
	const evidenceLabel = attachment
		? `Open file ${attachment.attachmentFilename} in ${result.mailboxAddress}`
		: `Open message ${result.subject || "without a subject"} in ${result.mailboxAddress}`;
	return (
		<li className="py-6 first:pt-5 last:pb-5">
			<article>
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-kumo-subtle">
					<span className="break-all font-semibold text-kumo-strong">{result.mailboxAddress}</span>
					<span aria-hidden="true">·</span>
					<span>{getFolderDisplayName(result.folderId)}</span>
					<span aria-hidden="true">·</span>
					<time dateTime={result.date}>{formatResultDate(result.date)}</time>
				</div>
				<h3 className="mt-2 break-words text-lg font-semibold leading-7 tracking-tight text-kumo-default">
					{result.subject || "(No subject)"}
				</h3>
				<p className="mt-1 break-words text-sm text-kumo-subtle">{result.counterparty || "Unknown correspondent"}</p>
				{attachment && (
					<p className="mt-3 flex min-w-0 items-center gap-2 text-xs font-medium text-kumo-subtle">
						<PaperclipIcon size={15} className="shrink-0" aria-hidden="true" />
						<span className="break-all">Extracted from {attachment.attachmentFilename}</span>
					</p>
				)}
				<p id={excerptId} className="mt-4 whitespace-pre-wrap break-words text-sm leading-6 text-kumo-strong">
					{expanded ? result.excerpt : collapsedExcerpt}
				</p>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					{canExpand && <Button
						variant="ghost"
						onClick={() => onExpandedChange(!expanded)}
						aria-expanded={expanded}
						aria-controls={excerptId}
						className="min-h-11"
					>
						{expanded ? "Show less" : "Show full excerpt"}
					</Button>}
					<Link
						to={evidenceHref}
						aria-label={evidenceLabel}
						className="inline-flex min-h-11 items-center gap-2 rounded-md border border-kumo-line bg-kumo-base px-3 text-sm font-medium text-kumo-default no-underline hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
					>
						{attachment ? "Open file" : "Open message"} <ArrowSquareOutIcon size={16} aria-hidden="true" />
					</Link>
				</div>
			</article>
		</li>
	);
}
