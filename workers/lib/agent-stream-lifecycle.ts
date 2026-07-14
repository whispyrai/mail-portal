export type AgentStreamTermination =
	| { kind: "done" }
	| { kind: "error"; error: unknown }
	| { kind: "cancel"; reason: unknown };

export function isTerminalAgentStreamFailure(input: {
	finishReason: string | undefined;
	streamError: unknown;
	totalUsage: { inputTokens?: number; outputTokens?: number };
}): boolean {
	if (input.finishReason === "error") return true;
	return (
		input.streamError !== undefined &&
		input.totalUsage.inputTokens === undefined &&
		input.totalUsage.outputTokens === undefined
	);
}

export function trackAgentStreamResponse(
	response: Response,
	abortSignal: AbortSignal,
	onTerminate: (termination: AgentStreamTermination) => void,
): Response {
	if (!response.body) {
		onTerminate({ kind: "done" });
		return response;
	}

	const reader = response.body.getReader();
	let terminated = false;
	let readerReleased = false;
	let outputController: ReadableStreamDefaultController<Uint8Array> | undefined;
	let outputClosed = false;
	const releaseReader = () => {
		if (readerReleased) return;
		readerReleased = true;
		reader.releaseLock();
	};
	const markTerminated = (termination: AgentStreamTermination) => {
		if (terminated) return;
		terminated = true;
		abortSignal.removeEventListener("abort", abort);
		onTerminate(termination);
	};
	const closeOutput = () => {
		if (outputClosed) return;
		outputClosed = true;
		outputController?.close();
	};
	const abort = () => {
		const reason = abortSignal.reason;
		try {
			markTerminated({ kind: "cancel", reason });
		} finally {
			closeOutput();
			void reader.cancel(reason).catch(() => undefined).finally(releaseReader);
		}
	};
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			outputController = controller;
			if (abortSignal.aborted) abort();
			else abortSignal.addEventListener("abort", abort, { once: true });
		},
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (terminated) return;
				if (done) {
					try {
						markTerminated({ kind: "done" });
					} finally {
						releaseReader();
						closeOutput();
					}
					return;
				}
				controller.enqueue(value);
			} catch (error) {
				if (terminated) return;
				markTerminated({ kind: "error", error });
				releaseReader();
				outputClosed = true;
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				markTerminated({ kind: "cancel", reason });
				await reader.cancel(reason);
			} finally {
				releaseReader();
			}
		},
	});

	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

/** Coordinates one durable terminal transition, retrying a transient store failure once. */
export class AgentUsageSettlement {
	#settled = false;
	#inFlight: Promise<void> | null = null;

	get settled(): boolean {
		return this.#settled;
	}

	settle(operation: () => Promise<unknown>): Promise<void> {
		if (this.#settled) return Promise.resolve();
		if (this.#inFlight) return this.#inFlight;

		const attempt = async () => {
			let firstError: unknown;
			for (let index = 0; index < 2; index += 1) {
				try {
					await operation();
					return;
				} catch (error) {
					firstError ??= error;
				}
			}
			throw firstError;
		};
		let tracked!: Promise<void>;
		tracked = attempt()
			.then(() => {
				this.#settled = true;
			})
			.finally(() => {
				if (this.#inFlight === tracked) this.#inFlight = null;
			});
		this.#inFlight = tracked;
		return tracked;
	}
}
