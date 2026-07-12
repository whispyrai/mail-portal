interface ComposeUploadAttempt {
	token: number;
	controller: AbortController;
}

/** Owns cancellation and monotonic identity for every local upload chip. */
export class ComposeUploadAttemptRegistry {
	#nextToken = 0;
	#attempts = new Map<string, ComposeUploadAttempt>();

	begin(localId: string): { token: number; signal: AbortSignal } {
		this.abort(localId);
		const controller = new AbortController();
		const token = ++this.#nextToken;
		this.#attempts.set(localId, { token, controller });
		return { token, signal: controller.signal };
	}

	isCurrent(localId: string, token: number): boolean {
		const attempt = this.#attempts.get(localId);
		return Boolean(
			attempt && attempt.token === token && !attempt.controller.signal.aborted,
		);
	}

	finish(localId: string, token: number): void {
		if (this.#attempts.get(localId)?.token === token) {
			this.#attempts.delete(localId);
		}
	}

	abort(localId: string): void {
		const attempt = this.#attempts.get(localId);
		if (!attempt) return;
		this.#attempts.delete(localId);
		attempt.controller.abort();
	}

	abortAll(): void {
		const active = [...this.#attempts.values()];
		this.#attempts.clear();
		for (const attempt of active) attempt.controller.abort();
	}
}
