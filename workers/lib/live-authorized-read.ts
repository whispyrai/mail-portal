export class LiveReadAuthorizationError extends Error {
	constructor() {
		super("Mail access changed during the read");
		this.name = "LiveReadAuthorizationError";
	}
}

/** The exact credential generation is no longer an active session. */
export class LiveReadSessionAuthorizationError extends LiveReadAuthorizationError {
	constructor() {
		super();
		this.name = "LiveReadSessionAuthorizationError";
	}
}

export class LiveReadAuthorizationUnavailableError extends Error {
	constructor(options?: ErrorOptions) {
		super("Mail authorization is temporarily unavailable", options);
		this.name = "LiveReadAuthorizationUnavailableError";
	}
}

async function checkAuthorization(authorize: () => Promise<boolean>): Promise<boolean> {
	try {
		return await authorize();
	} catch (cause) {
		throw new LiveReadAuthorizationUnavailableError({ cause });
	}
}

async function checkSnapshot<T>(snapshot: () => Promise<T | null>): Promise<T | null> {
	try {
		return await snapshot();
	} catch (cause) {
		throw new LiveReadAuthorizationUnavailableError({ cause });
	}
}

/**
 * Discard a mail read unless the same live authorization survives both sides
 * of the asynchronous storage operation. A later revocation takes precedence
 * over either a successful result or a private storage failure.
 */
export async function runLiveAuthorizedRead<T>(
	authorize: () => Promise<boolean>,
	read: () => Promise<T>,
): Promise<T> {
	if (!(await checkAuthorization(authorize))) throw new LiveReadAuthorizationError();
	const outcome = await Promise.resolve().then(read).then(
		(value) => ({ status: "success" as const, value }),
		(error: unknown) => ({ status: "failed" as const, error }),
	);
	if (!(await checkAuthorization(authorize))) throw new LiveReadAuthorizationError();
	if (outcome.status === "failed") throw outcome.error;
	return outcome.value;
}

/**
 * Discard a global disclosure unless both the exact live session and its full
 * authorization set remain unchanged across the asynchronous read.
 */
export async function runLiveAuthorizedSnapshotRead<Snapshot, Value>(
	snapshot: () => Promise<Snapshot | null>,
	isSameSnapshot: (before: Snapshot, after: Snapshot) => boolean,
	read: () => Promise<Value>,
): Promise<Value> {
	const before = await checkSnapshot(snapshot);
	if (before === null) throw new LiveReadSessionAuthorizationError();
	const outcome = await Promise.resolve().then(read).then(
		(value) => ({ status: "success" as const, value }),
		(error: unknown) => ({ status: "failed" as const, error }),
	);
	const after = await checkSnapshot(snapshot);
	if (after === null) throw new LiveReadSessionAuthorizationError();
	if (!isSameSnapshot(before, after)) throw new LiveReadAuthorizationError();
	if (outcome.status === "failed") throw outcome.error;
	return outcome.value;
}

/**
 * Authorize a mutation immediately before it starts. Unlike disclosure reads,
 * a committed write result must not be replaced by a false failure afterward.
 */
export async function runLiveAuthorizedMutation<T>(
	authorize: () => Promise<boolean>,
	mutate: () => Promise<T>,
): Promise<T> {
	if (!(await checkAuthorization(authorize))) {
		throw new LiveReadAuthorizationError();
	}
	return mutate();
}
