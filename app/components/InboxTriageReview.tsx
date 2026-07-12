import { Button, Dialog, Loader } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowClockwiseIcon,
	ArrowSquareOutIcon,
	EnvelopeOpenIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	createInboxTriageRequestController,
	createInboxTriageReviewSelection,
	inboxTriageSnapshotKey,
	inboxTriageSnapshotsEqual,
	planInboxTriageApply,
	reconcileInboxTriageApplyResult,
	toggleInboxTriageReviewSelection,
	type InboxTriageVisibleSnapshot,
} from "~/lib/inbox-triage-review";
import { useBatchTriage } from "~/queries/emails";
import { useInboxTriageSuggestions } from "~/queries/inbox-triage-suggestions";
import { useMailboxes } from "~/queries/mailboxes";
import type {
	InboxTriageSuggestion,
	InboxTriageSuggestionAction,
} from "~/services/inbox-triage-suggestions";

type GenerationState =
	| "idle"
	| "loading"
	| "ready"
	| "budget_paused"
	| "stale"
	| "error";

export type InboxTriageReviewProps = {
	open: boolean;
	onOpenChange(open: boolean): void;
	mailboxId: string;
	snapshot: InboxTriageVisibleSnapshot;
	onOpenEvidence(messageId: string): void;
};

function counterpartyFor(row: InboxTriageVisibleSnapshot["rows"][number]): string {
	const participants = row.participants || row.sender;
	const names = participants
		.split(",")
		.map((participant) => participant.trim().split("@")[0])
		.filter((name, index, all) => name && all.indexOf(name) === index);
	if (names.length === 0) return "Unknown sender";
	if (names.length <= 3) return names.join(", ");
	return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function actionCopy(action: InboxTriageSuggestionAction) {
	return action === "archive"
		? { title: "Archive", icon: ArchiveIcon, verb: "archive" }
		: { title: "Mark read", icon: EnvelopeOpenIcon, verb: "read" };
}

function SuggestionGroup({
	action,
	suggestions,
	rows,
	selectedIds,
	failedIds,
	disabled,
	onToggle,
	onDismiss,
	onOpenEvidence,
}: {
	action: InboxTriageSuggestionAction;
	suggestions: readonly InboxTriageSuggestion[];
	rows: ReadonlyMap<string, InboxTriageVisibleSnapshot["rows"][number]>;
	selectedIds: ReadonlySet<string>;
	failedIds: ReadonlySet<string>;
	disabled: boolean;
	onToggle(candidateId: string): void;
	onDismiss(candidateId: string): void;
	onOpenEvidence(messageId: string): void;
}) {
	if (suggestions.length === 0) return null;
	const copy = actionCopy(action);
	const Icon = copy.icon;
	return (
		<section aria-labelledby={`triage-${action}-heading`}>
			<div className="flex items-center gap-2 border-b border-kumo-line bg-kumo-recessed px-4 py-3 sm:px-5">
				<Icon size={17} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
				<h3 id={`triage-${action}-heading`} className="font-semibold text-kumo-default">
					{copy.title}
				</h3>
				<span className="ms-auto text-sm tabular-nums text-kumo-subtle">
					{suggestions.length}
				</span>
			</div>
			<ul aria-label={`${copy.title} suggestions`}>
				{suggestions.map((suggestion) => {
					const row = rows.get(suggestion.emailId);
					const subject = row?.subject.trim() || "Conversation";
					const counterparty = row ? counterpartyFor(row) : "Unknown sender";
					const selected = selectedIds.has(suggestion.candidateId);
					const failed = failedIds.has(suggestion.candidateId);
					return (
						<li key={suggestion.candidateId} className="border-b border-kumo-line px-4 py-4 last:border-b-0 sm:px-5">
							<div className="flex min-w-0 items-start gap-3">
								<label className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-start justify-center rounded-md pt-2 focus-within:ring-2 focus-within:ring-kumo-brand">
									<input
										type="checkbox"
										className="h-5 w-5 accent-kumo-brand"
										checked={selected}
										disabled={disabled}
										onChange={() => onToggle(suggestion.candidateId)}
										aria-label={`${selected ? "Exclude" : "Include"} ${copy.verb} suggestion for ${subject}`}
									/>
								</label>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
										<p className="min-w-0 break-words font-medium text-kumo-default">
											{subject}
										</p>
										<span className="text-sm text-kumo-subtle">{counterparty}</span>
									</div>
									<p className="mt-2 text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
										Why
									</p>
									<p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-kumo-strong">
										{suggestion.explanation}
									</p>
									{failed && (
										<p role="alert" className="mt-2 text-sm text-kumo-danger">
											This conversation was not updated. Refresh suggestions or retry this group.
										</p>
									)}
									<div className="mt-2 flex flex-wrap items-center gap-1.5">
										<span className="me-1 text-xs font-medium text-kumo-subtle">Evidence</span>
										{suggestion.messageIds.map((messageId, index) => (
											<Button
												key={messageId}
												variant="ghost"
												size="sm"
												className="min-h-11"
												icon={<ArrowSquareOutIcon size={14} />}
												onClick={() => onOpenEvidence(messageId)}
												disabled={disabled}
												aria-label={`Open cited source message ${index + 1} for ${subject}`}
											>
												Source {index + 1}
											</Button>
										))}
										<Button
											variant="ghost"
											size="sm"
											className="min-h-11 sm:ms-auto"
											onClick={() => onDismiss(suggestion.candidateId)}
											disabled={disabled}
											aria-label={`Dismiss suggestion for ${subject}`}
										>
											Dismiss
										</Button>
									</div>
								</div>
							</div>
						</li>
					);
				})}
			</ul>
		</section>
	);
}

export default function InboxTriageReview({
	open,
	onOpenChange,
	mailboxId,
	snapshot,
	onOpenEvidence,
}: InboxTriageReviewProps) {
	const suggestionsMutation = useInboxTriageSuggestions();
	const batchTriage = useBatchTriage();
	const { data: mailboxes = [] } = useMailboxes();
	const [generationState, setGenerationState] = useState<GenerationState>("idle");
	const [responseSnapshot, setResponseSnapshot] =
		useState<InboxTriageVisibleSnapshot | null>(null);
	const [responseFingerprint, setResponseFingerprint] = useState<string | null>(null);
	const [suggestions, setSuggestions] = useState<InboxTriageSuggestion[]>([]);
	const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [failedSuggestionIds, setFailedSuggestionIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [applyingAction, setApplyingAction] =
		useState<InboxTriageSuggestionAction | null>(null);
	const [needsRefreshAfterApply, setNeedsRefreshAfterApply] = useState(false);
	const [feedback, setFeedback] = useState<string | null>(null);
	const [applyError, setApplyError] = useState<string | null>(null);
	const requestsRef = useRef(createInboxTriageRequestController());
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const currentSnapshotKey = inboxTriageSnapshotKey(snapshot);
	const previousSnapshotKeyRef = useRef(currentSnapshotKey);
	const isSharedMailbox = mailboxes.some(
		(mailbox) =>
			(mailbox.id === mailboxId || mailbox.email === mailboxId) &&
			mailbox.type === "SHARED",
	);
	const rows = useMemo(
		() => new Map((responseSnapshot ?? snapshot).rows.map((row) => [row.id, row])),
		[responseSnapshot, snapshot],
	);
	const stale =
		generationState === "stale" ||
		(!needsRefreshAfterApply &&
			Boolean(
				responseSnapshot &&
					(!responseFingerprint ||
						!inboxTriageSnapshotsEqual(responseSnapshot, snapshot)),
			));

	const loadSuggestions = useCallback(async () => {
		const requestedSnapshot = snapshotRef.current;
		if (!open || requestedSnapshot.rows.length === 0) return;
		const activeRequest = requestsRef.current.begin(requestedSnapshot);
		if (!activeRequest) return;
		setGenerationState("loading");
		setApplyError(null);
		setFeedback(null);
		setNeedsRefreshAfterApply(false);
		setFailedSuggestionIds(new Set());
		try {
			const response = await suggestionsMutation.mutateAsync({
				mailboxId,
				request: {
					page: requestedSnapshot.page,
					...(requestedSnapshot.labelId
						? { labelId: requestedSnapshot.labelId }
						: {}),
					visibleEmailIds: requestedSnapshot.rows.map((row) => row.id),
				},
				signal: activeRequest.controller.signal,
				requestToken: activeRequest.requestToken,
			});
			if (!requestsRef.current.isCurrent(activeRequest, snapshotRef.current)) {
				if (!activeRequest.controller.signal.aborted) setGenerationState("stale");
				return;
			}
			if (response.state === "stale") {
				setGenerationState("stale");
				return;
			}
			if (response.state === "budget_paused") {
				setGenerationState("budget_paused");
				return;
			}
			setResponseSnapshot(requestedSnapshot);
			setResponseFingerprint(response.fingerprint);
			setSuggestions(response.result.suggestions);
			setSelectedSuggestionIds(
				createInboxTriageReviewSelection(response.result.suggestions),
			);
			setGenerationState("ready");
		} catch (error) {
			if (!activeRequest.controller.signal.aborted) {
				setGenerationState("error");
				setApplyError(
					error instanceof Error
						? error.message
						: "Inbox suggestions could not be prepared.",
				);
			}
		} finally {
			requestsRef.current.finish(activeRequest);
		}
	}, [mailboxId, open, suggestionsMutation]);

	useEffect(() => {
		if (open && generationState === "idle") void loadSuggestions();
	}, [generationState, loadSuggestions, open]);

	useEffect(() => {
		if (previousSnapshotKeyRef.current === currentSnapshotKey) return;
		previousSnapshotKeyRef.current = currentSnapshotKey;
		if (open && generationState === "loading") {
			requestsRef.current.cancel();
			setGenerationState("stale");
		}
	}, [currentSnapshotKey, generationState, open]);

	useEffect(
		() => () => {
			requestsRef.current.cancel();
		},
		[],
	);

	const refresh = () => {
		requestsRef.current.cancel();
		suggestionsMutation.reset();
		setResponseSnapshot(null);
		setResponseFingerprint(null);
		setSuggestions([]);
		setSelectedSuggestionIds(new Set());
		setFailedSuggestionIds(new Set());
		setFeedback(null);
		setApplyError(null);
		setNeedsRefreshAfterApply(false);
		setGenerationState("idle");
	};

	const dismiss = (candidateId: string) => {
		setSuggestions((current) =>
			current.filter((suggestion) => suggestion.candidateId !== candidateId),
		);
		setSelectedSuggestionIds((current) => {
			const next = new Set(current);
			next.delete(candidateId);
			return next;
		});
		setFailedSuggestionIds((current) => {
			const next = new Set(current);
			next.delete(candidateId);
			return next;
		});
	};

	const apply = async (action: InboxTriageSuggestionAction) => {
		if (!responseSnapshot || stale || applyingAction) return;
		const plan = planInboxTriageApply({
			action,
			suggestions,
			selectedSuggestionIds,
			responseSnapshot,
			currentSnapshot: snapshotRef.current,
		});
		if (plan.state === "stale") {
			setGenerationState("stale");
			return;
		}
		if (plan.state === "empty") return;
		setApplyingAction(action);
		setApplyError(null);
		setFeedback(null);
		try {
			const result = await batchTriage.mutateAsync({ mailboxId, command: plan.command });
			const reconciled = reconcileInboxTriageApplyResult({
				action,
				suggestions,
				selectedSuggestionIds,
				result,
			});
			setSuggestions(reconciled.suggestions);
			setSelectedSuggestionIds(reconciled.selectedSuggestionIds);
			setFailedSuggestionIds(reconciled.failedSuggestionIds);
			if (result.succeededCount > 0) setNeedsRefreshAfterApply(true);
			setFeedback(
				result.failedCount > 0
					? `${result.succeededCount} updated; ${result.failedCount} could not be changed.`
					: `${result.succeededCount} conversation${result.succeededCount === 1 ? "" : "s"} updated.`,
			);
		} catch {
			setApplyError(
				"The reviewed action could not be confirmed. Inbox remains available; retry the same group.",
			);
		} finally {
			setApplyingAction(null);
		}
	};

	const changeOpen = (next: boolean) => {
		if (!next && applyingAction) return;
		if (!next && generationState === "loading") {
			requestsRef.current.cancel();
			setGenerationState("idle");
		}
		onOpenChange(next);
	};

	const openEvidence = (messageId: string) => {
		changeOpen(false);
		onOpenEvidence(messageId);
	};

	const archiveSuggestions = suggestions.filter(
		(suggestion) => suggestion.action === "archive",
	);
	const readSuggestions = suggestions.filter(
		(suggestion) => suggestion.action === "mark_read",
	);
	const selectedArchiveCount = archiveSuggestions.filter((suggestion) =>
		selectedSuggestionIds.has(suggestion.candidateId),
	).length;
	const selectedReadCount = readSuggestions.filter((suggestion) =>
		selectedSuggestionIds.has(suggestion.candidateId),
	).length;
	const actionsDisabled =
		stale || needsRefreshAfterApply || applyingAction !== null;
	const reviewGroups = (
		<>
			<SuggestionGroup
				action="archive"
				suggestions={archiveSuggestions}
				rows={rows}
				selectedIds={selectedSuggestionIds}
				failedIds={failedSuggestionIds}
				disabled={actionsDisabled}
				onToggle={(candidateId) =>
					setSelectedSuggestionIds((current) =>
						toggleInboxTriageReviewSelection(current, candidateId),
					)
				}
				onDismiss={dismiss}
				onOpenEvidence={openEvidence}
			/>
			<SuggestionGroup
				action="mark_read"
				suggestions={readSuggestions}
				rows={rows}
				selectedIds={selectedSuggestionIds}
				failedIds={failedSuggestionIds}
				disabled={actionsDisabled}
				onToggle={(candidateId) =>
					setSelectedSuggestionIds((current) =>
						toggleInboxTriageReviewSelection(current, candidateId),
					)
				}
				onDismiss={dismiss}
				onOpenEvidence={openEvidence}
			/>
		</>
	);

	return (
		<Dialog.Root open={open} onOpenChange={changeOpen}>
			<Dialog
				size="lg"
				className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[700px] flex-col overflow-hidden p-0"
			>
				<header className="shrink-0 border-b border-kumo-line px-4 py-4 sm:px-5">
					<div className="flex items-start gap-3">
						<SparkleIcon size={19} className="mt-0.5 shrink-0 text-kumo-brand" aria-hidden="true" />
						<div className="min-w-0">
							<Dialog.Title className="text-lg font-semibold text-kumo-default">
								Review Inbox suggestions
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-sm leading-6 text-kumo-subtle">
								Nothing changes until you apply a reviewed action.
							</Dialog.Description>
						</div>
					</div>
					{isSharedMailbox && (
						<p className="mt-3 rounded-md bg-kumo-recessed px-3 py-2.5 text-sm leading-5 text-kumo-strong">
							Read and archive actions affect this mailbox for everyone with access.
						</p>
					)}
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto" aria-live="polite">
					{generationState === "loading" ? (
						<div role="status" className="flex min-h-60 flex-col items-center justify-center gap-3 px-5 py-10 text-center text-sm text-kumo-subtle">
							<Loader size="lg" />
							Reviewing the conversations visible on this page…
						</div>
					) : generationState === "error" ? (
						<div role="alert" className="px-4 py-8 sm:px-5">
							<p className="font-medium text-kumo-default">Inbox suggestions could not be prepared.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">{applyError} Manual Inbox actions remain fully available.</p>
							<Button className="mt-4 min-h-11" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={refresh}>
								Try again
							</Button>
						</div>
					) : generationState === "budget_paused" ? (
						<div role="status" className="px-4 py-8 sm:px-5">
							<p className="font-medium text-kumo-default">Suggestions are paused by the team’s budget controls.</p>
							<p className="mt-1 text-sm leading-6 text-kumo-subtle">No mail was changed. Manual Inbox actions remain fully available.</p>
						</div>
					) : stale ? (
						<>
							<div role="status" className="px-4 py-8 sm:px-5">
								<p className="font-medium text-kumo-default">Inbox changed while you were reviewing. No suggestion was applied.</p>
								<p className="mt-1 text-sm leading-6 text-kumo-subtle">Refresh suggestions to review the current visible page.</p>
								<Button className="mt-4 min-h-11" variant="secondary" icon={<ArrowClockwiseIcon size={16} />} onClick={refresh}>
									Refresh suggestions
								</Button>
							</div>
							{suggestions.length > 0 && reviewGroups}
						</>
					) : needsRefreshAfterApply ? (
						<>
							<div role="status" className="px-4 py-8 sm:px-5">
								<p className="font-medium text-kumo-default">
									Inbox updated after your reviewed action.
								</p>
								<p className="mt-1 text-sm leading-6 text-kumo-subtle">
									{feedback} Refresh suggestions before applying another action.
								</p>
								<Button
									className="mt-4 min-h-11"
									variant="secondary"
									icon={<ArrowClockwiseIcon size={16} />}
									onClick={refresh}
								>
									Refresh suggestions
								</Button>
							</div>
							{suggestions.length > 0 && reviewGroups}
						</>
					) : generationState === "ready" && suggestions.length === 0 ? (
						<div role="status" className="flex min-h-60 flex-col items-center justify-center px-5 py-10 text-center">
							<p className="font-medium text-kumo-default">No suggestions for this page.</p>
							<p className="mt-1 max-w-sm text-sm leading-6 text-kumo-subtle">The review did not find a strong Archive or Mark read recommendation. Manual actions remain available.</p>
						</div>
					) : generationState === "ready" ? (
						<>
							{feedback && <p role="status" className="border-b border-kumo-line bg-kumo-recessed px-4 py-3 text-sm text-kumo-strong sm:px-5">{feedback}</p>}
							{applyError && <p role="alert" className="border-b border-kumo-line bg-kumo-danger/10 px-4 py-3 text-sm text-kumo-danger sm:px-5">{applyError}</p>}
							{reviewGroups}
						</>
					) : null}
				</div>

				<footer className="flex shrink-0 flex-col-reverse gap-2 border-t border-kumo-line bg-kumo-base px-4 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-5">
					<Button variant="secondary" className="min-h-11 w-full sm:w-auto" onClick={() => changeOpen(false)} disabled={applyingAction !== null}>
						Close
					</Button>
					{generationState === "ready" &&
						!stale &&
						!needsRefreshAfterApply &&
						archiveSuggestions.length > 0 && (
						<Button
							className="min-h-11 w-full sm:w-auto"
							icon={<ArchiveIcon size={16} />}
							loading={applyingAction === "archive"}
							disabled={actionsDisabled || selectedArchiveCount === 0}
							onClick={() => void apply("archive")}
						>
							Apply {selectedArchiveCount} archive suggestion{selectedArchiveCount === 1 ? "" : "s"}
						</Button>
					)}
					{generationState === "ready" &&
						!stale &&
						!needsRefreshAfterApply &&
						readSuggestions.length > 0 && (
						<Button
							className="min-h-11 w-full sm:w-auto"
							icon={<EnvelopeOpenIcon size={16} />}
							loading={applyingAction === "mark_read"}
							disabled={actionsDisabled || selectedReadCount === 0}
							onClick={() => void apply("mark_read")}
						>
							Mark {selectedReadCount} conversation{selectedReadCount === 1 ? "" : "s"} read
						</Button>
					)}
				</footer>
			</Dialog>
		</Dialog.Root>
	);
}
