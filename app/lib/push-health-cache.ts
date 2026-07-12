/** Actor-private, non-persisted query identity for one Mailbox health surface. */
export function pushHealthKey(mailboxId: string, actorScope: string) {
	return ["push", mailboxId, "health", actorScope] as const;
}

/** Keep the pure cache seam independent of the HTTP client for direct tests. */
export function isPushHealthAccessRevoked(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === "object" &&
		"status" in error &&
		(error as { status?: unknown }).status === 403,
	);
}
