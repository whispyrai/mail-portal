import {
	ArrowsClockwiseIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError } from "~/services/api";
import { useUIStore } from "~/hooks/useUIStore";
import {
	clampListPaneWidth,
	supportsSplitView,
} from "~/lib/list-pane-resize";
import { useMailPeople } from "~/queries/people";
import {
	exitRevokedMailbox,
	resolveMailboxChangeFeedStorage,
} from "~/queries/mailbox-change-feed";
import PeopleList from "./PeopleList.tsx";
import PersonDetail from "./PersonDetail.tsx";
import {
	paramsWithPeopleFilters,
	paramsWithSelectedPerson,
	peopleWorkspaceStateFromParams,
	type PeopleSort,
} from "./people-workspace-state.ts";

const SORT_LABELS: Record<PeopleSort, string> = {
	recent: "Most recent",
	frequent: "Most frequent",
	address: "Email address",
};

export default function PeopleWorkspace() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const urlState = useMemo(
		() => peopleWorkspaceStateFromParams(searchParams),
		[searchParams],
	);
	const [draftQuery, setDraftQuery] = useState(urlState.q);
	const [filterError, setFilterError] = useState<string | null>(null);
	const { listPaneWidth } = useUIStore();
	const invalidUrlState = Boolean(
		urlState.invalidQuery ||
		urlState.invalidSort ||
		urlState.invalidSelection,
	);
	const peopleQuery = useMailPeople(mailboxId, {
		q: urlState.q,
		sort: urlState.sort,
	}, !invalidUrlState);
	const activeSelectedId = invalidUrlState ? null : urlState.selected;
	const canvasRef = useRef<HTMLDivElement>(null);
	const focusOriginRef = useRef<string | null>(null);
	const previousSelectedRef = useRef<string | null>(urlState.selected);
	const revokedExitStartedRef = useRef(false);
	const [revokedByFeature, setRevokedByFeature] = useState(false);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);
	const accessRevoked = revokedByFeature ||
		(peopleQuery.error instanceof ApiError && peopleQuery.error.status === 403);
	const exitForRevokedAccess = useCallback((
		revokedMailboxId = mailboxId,
		active = true,
	) => {
		if (!active || revokedMailboxId !== mailboxId) {
			exitRevokedMailbox({
				queryClient,
				mailboxId: revokedMailboxId,
				storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			});
			return;
		}
		setRevokedByFeature(true);
		if (revokedExitStartedRef.current) return;
		revokedExitStartedRef.current = true;
		exitRevokedMailbox({
			queryClient,
			mailboxId,
			storage: resolveMailboxChangeFeedStorage(() => window.localStorage),
			onExit: () => navigate("/", { replace: true }),
		});
	}, [mailboxId, navigate, queryClient]);

	useEffect(() => setDraftQuery(urlState.q), [urlState.q]);

	useEffect(() => {
		revokedExitStartedRef.current = false;
		setRevokedByFeature(false);
	}, [mailboxId]);

	useEffect(() => {
		if (accessRevoked) exitForRevokedAccess();
	}, [accessRevoked, exitForRevokedAccess]);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const recordWidth = (width: number) => {
			const next = Math.max(0, Math.round(width));
			setContainerWidth((current) => current === next ? current : next);
		};
		const measure = () => recordWidth(canvas.getBoundingClientRect().width);
		measure();
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver((entries) => {
				const entry = entries[0];
				if (entry) recordWidth(entry.contentRect.width);
			});
			observer.observe(canvas);
			return () => observer.disconnect();
		}
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);

	useEffect(() => {
		const previous = previousSelectedRef.current;
		previousSelectedRef.current = urlState.selected;
		if (!previous || urlState.selected || !focusOriginRef.current) return;
		const rowId = focusOriginRef.current;
		requestAnimationFrame(() => {
			document.getElementById(`person-row-${rowId}`)?.focus();
		});
	}, [urlState.selected]);

	const applyFilters = (q: string, sort: PeopleSort) => {
		const candidate = peopleWorkspaceStateFromParams(new URLSearchParams({ q }));
		if (candidate.invalidQuery) {
			setFilterError(candidate.invalidQuery);
			return;
		}
		setFilterError(null);
		setSearchParams(paramsWithPeopleFilters(searchParams, {
			q: candidate.q,
			sort,
		}));
	};

	const clearInvalidState = () => {
		setFilterError(null);
		setSearchParams(paramsWithPeopleFilters(searchParams, {
			q: "",
			sort: "recent",
		}), { replace: true });
	};

	const selectPerson = (personId: string) => {
		focusOriginRef.current = personId;
		setSearchParams(paramsWithSelectedPerson(searchParams, personId));
	};

	const closeDetail = () => {
		setSearchParams(paramsWithSelectedPerson(searchParams, null), { replace: true });
	};

	const isSplitView = Boolean(activeSelectedId) && supportsSplitView(containerWidth);
	const renderedListPaneWidth = containerWidth === null
		? listPaneWidth
		: clampListPaneWidth(listPaneWidth, containerWidth);
	const listCanvasWidth = isSplitView
		? renderedListPaneWidth
		: containerWidth ?? 0;
	const filtersInline = listCanvasWidth >= 560;
	const showStaleList = peopleQuery.items.length > 0 && !accessRevoked;
	if (accessRevoked) {
		return (
			<div className="grid h-full min-h-0 place-items-center bg-kumo-base p-6 text-center text-sm text-kumo-subtle" role="status" aria-live="polite">
				Mailbox access changed. Returning to your mailboxes…
			</div>
		);
	}

	return (
		<div ref={canvasRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
			<section
				aria-label="People collection"
				className={`min-h-0 min-w-0 shrink-0 flex-col bg-kumo-base ${activeSelectedId && !isSplitView ? "hidden" : "flex"} ${isSplitView ? "border-r border-kumo-line" : "w-full"}`}
				style={isSplitView ? { width: `${renderedListPaneWidth}px` } : undefined}
			>
				<header className="shrink-0 border-b border-kumo-line px-4 py-3 sm:px-5">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-lg font-semibold tracking-tight text-kumo-default">People</h1>
							<p className="mt-0.5 text-sm text-kumo-subtle" aria-live="polite">
								{invalidUrlState
									? "Link needs attention"
									: peopleQuery.building
										? `${peopleQuery.building.processedMessages.toLocaleString()} messages checked`
										: `${peopleQuery.items.length} ${peopleQuery.items.length === 1 ? "person" : "people"} loaded`}
							</p>
						</div>
						<button
							type="button"
							onClick={() => {
								if (!invalidUrlState) void peopleQuery.refetch();
							}}
							disabled={peopleQuery.isRefetching || invalidUrlState}
							className="inline-flex min-h-11 items-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50"
						>
							<ArrowsClockwiseIcon size={17} className={peopleQuery.isRefetching ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />
							Refresh
						</button>
					</div>

					<form
						className={`mt-3 grid gap-2 ${filtersInline ? "grid-cols-[minmax(180px,1fr)_170px]" : "grid-cols-1"}`}
						onSubmit={(event) => {
							event.preventDefault();
							applyFilters(draftQuery, urlState.sort);
						}}
					>
						<label className="relative block">
							<span className="sr-only">Search people</span>
							<MagnifyingGlassIcon size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle" aria-hidden="true" />
							<input
								type="search"
								value={draftQuery}
								onChange={(event) => setDraftQuery(event.target.value)}
								placeholder="Search name or email"
								className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base pl-9 pr-3 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-ring"
							/>
						</label>
						<label>
							<span className="sr-only">Sort people</span>
							<select
								value={urlState.sort}
								onChange={(event) => applyFilters(draftQuery, event.target.value as PeopleSort)}
								className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default focus:outline-none focus:ring-2 focus:ring-kumo-ring"
							>
								{Object.entries(SORT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
							</select>
						</label>
					</form>
					{filterError ? <p className="mt-2 text-sm text-kumo-danger" role="alert">{filterError}</p> : null}
					{invalidUrlState ? (
						<div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">
							<span>
								{urlState.invalidQuery ?? urlState.invalidSelection ?? `The sort “${urlState.invalidSort}” is not supported.`}
							</span>
							<button type="button" onClick={clearInvalidState} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Reset view</button>
						</div>
					) : null}
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{invalidUrlState ? (
						<div className="grid h-full min-h-56 place-items-center p-5 text-center text-sm text-kumo-subtle">Reset the link to load mailbox People safely.</div>
					) : peopleQuery.building ? (
						<div className="grid h-full min-h-56 place-items-center p-5 text-center" role="status" aria-live="polite">
							<div className="max-w-sm">
								<h2 className="font-semibold text-kumo-default">Building relationship history</h2>
								<p className="mt-2 text-sm leading-6 text-kumo-subtle">{peopleQuery.building.processedMessages.toLocaleString()} messages checked. This page refreshes after the server finishes the next bounded batch.</p>
							</div>
						</div>
					) : peopleQuery.isPending ? (
						<div className="grid h-full min-h-56 place-items-center text-sm text-kumo-subtle" role="status" aria-live="polite">Loading people…</div>
					) : peopleQuery.isError && !showStaleList ? (
						<div className="grid h-full min-h-56 place-items-center p-5" role="alert">
							<div className="max-w-sm text-center">
								<h2 className="font-semibold text-kumo-default">{accessRevoked ? "Mailbox access changed" : "People could not load"}</h2>
								<p className="mt-2 text-sm leading-6 text-kumo-subtle">{accessRevoked ? "This Mailbox is no longer available to this account." : "The request could not be completed. Your mail was not changed."}</p>
								{!accessRevoked ? <button type="button" onClick={() => void peopleQuery.refetch()} className="mt-4 min-h-11 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button> : null}
							</div>
						</div>
					) : peopleQuery.items.length === 0 ? (
						<div className="grid h-full min-h-56 place-items-center p-5 text-center">
							<div className="max-w-sm">
								<h2 className="font-semibold text-kumo-default">{urlState.q ? "No people match this search" : "No relationship history yet"}</h2>
								<p className="mt-2 text-sm leading-6 text-kumo-subtle">{urlState.q ? "Try a different name, address, or domain." : "People appear after this Mailbox receives or successfully sends eligible mail."}</p>
							</div>
						</div>
					) : (
						<PeopleList items={peopleQuery.items} selectedId={activeSelectedId} onSelect={selectPerson} />
					)}
					{showStaleList && peopleQuery.isError ? (
						<div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-danger" role="alert">
							<span>{peopleQuery.isFetchNextPageError ? "More people could not load. Existing results are unchanged." : "People could not refresh. Existing results are unchanged."}</span>
							<button type="button" onClick={() => void (peopleQuery.isFetchNextPageError ? peopleQuery.fetchNextPage() : peopleQuery.refetch())} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
						</div>
					) : null}
					{peopleQuery.hasNextPage && !peopleQuery.isFetchNextPageError ? (
						<div className="border-t border-kumo-line p-3 text-center">
							<button type="button" onClick={() => void peopleQuery.fetchNextPage()} disabled={peopleQuery.isFetchingNextPage} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50">
								{peopleQuery.isFetchingNextPage ? "Loading more…" : "Load more people"}
							</button>
						</div>
					) : null}
				</div>
			</section>

			{activeSelectedId ? (
				<section aria-label="Relationship detail" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					<PersonDetail mailboxId={mailboxId} personId={activeSelectedId} showBack={!isSplitView} focusHeading={!isSplitView} onBack={closeDetail} onAccessRevoked={exitForRevokedAccess} />
				</section>
			) : null}
		</div>
	);
}
