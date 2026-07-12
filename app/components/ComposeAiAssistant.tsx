import { Button } from "@cloudflare/kumo";
import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useBrand } from "~/hooks/useBrand";
import { useAiDraftCompose } from "~/queries/emails";
import { useReplyRefinement } from "~/queries/reply-refinement";
import { assistantCopyFor } from "~/utils/assistant-copy";
import { planComposeShortcut } from "~/lib/compose-shortcuts";
import {
	createReplyRefinementRequestController,
	type ReplyRefinementSnapshot,
} from "~/lib/reply-refinement-controller";
import {
	extractAiAuthoredContent,
	hasAiAuthoredContent,
	hasComposeSignature,
} from "~/lib/compose-signature";
import {
	AI_DRAFTING_LIMITS,
	validateAiComposeDraftRequest,
} from "../../shared/ai-drafting";
import {
	parseReplyRefinementRequest,
	REPLY_REFINEMENT_LIMITS,
	type ReplyRefinementMode,
} from "../../shared/reply-refinement";

type ComposeAiAssistantProps = {
	originMailboxId?: string;
	composeMode: "new" | "reply" | "reply-all" | "forward";
	sourceEmailId?: string;
	subject: string;
	body: string;
	setSubject(value: string): void;
	applyAiBody(value: string): void;
	onActivityLabelChange(value: string): void;
	onClose(): void;
};

type ReplyNotice =
	| "budget_paused"
	| "stale"
	| "review_required"
	| null;

const QUICK_REFINEMENTS = [
	["Polish", "Polish this draft while preserving its meaning."],
	["Shorter", "Make this draft shorter and more concise."],
	["More formal", "Make this draft more formal."],
	["Friendlier", "Make this draft friendlier and warmer."],
] as const;

export default function ComposeAiAssistant({
	originMailboxId,
	composeMode,
	sourceEmailId,
	subject,
	body,
	setSubject,
	applyAiBody,
	onActivityLabelChange,
	onClose,
}: ComposeAiAssistantProps) {
	const { brand, name } = useBrand();
	const assistantCopy = assistantCopyFor(brand, name);
	const aiCompose = useAiDraftCompose();
	const replyRefinement = useReplyRefinement();
	const [prompt, setPrompt] = useState("");
	const [panelError, setPanelError] = useState<string | null>(null);
	const [replyNotice, setReplyNotice] = useState<ReplyNotice>(null);
	const [replyRequestPending, setReplyRequestPending] = useState(false);
	const requestPendingRef = useRef(false);
	const editableSnapshotRef = useRef({ subject, body });
	editableSnapshotRef.current = { subject, body };
	const replyRequestsRef = useRef(createReplyRefinementRequestController());
	const retryInstructionRef = useRef("");
	const replyMode: ReplyRefinementMode | null =
		composeMode === "reply" || composeMode === "reply-all"
			? composeMode
			: null;
	const replySnapshot: ReplyRefinementSnapshot | null =
		replyMode && originMailboxId && sourceEmailId
			? {
					mailboxId: originMailboxId,
					sourceEmailId,
					mode: replyMode,
					subject,
					body,
				}
			: null;
	const replySnapshotRef = useRef<ReplyRefinementSnapshot | null>(replySnapshot);
	replySnapshotRef.current = replySnapshot;
	const authoredBody = extractAiAuthoredContent(body);
	const hasAuthoredBody = hasAiAuthoredContent(body);
	const hasDraftContext = replyMode
		? hasAuthoredBody
		: subject.trim().length > 0 || hasAuthoredBody;
	const actionLabel = hasDraftContext ? "Refine" : "Generate";
	const isPending = replyMode ? replyRequestPending : aiCompose.isPending;
	const mutationError = replyMode
		? replyRefinement.error
		: aiCompose.error;
	const promptLimit = replyMode
		? REPLY_REFINEMENT_LIMITS.promptChars
		: AI_DRAFTING_LIMITS.promptChars;

	useEffect(() => {
		onActivityLabelChange(
			isPending
				? hasDraftContext
					? "Refining draft"
					: "Generating draft"
				: "",
		);
		return () => onActivityLabelChange("");
	}, [hasDraftContext, isPending, onActivityLabelChange]);

	useEffect(
		() => () => {
			replyRequestsRef.current.cancel();
		},
		[],
	);

	const cancelReplyRequest = () => {
		replyRequestsRef.current.cancel();
		replyRefinement.reset();
		setReplyRequestPending(false);
		setReplyNotice(null);
		setPanelError(null);
	};

	const generateReply = async (nextPrompt: string) => {
		if (!replyMode || !replySnapshot) return;
		if (/<img\b/i.test(authoredBody)) {
			setPanelError(
				"Remove inline images before refining this reply so their placement cannot be lost.",
			);
			return;
		}
		const request = {
			mode: replyMode,
			prompt: nextPrompt,
			currentBody: hasAuthoredBody ? authoredBody : undefined,
			preserveSignature: hasComposeSignature(body) || undefined,
		};
		try {
			parseReplyRefinementRequest(request);
		} catch {
			setPanelError(
				"This instruction or reply is too large to refine safely. Shorten it before trying again.",
			);
			return;
		}
		const activeRequest = replyRequestsRef.current.begin(replySnapshot);
		if (!activeRequest) return;
		retryInstructionRef.current = nextPrompt;
		setPanelError(null);
		setReplyNotice(null);
		replyRefinement.reset();
		setReplyRequestPending(true);
		try {
			const response = await replyRefinement.mutateAsync({
				mailboxId: activeRequest.mailboxId,
				sourceEmailId: activeRequest.sourceEmailId,
				request,
				signal: activeRequest.controller.signal,
				requestToken: activeRequest.requestToken,
			});
			const currentSnapshot = replySnapshotRef.current;
			if (
				!currentSnapshot ||
				!replyRequestsRef.current.isCurrent(activeRequest, currentSnapshot)
			) {
				if (!activeRequest.controller.signal.aborted) {
					setPanelError(
						"Your reply changed while the writing assistant was working. Nothing was replaced. Run it again when you are ready.",
					);
				}
				return;
			}
			if (response.state === "budget_paused") {
				setReplyNotice("budget_paused");
				return;
			}
			if (response.state === "stale") {
				setReplyNotice("stale");
				return;
			}
			applyAiBody(response.result.body);
			setReplyNotice("review_required");
			setPrompt("");
		} catch {
			// The mutation owns its safe, user-facing error.
		} finally {
			if (replyRequestsRef.current.finish(activeRequest)) {
				setReplyRequestPending(false);
			}
		}
	};

	const generate = async (instruction = prompt) => {
		const nextPrompt = instruction.trim();
		if (!originMailboxId || !nextPrompt) return;
		if (replyMode) {
			await generateReply(nextPrompt);
			return;
		}
		if (requestPendingRef.current) return;
		if (/<img\b/i.test(authoredBody)) {
			setPanelError(
				"Remove inline images before refining this draft so their placement cannot be lost.",
			);
			return;
		}
		const request = {
			prompt: nextPrompt,
			currentSubject: subject.trim().length > 0 ? subject : undefined,
			currentBody: hasAiAuthoredContent(body) ? authoredBody : undefined,
			preserveSignature: hasComposeSignature(body) || undefined,
		};
		const validation = validateAiComposeDraftRequest(request);
		if (!validation.ok) {
			setPanelError(
				validation.code === "invalid_fields"
					? "This instruction or draft is too long to refine safely."
					: "This draft is too large to refine safely. Shorten it before trying again.",
			);
			return;
		}
		const requestedSnapshot = { subject, body };
		setPanelError(null);
		requestPendingRef.current = true;
		try {
			const draft = await aiCompose.mutateAsync({
				mailboxId: originMailboxId,
				...request,
			});
			if (
				editableSnapshotRef.current.subject !== requestedSnapshot.subject ||
				editableSnapshotRef.current.body !== requestedSnapshot.body
			) {
				setPanelError(
					"Your draft changed while the writing assistant was working. Nothing was replaced. Run it again when you are ready.",
				);
				return;
			}
			if (typeof draft.subject === "string") setSubject(draft.subject);
			if (typeof draft.body === "string") applyAiBody(draft.body);
			setPrompt("");
		} catch {
			// The mutation owns its safe, user-facing error.
		} finally {
			requestPendingRef.current = false;
		}
	};

	const close = () => {
		if (replyMode) {
			cancelReplyRequest();
		} else if (requestPendingRef.current || aiCompose.isPending) {
			return;
		}
		aiCompose.reset();
		setPanelError(null);
		setReplyNotice(null);
		setPrompt("");
		onClose();
	};

	const retry = () => {
		const instruction = retryInstructionRef.current;
		if (instruction) void generate(instruction);
	};

	return (
		<div
			data-compose-shortcut-surface="ai-panel"
			aria-busy={isPending}
			className="space-y-3 rounded-lg border border-kumo-line bg-kumo-recessed p-3"
		>
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="text-sm font-medium text-kumo-default">
						Writing assistant
					</div>
					<label
						htmlFor="ai-compose-prompt"
						className="mt-0.5 block text-xs text-kumo-subtle"
					>
						{hasDraftContext
							? replyMode
								? "Refine only the authored reply body using this conversation."
								: "Tell it what to improve in your current draft."
							: replyMode
								? "Describe the reply you want. The assistant can change only its body."
								: "Describe the email you want to write."}
					</label>
				</div>
				<button
					type="button"
					aria-label="Close writing assistant"
					disabled={!replyMode && aiCompose.isPending}
					onClick={close}
					className="flex min-h-9 min-w-9 items-center justify-center rounded text-kumo-subtle hover:bg-white hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand disabled:opacity-50"
				>
					<XIcon size={15} />
				</button>
			</div>
			{hasDraftContext && (
				<div className="flex flex-wrap gap-1.5" aria-label="Quick refinements">
					{QUICK_REFINEMENTS.map(([label, instruction]) => (
						<Button
							key={label}
							type="button"
							variant="secondary"
							size="sm"
							disabled={isPending}
							onClick={() => void generate(instruction)}
						>
							{label}
						</Button>
					))}
				</div>
			)}
			<textarea
				id="ai-compose-prompt"
				autoFocus
				value={prompt}
				disabled={isPending}
				maxLength={promptLimit}
				onChange={(event) => setPrompt(event.target.value)}
				onKeyDown={(event) => {
					const action = planComposeShortcut({
						key: event.key,
						metaKey: event.metaKey,
						ctrlKey: event.ctrlKey,
						altKey: event.altKey,
						shiftKey: event.shiftKey,
						repeat: event.repeat,
						isImeComposing: event.nativeEvent.isComposing,
						composeActive: true,
						hasBlockingState: false,
						defaultPrevented: event.defaultPrevented,
						origin: "ai-prompt",
					});
					if (action === "ai-generate") {
						event.preventDefault();
						event.stopPropagation();
						void generate();
					}
					if (event.key === "Escape") close();
				}}
				placeholder={
					hasDraftContext
						? "For example: emphasize the next steps and keep it concise"
						: replyMode
							? "For example: confirm Friday and ask for final approval"
							: assistantCopy.composePlaceholder
				}
				rows={2}
				className="w-full resize-y rounded border border-kumo-line bg-white px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:outline-none focus:ring-2 focus:ring-kumo-focus"
			/>
			<div className="flex items-center gap-2">
				<Button
					type="button"
					variant="primary"
					size="sm"
					className="min-h-11"
					loading={isPending}
					disabled={!prompt.trim() || isPending}
					icon={<SparkleIcon size={14} weight="fill" />}
					onClick={() => void generate()}
				>
					{isPending ? `${actionLabel}…` : actionLabel}
				</Button>
				{replyMode && isPending && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="min-h-11"
						onClick={cancelReplyRequest}
					>
						Cancel
					</Button>
				)}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="min-h-11"
					disabled={isPending}
					onClick={() => setPrompt("")}
				>
					Clear
				</Button>
				{(panelError || mutationError) && (
					<span
						role="alert"
						className="min-w-0 break-words text-xs text-kumo-danger sm:ml-1"
					>
						{panelError ||
							(mutationError instanceof Error ? mutationError.message : null) ||
							"The writing assistant could not update this draft. Your content is unchanged."}
					</span>
				)}
			</div>
			{replyMode && mutationError && !isPending && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="min-h-11"
					onClick={retry}
				>
					Try again
				</Button>
			)}
			{replyNotice === "budget_paused" && (
				<p role="status" className="text-xs leading-5 text-kumo-subtle">
					Reply assistance is paused by the team’s AI budget controls. Your
					draft and every manual reply control remain available.
				</p>
			)}
			{replyNotice === "stale" && (
				<div role="alert" className="flex flex-wrap items-center gap-2">
					<span className="text-xs leading-5 text-kumo-default">
						This conversation changed while the reply was being prepared. The
						outdated result was not applied.
					</span>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="min-h-11"
						onClick={retry}
					>
						Try again
					</Button>
				</div>
			)}
			{replyNotice === "review_required" && (
				<p role="status" className="text-xs leading-5 text-kumo-default">
					AI can make factual mistakes. You must review every fact and
					commitment before sending.
				</p>
			)}
		</div>
	);
}
