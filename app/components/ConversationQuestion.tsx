import { Badge, Button, Loader } from "@cloudflare/kumo";
import { ArrowRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
	isCurrentConversationAnswerRequest,
	useConversationAnswer,
} from "~/queries/conversation-answer";
import type { ConversationAnswerResponse } from "~/services/conversation-answer";
import { createConversationQuestionRequestController } from "~/lib/conversation-question-controller";

const QUESTION_LIMIT = 500;

type AnswerView =
	| { state: "idle" }
	| { state: "loading" }
	| { state: "error"; message: string }
	| {
			state: "response";
			question: string;
			response: ConversationAnswerResponse;
	  };

function focusCitedMessage(
	messageId: string,
	onFocusMessage: (messageId: string) => void,
) {
	onFocusMessage(messageId);
	requestAnimationFrame(() => {
		const target = document.querySelector<HTMLElement>(
			`[data-intelligence-message-id="${CSS.escape(messageId)}"]`,
		);
		target?.focus({ preventScroll: true });
		target?.scrollIntoView({ behavior: "smooth", block: "center" });
	});
}

export default function ConversationQuestion({
	mailboxId,
	emailId,
	onFocusMessage,
}: {
	mailboxId: string;
	emailId: string;
	onFocusMessage: (messageId: string) => void;
}) {
	const answer = useConversationAnswer();
	const [question, setQuestion] = useState("");
	const [view, setView] = useState<AnswerView>({ state: "idle" });
	const selectionRef = useRef({ mailboxId, emailId });
	selectionRef.current = { mailboxId, emailId };
	const requestsRef = useRef(createConversationQuestionRequestController());

	useEffect(() => {
		requestsRef.current.cancel();
		setQuestion("");
		setView({ state: "idle" });
		answer.reset();
		return () => {
			requestsRef.current.cancel();
		};
		// The request is intentionally reset whenever the selected mail changes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [mailboxId, emailId]);

	const cancel = () => {
		requestsRef.current.cancel();
		answer.reset();
		setView({ state: "idle" });
	};

	const ask = async () => {
		const normalizedQuestion = question.trim();
		if (!normalizedQuestion || normalizedQuestion.length > QUESTION_LIMIT) {
			return;
		}

		const request = requestsRef.current.begin({ mailboxId, emailId });
		if (!request) return;
		setView({ state: "loading" });

		try {
			const response = await answer.mutateAsync({
				mailboxId,
				emailId,
				question: normalizedQuestion,
				signal: request.controller.signal,
				requestToken: request.requestToken,
			});
			const selection = selectionRef.current;
			if (
				!requestsRef.current.isCurrent(request, selection) ||
				!isCurrentConversationAnswerRequest(
					request,
					selection.mailboxId,
					selection.emailId,
					request.requestToken,
				)
			) {
				return;
			}
			setView({
				state: "response",
				question: normalizedQuestion,
				response,
			});
		} catch (error) {
			const selection = selectionRef.current;
			if (
				request.controller.signal.aborted ||
				!requestsRef.current.isCurrent(request, selection) ||
				!isCurrentConversationAnswerRequest(
					request,
					selection.mailboxId,
					selection.emailId,
					request.requestToken,
				)
			) {
				return;
			}
			setView({
				state: "error",
				message:
					error instanceof Error
						? error.message
						: "This conversation could not be answered.",
			});
		} finally {
			requestsRef.current.finish(request);
		}
	};

	const submit = (event: FormEvent) => {
		event.preventDefault();
		void ask();
	};
	const response = view.state === "response" ? view.response : null;
	const answeredQuestion = view.state === "response" ? view.question : null;
	const answered =
		response &&
		(response.state === "cached" || response.state === "generated") &&
		response.result.state === "answered"
			? response.result
			: null;

	return (
		<section
			className="border-t border-kumo-line px-4 py-5 sm:px-5"
			aria-labelledby="conversation-question-heading"
		>
			<div className="flex flex-wrap items-center gap-2">
				<h3
					id="conversation-question-heading"
					className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle"
				>
					Ask this conversation
				</h3>
				{response?.state === "cached" && (
					<Badge variant="outline">Cached</Badge>
				)}
				{response?.state === "generated" && (
					<Badge variant="outline">Generated</Badge>
				)}
			</div>
			<p className="mt-1 text-sm leading-5 text-kumo-subtle">
				Ask one question. Results quote only evidence found in this
				conversation.
			</p>

			<form onSubmit={submit} className="mt-3 space-y-2">
				<label
					htmlFor="conversation-question"
					className="text-sm font-medium text-kumo-default"
				>
					Question
				</label>
				<textarea
					id="conversation-question"
					value={question}
					maxLength={QUESTION_LIMIT}
					rows={2}
					disabled={view.state === "loading"}
					aria-describedby="conversation-question-help conversation-question-count"
					onChange={(event) => setQuestion(event.target.value)}
					onKeyDown={(event) => {
						if (
							event.key === "Enter" &&
							(event.metaKey || event.ctrlKey) &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							void ask();
						}
					}}
					placeholder="For example: What did we agree to send next?"
					className="w-full resize-y rounded border border-kumo-line bg-white px-3 py-2 text-sm text-kumo-default placeholder:text-kumo-placeholder focus:outline-none focus:ring-2 focus:ring-kumo-focus disabled:opacity-60"
				/>
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span
						id="conversation-question-help"
						className="text-xs text-kumo-subtle"
					>
						Press Ctrl or Command and Enter to ask.
					</span>
					<span
						id="conversation-question-count"
						className="text-xs tabular-nums text-kumo-subtle"
					>
						{question.length}/{QUESTION_LIMIT}
					</span>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="submit"
						variant="primary"
						size="sm"
						className="min-h-11"
						disabled={!question.trim() || view.state === "loading"}
						icon={<ArrowRightIcon size={14} />}
					>
						Ask
					</Button>
					{view.state === "loading" && (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="min-h-11"
							onClick={cancel}
						>
							Cancel
						</Button>
					)}
				</div>
			</form>

			<div className="mt-4">
				{answeredQuestion && (
					<p className="mb-2 text-xs font-medium text-kumo-subtle">
						Question: “{answeredQuestion}”
					</p>
				)}
				{view.state === "loading" && (
					<div
						role="status"
						className="flex items-center gap-2 text-sm text-kumo-subtle"
					>
						<Loader size="sm" />
						Looking through this conversation…
					</div>
				)}
				{view.state === "error" && (
					<div role="alert" className="space-y-2 text-sm">
						<p className="font-medium text-kumo-danger">{view.message}</p>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="min-h-11"
							onClick={() => void ask()}
						>
							Try again
						</Button>
					</div>
				)}
				{response?.state === "budget_paused" && (
					<div role="status" className="text-sm leading-5 text-kumo-subtle">
						Answers are paused by the team’s AI budget controls. Mail remains
						fully available.
					</div>
				)}
				{response?.state === "stale" && (
					<div role="alert" className="space-y-2 text-sm">
						<p className="text-kumo-default">
							This conversation changed while the answer was being prepared. The
							outdated answer was not shown.
						</p>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							className="min-h-11"
							onClick={() => void ask()}
						>
							Ask again
						</Button>
					</div>
				)}
				{response &&
					(response.state === "cached" || response.state === "generated") &&
					response.result.state === "insufficient_evidence" && (
						<p role="status" className="text-sm leading-5 text-kumo-subtle">
							The available mail does not contain enough evidence to answer this
							question.
						</p>
				)}
				{answered && (
					<div role="status" aria-live="polite">
						<p className="mb-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">
							Relevant quoted evidence
						</p>
						<ol className="space-y-4">
							{answered.claims.map((claim, claimIndex) => (
								<li
									key={`${claim.messageIds.join("-")}-${claimIndex}`}
									className="text-sm leading-6 text-kumo-default"
								>
									<blockquote className="border-l-2 border-kumo-line pl-3">
										{claim.text}
									</blockquote>
									<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
										<span className="text-xs font-medium text-kumo-subtle">
											Sources
										</span>
										{claim.messageIds.map((messageId, citationIndex) => (
											<button
												key={messageId}
												type="button"
												onClick={() =>
													focusCitedMessage(messageId, onFocusMessage)
												}
												className="min-h-8 rounded px-1.5 text-xs font-semibold text-kumo-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
												aria-label={`Focus source message ${citationIndex + 1} for claim ${claimIndex + 1}`}
											>
												Source {citationIndex + 1}
											</button>
										))}
									</div>
								</li>
							))}
						</ol>
					</div>
				)}
			</div>
		</section>
	);
}
