import {
	validatePushHealthResponse,
	type PushHealthResponse,
} from "../../shared/push-health.ts";

export type { PushDeviceHealth, PushHealthResponse } from "../../shared/push-health.ts";

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export class PushHealthApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "PushHealthApiError";
		this.status = status;
	}
}

function errorBody(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

/**
 * Read actor-private push health for one authorized Mailbox. The shared
 * contract is the sole response authority; this module owns only HTTP work.
 */
export async function fetchPushHealth(
	mailboxId: string,
	fetcher: FetchLike = fetch,
	signal?: AbortSignal,
): Promise<PushHealthResponse> {
	const response = await fetcher(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/push-health`,
		{
			method: "GET",
			credentials: "same-origin",
			cache: "no-store",
			signal,
		},
	);
	if (!response.ok) {
		const body = errorBody(await response.json().catch(() => null));
		throw new PushHealthApiError(
			response.status,
			typeof body.error === "string" && body.error.trim()
				? body.error.trim()
				: "Notification status is unavailable",
		);
	}
	return validatePushHealthResponse(await response.json());
}
