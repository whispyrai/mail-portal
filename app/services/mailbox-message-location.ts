import {
	validateMailboxMessageLocation,
	type MailboxMessageLocation,
} from "../../shared/mailbox-message-location.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MailboxMessageLocationApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "MailboxMessageLocationApiError";
		this.status = status;
	}
}

export async function fetchMailboxMessageLocation(
	mailboxId: string,
	emailId: string,
	options: { signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<MailboxMessageLocation> {
	const response = await (options.fetcher ?? fetch)(
		`/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/emails/${encodeURIComponent(emailId)}/location`,
		{
			method: "GET",
			credentials: "same-origin",
			cache: "no-store",
			signal: options.signal,
		},
	);
	const body = await response.json().catch(() => null);
	if (!response.ok) {
		const record = body && typeof body === "object" && !Array.isArray(body)
			? body as Record<string, unknown>
			: {};
		throw new MailboxMessageLocationApiError(
			response.status,
			typeof record.error === "string" && record.error.trim()
				? record.error.trim()
				: response.status === 404
					? "Message no longer available"
					: "Message location is unavailable",
		);
	}
	return validateMailboxMessageLocation(body, emailId);
}
