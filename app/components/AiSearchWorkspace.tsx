import { Badge, Button, Input, Loader } from "@cloudflare/kumo";
import { SparkleIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	AI_SEARCH_INTERPRETER_LIMITS,
	parseAiSearchInterpreterRequest,
	type AiSearchInterpreterReadyResponse,
} from "../../shared/ai-search-interpreter.ts";
import LabelChip from "./labels/LabelChip";
import {
	createAiSearchInterpreterRequestController,
	type AiSearchInterpreterSnapshot,
} from "../lib/ai-search-interpreter-controller.ts";
import {
	searchFilterSummary,
	validateAiSearchReview,
} from "../lib/ai-search-review.ts";
import { useAiSearchInterpreter } from "../queries/ai-search-interpreter.ts";
import type { Label } from "../types/index.ts";

type WorkspaceState =
	| "idle"
	| "loading"
	| "ready"
	| "ambiguous"
	| "unsupported"
	| "budget_paused"
	| "stale"
	| "intent_stale"
	| "cancelled"
	| "error";

const statusCopy: Partial<Record<WorkspaceState, string>> = {
	ambiguous:
		"That request could mean more than one ordinary search. Add a person, date, folder, or exact wording and interpret it again.",
	unsupported:
		"That request needs capabilities ordinary mail filters do not support. Try people, words, folders, labels, states, attachments, or dates.",
	budget_paused:
		"AI search is paused for budget review. Ordinary search remains available in the header.",
	stale:
		"Mailbox filters changed while this request was being interpreted. Interpret it again.",
	intent_stale:
		"Your request changed. Interpret it again before running search.",
	cancelled: "Interpretation cancelled. No search was run.",
};

export type AiSearchWorkspaceProps = {
	mailboxId: string;
	initialIntent: string;
	labels: Label[];
	labelCatalogState: "loading" | "ready" | "error";
	onRetryLabels(): void;
	onRun(query: string, labelId: string | null): void;
};

export default function AiSearchWorkspace({
	mailboxId,
	initialIntent,
	labels,
	labelCatalogState,
	onRetryLabels,
	onRun,
}: AiSearchWorkspaceProps) {
	const timezone = useMemo(
		() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		[],
	);
	const mutation = useAiSearchInterpreter();
	const requestsRef = useRef(createAiSearchInterpreterRequestController());
	const snapshotRef = useRef<AiSearchInterpreterSnapshot>({
		mailboxId,
		intent: initialIntent,
		timezone,
	});
	const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
	const canonicalInputRef = useRef<HTMLInputElement>(null);
	const [intent, setIntent] = useState(initialIntent);
	const [review, setReview] = useState<AiSearchInterpreterReadyResponse | null>(null);
	const [reviewedIntent, setReviewedIntent] = useState<string | null>(null);
	const [canonicalQuery, setCanonicalQuery] = useState("");
	const [reviewLabelId, setReviewLabelId] = useState<string | null>(null);
	const [state, setState] = useState<WorkspaceState>("idle");
	const [error, setError] = useState<string | null>(null);

	const reset = (nextIntent: string) => {
		requestsRef.current.cancel();
		mutation.reset();
		setIntent(nextIntent);
		setReview(null);
		setReviewedIntent(null);
		setCanonicalQuery("");
		setReviewLabelId(null);
		setState("idle");
		setError(null);
	};

	useEffect(() => {
		reset(initialIntent);
		return () => requestsRef.current.cancel();
		// Reset is intentionally scoped to the route-owned Mailbox and header seed.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mailboxId, initialIntent]);

	snapshotRef.current = { mailboxId, intent, timezone };
	const authorizedLabelIds = useMemo(
		() => labels.map((label) => label.id),
		[labels],
	);
	const validation = useMemo(
		() => validateAiSearchReview(canonicalQuery, reviewLabelId, authorizedLabelIds),
		[authorizedLabelIds, canonicalQuery, reviewLabelId],
	);
	const summary = useMemo(() => {
		if (!review || !validation.ok || !canonicalQuery.trim()) return [];
		return searchFilterSummary(canonicalQuery);
	}, [canonicalQuery, review, validation]);
	const selectedLabel = labels.find((label) => label.id === reviewLabelId);
	const intentIsStale = Boolean(reviewedIntent && reviewedIntent !== intent);
	const canRun = Boolean(
		review &&
		state === "ready" &&
		labelCatalogState === "ready" &&
		!intentIsStale &&
		validation.ok,
	);

	const changeIntent = (value: string) => {
		if (state === "loading") {
			requestsRef.current.cancel();
			mutation.reset();
		}
		setIntent(value);
		setError(null);
		if (review) setState(value === reviewedIntent ? "ready" : "intent_stale");
		else if (state !== "idle") setState("idle");
	};

	const interpret = async () => {
		if (labelCatalogState !== "ready") return;
		let request: { intent: string; timezone: string };
		try {
			request = parseAiSearchInterpreterRequest({ intent, timezone });
		} catch (requestError) {
			setState("error");
			setError(
				requestError instanceof Error
					? requestError.message
					: "Enter a request to interpret.",
			);
			return;
		}
		setIntent(request.intent);
		const snapshot = { mailboxId, ...request };
		snapshotRef.current = snapshot;
		const active = requestsRef.current.begin(snapshot);
		if (!active) return;
		mutation.reset();
		setState("loading");
		setError(null);
		try {
			const response = await mutation.mutateAsync({
				mailboxId,
				request,
				signal: active.controller.signal,
				requestToken: active.requestToken,
			});
			if (!requestsRef.current.isCurrent(active, snapshotRef.current)) return;
			if (response.state === "generated" || response.state === "cached") {
				if (response.labelId && !authorizedLabelIds.includes(response.labelId)) {
					setState("stale");
					setReview(null);
					return;
				}
				setReview(response);
				setReviewedIntent(request.intent);
				setCanonicalQuery(response.query);
				setReviewLabelId(response.labelId);
				setState("ready");
				requestAnimationFrame(() => reviewHeadingRef.current?.focus());
				return;
			}
			setReview(null);
			setReviewedIntent(null);
			setState(response.state);
		} catch (requestError) {
			if (!active.controller.signal.aborted) {
				setState("error");
				setError(
					requestError instanceof Error
						? requestError.message
						: "AI search is temporarily unavailable.",
				);
			}
		} finally {
			requestsRef.current.finish(active);
		}
	};

	const cancel = () => {
		requestsRef.current.cancel();
		mutation.reset();
		setState("cancelled");
		setError(null);
	};

	const run = () => {
		if (!canRun || !validation.ok) {
			canonicalInputRef.current?.focus();
			return;
		}
		onRun(validation.parsed.query, reviewLabelId);
	};

	return (
		<section
			className="border-b border-kumo-line bg-kumo-recessed px-4 py-4 md:px-5"
			aria-labelledby="ai-search-heading"
			aria-describedby="ai-search-description"
		>
			<div className="mx-auto max-w-3xl">
				<div className="flex items-start gap-2.5">
					<SparkleIcon size={20} className="mt-0.5 shrink-0 text-kumo-brand" aria-hidden="true" />
					<div>
						<h2 id="ai-search-heading" className="font-semibold text-kumo-default">
							AI search
						</h2>
						<p id="ai-search-description" className="mt-0.5 text-sm leading-5 text-kumo-subtle">
							Describe what to find. The assistant translates your words into ordinary filters and does not read mail while interpreting.
						</p>
					</div>
				</div>

				<form
					className="mt-4"
					onSubmit={(event) => {
						event.preventDefault();
						void interpret();
					}}
					aria-label="Interpret an AI mail search"
				>
					<label htmlFor="ai-search-intent" className="text-sm font-medium text-kumo-default">
						What mail are you looking for?
					</label>
					<textarea
						id="ai-search-intent"
						className="mt-1.5 min-h-24 w-full resize-y rounded-md border border-kumo-line bg-kumo-base px-3 py-2 text-base leading-6 text-kumo-default outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						value={intent}
						onChange={(event) => changeIntent(event.target.value)}
						maxLength={AI_SEARCH_INTERPRETER_LIMITS.intentChars}
						aria-describedby="ai-search-intent-help ai-search-status"
						placeholder="For example: unread renewal emails from Alice since July 1"
					/>
					<p id="ai-search-intent-help" className="mt-1 text-xs leading-5 text-kumo-subtle">
						Nothing runs until you review the filters and choose Run search.
					</p>
					<div className="mt-3 flex flex-wrap gap-2">
						<Button
							type="submit"
							className="min-h-11"
							disabled={
								state === "loading" ||
								!intent.trim() ||
								labelCatalogState !== "ready"
							}
						>
							{state === "loading" ? "Interpreting…" : review ? "Interpret again" : "Interpret"}
						</Button>
						{state === "loading" && (
							<Button type="button" variant="secondary" className="min-h-11" onClick={cancel}>
								Cancel
							</Button>
						)}
					</div>
				</form>

				<div id="ai-search-status" className="mt-3 min-h-5 text-sm text-kumo-subtle" aria-live="polite">
					{labelCatalogState === "loading" ? (
						<span className="inline-flex items-center gap-2" role="status">
							<Loader size="sm" /> Loading mailbox filters…
						</span>
					) : labelCatalogState === "error" ? (
						<span role="alert">
							Mailbox filters are unavailable. Ordinary search still works.{" "}
							<button
								type="button"
								onClick={onRetryLabels}
								className="min-h-11 rounded px-2 font-medium text-kumo-brand underline underline-offset-2"
							>
								Try again
							</button>
						</span>
					) : state === "loading" ? (
						<span className="inline-flex items-center gap-2" role="status">
							<Loader size="sm" /> Interpreting your request — no search has run.
						</span>
					) : error ? (
						<span role="alert" className="text-kumo-danger">{error}</span>
					) : statusCopy[state] ? (
						<span role={state === "cancelled" ? "status" : "alert"}>{statusCopy[state]}</span>
					) : state === "ready" ? (
						"Review the ordinary filters below. No search has run yet."
					) : null}
				</div>

				{review && (
					<div className="mt-4 rounded-lg border border-kumo-line bg-kumo-base p-4">
						<h3
							ref={reviewHeadingRef}
							tabIndex={-1}
							className="font-semibold text-kumo-default outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
						>
							Review ordinary search filters
						</h3>
						<p className="mt-1 text-sm leading-5 text-kumo-subtle">
							Filter groups combine with AND. Multiple values inside From, To, Subject, Filename, or Folder match any shown value (OR).
						</p>
						<div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
							<Input
								ref={canonicalInputRef}
								label="Canonical search"
								value={canonicalQuery}
								onChange={(event) => {
									setCanonicalQuery(event.target.value);
								}}
								maxLength={500}
								aria-describedby="canonical-search-help canonical-search-error"
							/>
							<label className="text-sm font-medium text-kumo-default">
								Mailbox label
								<select
									className="mt-1.5 min-h-11 w-full rounded-md border border-kumo-line bg-kumo-base px-3 text-sm text-kumo-default"
									value={reviewLabelId ?? ""}
									onChange={(event) => {
										setReviewLabelId(event.target.value || null);
									}}
								>
									<option value="">All labels</option>
									{labels.map((label) => (
										<option key={label.id} value={label.id}>{label.name}</option>
									))}
								</select>
							</label>
						</div>
						<p id="canonical-search-help" className="mt-1 text-xs leading-5 text-kumo-subtle">
							You can edit this strict Search v2 query without calling AI again.
						</p>
						{!validation.ok && (
							<p id="canonical-search-error" role="alert" className="mt-2 text-sm text-kumo-danger">
								{validation.error}
							</p>
						)}
						{selectedLabel && <div className="mt-3"><LabelChip label={selectedLabel} /></div>}

						{summary.length > 0 && (
							<dl className="mt-4 space-y-2" aria-label="Reviewed search filters">
								{summary.map((group) => (
									<div key={group.label} className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start">
										<dt className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{group.label}</dt>
										<dd className="flex min-w-0 flex-wrap gap-1.5">
											{group.values.map((value) => <Badge key={value} variant="outline">{value}</Badge>)}
											{group.values.length > 1 && <span className="sr-only">Values use {group.mode === "any" ? "OR" : "AND"}.</span>}
										</dd>
									</div>
								))}
							</dl>
						)}

						<div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-kumo-line pt-4">
							<Button type="button" variant="secondary" className="min-h-11" onClick={() => canonicalInputRef.current?.focus()}>
								Edit filters
							</Button>
							<Button type="button" className="min-h-11" disabled={!canRun} onClick={run}>
								Run search
							</Button>
						</div>
					</div>
				)}
			</div>
		</section>
	);
}
