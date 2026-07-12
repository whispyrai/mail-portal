import { Button } from "@cloudflare/kumo";
import { SparkleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useBrand } from "~/hooks/useBrand";
import { useAiDraftCompose } from "~/queries/emails";
import { assistantCopyFor } from "~/utils/assistant-copy";
import { planComposeShortcut } from "~/lib/compose-shortcuts";
import {
	extractAiAuthoredContent,
	hasAiAuthoredContent,
	hasComposeSignature,
} from "~/lib/compose-signature";
import {
	AI_DRAFTING_LIMITS,
	validateAiComposeDraftRequest,
} from "../../shared/ai-drafting";

type ComposeAiAssistantProps = {
	originMailboxId?: string;
	subject: string;
	body: string;
	setSubject(value: string): void;
	applyAiBody(value: string): void;
	onActivityLabelChange(value: string): void;
	onClose(): void;
};

const QUICK_REFINEMENTS = [
	["Polish", "Polish this draft while preserving its meaning."],
	["Shorter", "Make this draft shorter and more concise."],
	["More formal", "Make this draft more formal."],
	["Friendlier", "Make this draft friendlier and warmer."],
] as const;

export default function ComposeAiAssistant({
	originMailboxId,
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
	const [prompt, setPrompt] = useState("");
	const [panelError, setPanelError] = useState<string | null>(null);
	const requestPendingRef = useRef(false);
	const editableSnapshotRef = useRef({ subject, body });
	editableSnapshotRef.current = { subject, body };
	const authoredBody = extractAiAuthoredContent(body);
	const hasDraftContext =
		subject.trim().length > 0 || hasAiAuthoredContent(body);
	const actionLabel = hasDraftContext ? "Refine" : "Generate";

	useEffect(() => {
		onActivityLabelChange(
			aiCompose.isPending
				? hasDraftContext
					? "Refining draft"
					: "Generating draft"
				: "",
		);
		return () => onActivityLabelChange("");
	}, [aiCompose.isPending, hasDraftContext, onActivityLabelChange]);

	const generate = async (instruction = prompt) => {
		const nextPrompt = instruction.trim();
		if (!originMailboxId || !nextPrompt || requestPendingRef.current) return;
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
		if (requestPendingRef.current || aiCompose.isPending) return;
		aiCompose.reset();
		setPanelError(null);
		setPrompt("");
		onClose();
	};

	return (
		<div
			data-compose-shortcut-surface="ai-panel"
			aria-busy={aiCompose.isPending}
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
							? "Tell it what to improve in your current draft."
							: "Describe the email you want to write."}
					</label>
				</div>
				<button
					type="button"
					aria-label="Close writing assistant"
					disabled={aiCompose.isPending}
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
							disabled={aiCompose.isPending}
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
				disabled={aiCompose.isPending}
				maxLength={AI_DRAFTING_LIMITS.promptChars}
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
					loading={aiCompose.isPending}
					disabled={!prompt.trim() || aiCompose.isPending}
					icon={<SparkleIcon size={14} weight="fill" />}
					onClick={() => void generate()}
				>
					{aiCompose.isPending ? `${actionLabel}…` : actionLabel}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="min-h-11"
					disabled={aiCompose.isPending}
					onClick={() => setPrompt("")}
				>
					Clear
				</Button>
				{(panelError || aiCompose.isError) && (
					<span
						role="alert"
						className="min-w-0 break-words text-xs text-kumo-danger sm:ml-1"
					>
						{panelError ||
							(aiCompose.error as Error)?.message ||
							"The writing assistant could not update this draft. Your content is unchanged."}
					</span>
				)}
			</div>
		</div>
	);
}
