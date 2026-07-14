const clientAbortError = () => new DOMException("Agent request cancelled", "AbortError");
const revocationAbortError = () => new DOMException("Mail access revoked", "AbortError");

type ActiveRun = {
	requestId: string;
	connectionId: string;
	actorUserId: string;
	actorSessionVersion: number;
	controller: AbortController;
	clientSignal?: AbortSignal;
	clientAbortListener?: () => void;
	abortSource: "client" | "revocation" | null;
};

export type AgentActiveRunHandle = {
	readonly signal: AbortSignal;
	readonly wasRevoked: boolean;
	finish(): void;
};

/**
 * Binds active model work to the exact socket authority that admitted it.
 * The registry is intentionally in-memory and contains identifiers only.
 */
export class AgentActiveRunRegistry {
	#runs = new Map<string, ActiveRun>();

	begin(input: {
		requestId: string;
		connectionId: string;
		actorUserId: string;
		actorSessionVersion: number;
		clientSignal?: AbortSignal;
	}): AgentActiveRunHandle {
		const key = `${input.connectionId}\u0000${input.requestId}`;
		const previous = this.#runs.get(key);
		if (previous) this.#abort(previous, "client", clientAbortError());

		const run: ActiveRun = {
			...input,
			controller: new AbortController(),
			abortSource: null,
		};
		if (input.clientSignal) {
			run.clientAbortListener = () => {
				this.#abort(
					run,
					"client",
					input.clientSignal?.reason ?? clientAbortError(),
				);
			};
			input.clientSignal.addEventListener("abort", run.clientAbortListener, {
				once: true,
			});
		}
		this.#runs.set(key, run);
		if (input.clientSignal?.aborted) run.clientAbortListener?.();

		return {
			get signal() {
				return run.controller.signal;
			},
			get wasRevoked() {
				return run.abortSource === "revocation";
			},
			finish: () => {
				if (this.#runs.get(key) === run) this.#runs.delete(key);
				this.#removeClientListener(run);
			},
		};
	}

	abortStaleActorRuns(
		actorUserId: string,
		currentSessionVersion: number | null,
	): void {
		for (const run of this.#runs.values()) {
			if (
				run.actorUserId === actorUserId &&
				(currentSessionVersion === null ||
					run.actorSessionVersion !== currentSessionVersion)
			) {
				this.#abort(run, "revocation", revocationAbortError());
			}
		}
	}

	abortActorRuns(actorUserId: string): void {
		for (const run of this.#runs.values()) {
			if (run.actorUserId === actorUserId) {
				this.#abort(run, "revocation", revocationAbortError());
			}
		}
	}

	abortUnauthorizedConnectionRuns(
		authorizedConnectionIds: ReadonlySet<string>,
	): void {
		for (const run of this.#runs.values()) {
			if (!authorizedConnectionIds.has(run.connectionId)) {
				this.#abort(run, "revocation", revocationAbortError());
			}
		}
	}

	abortAll(): void {
		for (const run of this.#runs.values()) {
			this.#abort(run, "revocation", revocationAbortError());
		}
	}

	get size(): number {
		return this.#runs.size;
	}

	#abort(
		run: ActiveRun,
		source: "client" | "revocation",
		reason: unknown,
	): void {
		if (run.controller.signal.aborted) return;
		run.abortSource = source;
		this.#removeClientListener(run);
		run.controller.abort(reason);
	}

	#removeClientListener(run: ActiveRun): void {
		if (run.clientSignal && run.clientAbortListener) {
			run.clientSignal.removeEventListener("abort", run.clientAbortListener);
			run.clientAbortListener = undefined;
		}
	}
}

export function throwIfAgentRunAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	throw signal.reason ?? clientAbortError();
}
