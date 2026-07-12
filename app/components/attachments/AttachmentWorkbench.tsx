import {
	ArrowsClockwiseIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
	ATTACHMENT_KINDS,
	mailboxAttachmentFilenameLikePattern,
	type AttachmentKind,
} from "../../../shared/mailbox-attachments.ts";
import { Folders, InternalFolders } from "../../../shared/folders.ts";
import { useUIStore } from "~/hooks/useUIStore";
import {
	clampListPaneWidth,
	supportsSplitView,
} from "~/lib/list-pane-resize";
import {
	useMailboxAttachmentDetail,
	useMailboxAttachments,
} from "~/queries/attachments";
import { useFolders } from "~/queries/folders";
import AttachmentList from "./AttachmentList.tsx";
import AttachmentPreview from "./AttachmentPreview.tsx";
import {
	attachmentWorkbenchStateFromParams,
	paramsWithAttachmentFilter,
	paramsWithSelectedAttachment,
} from "./attachment-workbench-state.ts";

const KIND_LABELS: Record<AttachmentKind, string> = {
	image: "Images",
	pdf: "PDFs",
	document: "Documents",
	spreadsheet: "Spreadsheets",
	presentation: "Presentations",
	archive: "Archives",
	other: "Other",
};

export default function AttachmentWorkbench() {
	const { mailboxId = "" } = useParams<{ mailboxId: string }>();
	const [searchParams, setSearchParams] = useSearchParams();
	const urlState = useMemo(
		() => attachmentWorkbenchStateFromParams(searchParams),
		[searchParams],
	);
	const [draftQuery, setDraftQuery] = useState(urlState.q);
	const [filterError, setFilterError] = useState<string | null>(null);
	const { listPaneWidth } = useUIStore();
	const { data: folders = [] } = useFolders(mailboxId);
	const attachmentQuery = useMailboxAttachments(mailboxId, {
		q: urlState.q,
		kind: urlState.kind,
		folder: urlState.folder,
	}, urlState.invalidKind === null);
	const activeSelectedId = urlState.invalidKind ? null : urlState.selected;
	const selectedFromList = attachmentQuery.items.find(
		(item) => item.id === activeSelectedId,
	) ?? null;
	const selectedDetail = useMailboxAttachmentDetail(
		mailboxId,
		activeSelectedId,
		selectedFromList,
	);
	const selectedAttachment = selectedFromList ?? selectedDetail.data ?? null;
	const canvasRef = useRef<HTMLDivElement>(null);
	const focusOriginRef = useRef<string | null>(null);
	const previousSelectedRef = useRef<string | null>(urlState.selected);
	const [containerWidth, setContainerWidth] = useState<number | null>(null);

	useEffect(() => setDraftQuery(urlState.q), [urlState.q]);

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
			document.getElementById(`attachment-row-${rowId}`)?.focus();
		});
	}, [urlState.selected]);

	const applyFilters = (
		q: string,
		kind: AttachmentKind | "",
		folder: string,
	) => {
		try {
			const normalizedQuery = q.trim().normalize("NFC");
			if (normalizedQuery) mailboxAttachmentFilenameLikePattern(normalizedQuery);
			setFilterError(null);
			setSearchParams(paramsWithAttachmentFilter(searchParams, {
				q: normalizedQuery,
				kind,
				folder,
			}));
		} catch (error) {
			setFilterError(error instanceof Error ? error.message : "Search is too long");
		}
	};

	const selectAttachment = (attachmentId: string) => {
		focusOriginRef.current = attachmentId;
		setSearchParams(paramsWithSelectedAttachment(searchParams, attachmentId));
	};

	const closePreview = () => {
		setSearchParams(paramsWithSelectedAttachment(searchParams, null), { replace: true });
	};

	const isSplitView = Boolean(activeSelectedId) && supportsSplitView(containerWidth);
	const renderedListPaneWidth = containerWidth === null
		? listPaneWidth
		: clampListPaneWidth(listPaneWidth, containerWidth);
	const filterCanvasWidth = isSplitView ? renderedListPaneWidth : (containerWidth ?? 0);
	const filtersInline = filterCanvasWidth >= 640;
	const visibleFolders = folders.filter((folder) =>
		folder.id !== Folders.DRAFT &&
		folder.id !== Folders.OUTBOX &&
		folder.id !== InternalFolders.RETIRED_OUTBOUND
	);

	return (
		<div ref={canvasRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
			<section
				aria-label="Files collection"
				className={`min-h-0 min-w-0 shrink-0 flex-col bg-kumo-base ${activeSelectedId && !isSplitView ? "hidden" : "flex"} ${isSplitView ? "border-r border-kumo-line" : "w-full"}`}
				style={isSplitView ? { width: `${renderedListPaneWidth}px` } : undefined}
			>
				<header className="shrink-0 border-b border-kumo-line px-4 py-3 sm:px-5">
					<div className="flex items-center justify-between gap-3">
						<div>
							<h1 className="text-lg font-semibold text-kumo-default">Files</h1>
							<p className="mt-0.5 text-sm text-kumo-subtle" aria-live="polite">
								{urlState.invalidKind
									? "Filter needs attention"
									: `${attachmentQuery.items.length} ${attachmentQuery.items.length === 1 ? "file" : "files"} loaded`}
							</p>
						</div>
						<button
							type="button"
							onClick={() => {
								if (!urlState.invalidKind) void attachmentQuery.refetch();
							}}
							disabled={attachmentQuery.isRefetching || Boolean(urlState.invalidKind)}
							className="inline-flex min-h-11 items-center gap-2 rounded-md border border-kumo-line px-3 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50"
						>
							<ArrowsClockwiseIcon size={17} className={attachmentQuery.isRefetching ? "animate-spin motion-reduce:animate-none" : ""} aria-hidden="true" />
							Refresh
						</button>
					</div>

					<form
						className={`mt-3 grid gap-2 ${filtersInline ? "grid-cols-[minmax(180px,1fr)_160px_180px]" : "grid-cols-1"}`}
						onSubmit={(event) => {
							event.preventDefault();
							applyFilters(draftQuery, urlState.kind, urlState.folder);
						}}
					>
						<label className="relative block">
							<span className="sr-only">Search filenames</span>
							<MagnifyingGlassIcon size={17} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kumo-subtle" aria-hidden="true" />
							<input
								type="search"
								value={draftQuery}
								onChange={(event) => setDraftQuery(event.target.value)}
								placeholder="Search filenames"
								className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base pl-9 pr-3 text-sm text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-ring"
							/>
						</label>
						<label>
							<span className="sr-only">File kind</span>
							<select
								value={urlState.invalidKind ?? urlState.kind}
								onChange={(event) => applyFilters(draftQuery, event.target.value as AttachmentKind | "", urlState.folder)}
								className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default focus:outline-none focus:ring-2 focus:ring-kumo-ring"
							>
								<option value="">All kinds</option>
								{urlState.invalidKind && <option value={urlState.invalidKind} disabled>Unsupported: {urlState.invalidKind}</option>}
								{ATTACHMENT_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
							</select>
						</label>
						<label>
							<span className="sr-only">Current folder</span>
							<select
								value={urlState.folder}
								onChange={(event) => applyFilters(draftQuery, urlState.kind, event.target.value)}
								className="min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default focus:outline-none focus:ring-2 focus:ring-kumo-ring"
							>
								<option value="">All folders</option>
								{visibleFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
							</select>
						</label>
					</form>
					{filterError && <p className="mt-2 text-sm text-kumo-danger" role="alert">{filterError}</p>}
					{urlState.invalidKind && (
						<div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger" role="alert">
							<span>The file kind “{urlState.invalidKind}” is not supported. No files were loaded.</span>
							<button type="button" onClick={() => applyFilters(draftQuery, "", urlState.folder)} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Clear filter</button>
						</div>
					)}
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">
					{urlState.invalidKind ? (
						<div className="grid min-h-56 place-items-center p-5 text-center text-sm text-kumo-subtle">Choose a supported file kind to view files.</div>
					) : attachmentQuery.isPending ? (
						<div className="grid min-h-56 place-items-center text-sm text-kumo-subtle" role="status" aria-live="polite">
							Loading files…
						</div>
					) : attachmentQuery.isError && attachmentQuery.items.length === 0 ? (
						<div className="grid min-h-56 place-items-center p-5" role="alert">
							<div className="max-w-sm text-center">
								<h2 className="font-semibold text-kumo-default">Files could not load</h2>
								<p className="mt-2 text-sm text-kumo-subtle">Access may have changed, or the request could not be completed.</p>
								<button type="button" onClick={() => void attachmentQuery.refetch()} className="mt-4 min-h-11 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
							</div>
						</div>
					) : attachmentQuery.items.length === 0 ? (
						<div className="grid min-h-56 place-items-center p-5 text-center">
							<div>
								<h2 className="font-semibold text-kumo-default">No files found</h2>
								<p className="mt-2 text-sm text-kumo-subtle">Try a different filename, kind, or folder.</p>
							</div>
						</div>
					) : (
						<AttachmentList mailboxId={mailboxId} items={attachmentQuery.items} selectedId={activeSelectedId} onSelect={selectAttachment} />
					)}
					{attachmentQuery.items.length > 0 && attachmentQuery.isError && (
						<div className="flex items-center justify-between gap-3 border-t border-kumo-line bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-danger" role="alert">
							<span>
								{attachmentQuery.isFetchNextPageError
									? "More files could not be loaded. The files already shown are unchanged."
									: "Files could not refresh. The last accepted results are still shown."}
							</span>
							<button
								type="button"
								onClick={() => void (attachmentQuery.isFetchNextPageError
									? attachmentQuery.fetchNextPage()
									: attachmentQuery.refetch())}
								className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
							>
								Try again
							</button>
						</div>
					)}
					{attachmentQuery.hasNextPage && !attachmentQuery.isFetchNextPageError && (
						<div className="border-t border-kumo-line p-3 text-center">
							<button type="button" onClick={() => void attachmentQuery.fetchNextPage()} disabled={attachmentQuery.isFetchingNextPage} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:opacity-50">
								{attachmentQuery.isFetchingNextPage ? "Loading more…" : "Load more files"}
							</button>
						</div>
					)}
				</div>
			</section>

			{activeSelectedId && (
				<section aria-label="File preview" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{selectedDetail.isPending && !selectedFromList ? (
						<div className="grid h-full place-items-center text-sm text-kumo-subtle" role="status">Loading file details…</div>
					) : !selectedAttachment ? (
						<div className="grid h-full place-items-center p-5" role="alert">
							<div className="max-w-sm text-center">
								<h2 className="font-semibold text-kumo-default">File no longer available</h2>
								<p className="mt-2 text-sm text-kumo-subtle">The attachment may have moved, been removed, or access may have changed.</p>
								<div className="mt-4 flex flex-wrap justify-center gap-2">
									<button type="button" onClick={closePreview} className="min-h-11 rounded-md border border-kumo-line px-4 text-sm font-medium text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Back to files</button>
									<button type="button" onClick={() => void selectedDetail.refetch()} className="min-h-11 rounded-md bg-kumo-brand px-4 text-sm font-medium text-kumo-inverse focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
								</div>
							</div>
						</div>
					) : (
						<>
							{selectedDetail.isError && selectedAttachment && (
								<div className="flex shrink-0 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-danger-tint px-4 py-2 text-sm text-kumo-danger" role="alert">
									<span>File details could not refresh. The last accepted details are still shown.</span>
									<button type="button" onClick={() => void selectedDetail.refetch()} className="min-h-11 shrink-0 rounded-md px-3 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">Try again</button>
								</div>
							)}
							<AttachmentPreview mailboxId={mailboxId} attachment={selectedAttachment} showBack={!isSplitView} focusHeading={!isSplitView} onBack={closePreview} />
						</>
					)}
				</section>
			)}
		</div>
	);
}
