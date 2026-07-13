import { BinocularsIcon, ShieldCheckIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useRef, type RefObject } from "react";
import { SEMANTIC_SEARCH_LIMITS, type SemanticSearchResponse } from "../../../../shared/semantic-search.ts";
import { semanticSearchResultIdentity } from "../../../lib/semantic-search-session.ts";
import MeaningResultRow from "./MeaningResultRow.tsx";
import MeaningSearchForm from "./MeaningSearchForm.tsx";
import MeaningStatusPanel from "./MeaningStatusPanel.tsx";

function LoadingEvidence() {
	return (
		<div className="animate-pulse border-y border-kumo-line" role="status" aria-label="Finding meaning across your Mailboxes">
			{[0, 1, 2].map((item) => (
				<div key={item} className="border-b border-kumo-line py-6 last:border-b-0">
					<div className="h-3 w-48 rounded bg-kumo-fill" />
					<div className="mt-3 h-6 max-w-lg rounded bg-kumo-fill" />
					<div className="mt-4 h-16 rounded bg-kumo-fill" />
				</div>
			))}
			<span className="sr-only">Finding evidence…</span>
		</div>
	);
}

export default function GlobalMeaningWorkspace({
	draftQuery,
	submittedQuery,
	response,
	isLoading,
	error,
	isOnline,
	expandedResultIds,
	initialScrollTop,
	resultsHeadingRef,
	onDraftQueryChange,
	onSubmit,
	onRetry,
	onExpandedChange,
	onScrollPositionChange,
}: {
	draftQuery: string;
	submittedQuery: string;
	response: SemanticSearchResponse | null;
	isLoading: boolean;
	error: string | null;
	isOnline: boolean;
	expandedResultIds: ReadonlySet<string>;
	initialScrollTop: number;
	resultsHeadingRef: RefObject<HTMLHeadingElement | null>;
	onDraftQueryChange(query: string): void;
	onSubmit(): void;
	onRetry(): void;
	onExpandedChange(identity: string, expanded: boolean): void;
	onScrollPositionChange(scrollTop: number): void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (scrollRef.current && scrollRef.current.scrollTop !== initialScrollTop) {
			scrollRef.current.scrollTop = initialScrollTop;
		}
	}, [initialScrollTop]);
	const settled = Boolean(response);
	const definitiveZero = response?.state === "complete" && response.results.length === 0;
	const resultCountLabel = response?.results.length === SEMANTIC_SEARCH_LIMITS.resultLimit
		? `Top ${SEMANTIC_SEARCH_LIMITS.resultLimit} evidence matches`
		: `${response?.results.length ?? 0} evidence match${response?.results.length === 1 ? "" : "es"}`;
	const nonDefinitiveEmptyCopy = response?.state === "partial"
		? "No evidence matched in the Mailboxes searched so far. Other Mailboxes are still preparing, so this is not final."
		: response?.state === "building"
			? "No evidence is ready until a Mailbox finishes preparing."
			: "No evidence is available because none of your Mailboxes could be searched.";

	return (
		<div
			ref={scrollRef}
			className="h-full min-w-0 overflow-y-auto bg-kumo-base"
			onScroll={(event) => onScrollPositionChange(event.currentTarget.scrollTop)}
		>
			<div className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-7 sm:py-10 lg:px-10 lg:py-12">
				<header className="border-b border-kumo-line pb-8">
					<p className="flex items-center gap-2 text-sm font-medium text-kumo-subtle">
						<BinocularsIcon size={18} aria-hidden="true" /> Cross-Mailbox evidence
					</p>
					<h1 className="mt-3 text-3xl font-semibold tracking-tight text-kumo-default sm:text-4xl">Meaning</h1>
					<p className="mt-3 max-w-2xl text-base leading-7 text-kumo-strong">
						Find mail by what it means, even when the wording differs.
					</p>
					<div className="mt-4 flex max-w-2xl items-start gap-3 text-sm leading-6 text-kumo-subtle">
						<ShieldCheckIcon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
						<p>This returns attributable Message and attachment evidence, not an AI-written answer. Opening evidence does not change its read state.</p>
					</div>
					<MeaningSearchForm
						query={draftQuery}
						isLoading={isLoading}
						isOnline={isOnline}
						onQueryChange={onDraftQueryChange}
						onSubmit={onSubmit}
					/>
				</header>

				<MeaningStatusPanel response={response} error={error} isOnline={isOnline} isLoading={isLoading} onRetry={onRetry} />

				{!isLoading && !error && !settled && (
					<section className="grid min-h-72 place-items-center py-12 text-center" aria-labelledby="meaning-start-title">
						<div className="max-w-lg">
							<BinocularsIcon size={40} weight="thin" className="mx-auto text-kumo-subtle" aria-hidden="true" />
							<h2 id="meaning-start-title" className="mt-4 text-xl font-semibold text-kumo-default">Search the idea, not the exact phrase</h2>
							<p className="mt-2 text-sm leading-6 text-kumo-subtle">Try an outcome, concern, promise, or decision. Meaning searches Inbox, Sent, Snoozed, Archive, and ordinary custom folders you can access.</p>
						</div>
					</section>
				)}

				{isLoading && (
					<section className="pt-8" aria-labelledby="meaning-loading-title">
						<h2 id="meaning-loading-title" className="mb-4 text-lg font-semibold text-kumo-default">Finding evidence</h2>
						<p className="mb-5 text-sm text-kumo-subtle">Looking for “{submittedQuery}” across accessible Mailboxes.</p>
						<LoadingEvidence />
					</section>
				)}

				{response && (
					<section className="pt-8" aria-labelledby="meaning-results-title">
						<div className="flex flex-wrap items-end justify-between gap-3 pb-4">
							<div>
								<h2 ref={resultsHeadingRef} tabIndex={-1} id="meaning-results-title" className="text-xl font-semibold tracking-tight text-kumo-default outline-none">
									Evidence
								</h2>
								<p className="mt-1 text-sm text-kumo-subtle">For “{submittedQuery}”</p>
							</div>
							{response.results.length > 0 && <span className="text-sm tabular-nums text-kumo-subtle">{resultCountLabel}</span>}
						</div>
						{response.results.length > 0 ? (
							<ol className="divide-y divide-kumo-line border-y border-kumo-line" aria-label="Ranked mail evidence">
								{response.results.map((result) => {
									const identity = semanticSearchResultIdentity(result);
									return <MeaningResultRow key={identity} result={result} expanded={expandedResultIds.has(identity)} onExpandedChange={(expanded) => onExpandedChange(identity, expanded)} />;
								})}
							</ol>
						) : definitiveZero ? (
							<div className="grid min-h-48 place-items-center border-y border-kumo-line py-10 text-center">
								<div className="max-w-md"><p className="font-medium text-kumo-default">No active-history evidence matched this meaning</p><p className="mt-2 text-sm leading-6 text-kumo-subtle">Try a broader outcome, concern, promise, or decision. Drafts, Outbox, Trash, and Spam are intentionally excluded.</p></div>
							</div>
						) : (
							<div className="min-h-28 border-y border-kumo-line py-8 text-sm leading-6 text-kumo-subtle">{nonDefinitiveEmptyCopy}</div>
						)}
					</section>
				)}
			</div>
		</div>
	);
}
