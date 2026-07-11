/**
 * Keeps an idempotency key stable for one immutable logical send. A retry with
 * the same payload reuses the key. Editing any payload field creates a new
 * logical action so the server cannot replay an older snapshot by accident.
 */
export class LogicalSendIdentity {
	#fingerprint: string | null = null;
	#key: string | null = null;
	readonly #createKey: () => string;

	constructor(createKey: () => string = () => crypto.randomUUID()) {
		this.#createKey = createKey;
	}

	keyFor(payload: unknown): string {
		const fingerprint = JSON.stringify(payload);
		if (this.#key === null || fingerprint !== this.#fingerprint) {
			this.#fingerprint = fingerprint;
			this.#key = this.#createKey();
		}
		return this.#key;
	}

	reset(): void {
		this.#fingerprint = null;
		this.#key = null;
	}
}
