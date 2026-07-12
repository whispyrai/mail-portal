/**
 * Keeps an idempotency key stable for one immutable logical send. A retry with
 * the same payload reuses the key. Editing any payload field creates a new
 * logical action so the server cannot replay an older snapshot by accident.
 */
function browserSessionStorage(): Pick<Storage, "getItem" | "setItem"> | null {
	if (typeof window === "undefined") return null;
	try {
		return window.sessionStorage;
	} catch {
		return null;
	}
}

export class LogicalSendIdentity {
	#fingerprint: string | null = null;
	#key: string | null = null;
	readonly #createKey: () => string;
	readonly #storage: Pick<Storage, "getItem" | "setItem"> | null;

	constructor(
		createKey: () => string = () => crypto.randomUUID(),
		storage: Pick<Storage, "getItem" | "setItem"> | null =
			browserSessionStorage(),
	) {
		this.#createKey = createKey;
		this.#storage = storage;
	}

	keyFor(payload: unknown, persistenceKey?: string): string {
		const fingerprint = JSON.stringify(payload);
		if (this.#key === null || fingerprint !== this.#fingerprint) {
			this.#fingerprint = fingerprint;
			let stored: string | null = null;
			try {
				stored = persistenceKey
					? this.#storage?.getItem(persistenceKey) ?? null
					: null;
			} catch {
				stored = null;
			}
			this.#key = stored || this.#createKey();
			if (persistenceKey && !stored) {
				try {
					this.#storage?.setItem(persistenceKey, this.#key);
				} catch {
					// The in-memory key still protects retries for this mounted composer.
				}
			}
		}
		return this.#key;
	}

	reset(): void {
		this.#fingerprint = null;
		this.#key = null;
	}
}
