export class LiveReadAuthorizationError extends Error {
	constructor() {
		super("Mail access changed during the read");
		this.name = "LiveReadAuthorizationError";
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
	const outcome = await read().then(
		(value) => ({ status: "success" as const, value }),
		(error: unknown) => ({ status: "failed" as const, error }),
	);
	if (!(await checkAuthorization(authorize))) throw new LiveReadAuthorizationError();
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
