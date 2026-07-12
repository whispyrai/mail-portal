import type {
	MailboxSignature,
	MailboxSignatureSettingsResponse,
} from "../../shared/mailbox-signature-settings.ts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class MailboxSignatureSettingsApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "MailboxSignatureSettingsApiError";
		this.status = status;
	}
}

function base(mailboxId: string) {
	return `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/settings`;
}

async function request(
	url: string,
	init: RequestInit,
	fetcher: FetchLike,
): Promise<MailboxSignatureSettingsResponse> {
	const response = await fetcher(url, { credentials: "same-origin", ...init });
	if (!response.ok) {
		const body = await response.json().catch(() => ({})) as { error?: string };
		throw new MailboxSignatureSettingsApiError(
			response.status,
			body.error ?? "Signature settings are unavailable",
		);
	}
	return response.json() as Promise<MailboxSignatureSettingsResponse>;
}

export function getMailboxSignatureSettings(
	mailboxId: string,
	signal?: AbortSignal,
	fetcher: FetchLike = fetch,
) {
	return request(base(mailboxId), { method: "GET", signal }, fetcher);
}

export function updateMailboxSignature(
	mailboxId: string,
	signature: MailboxSignature,
	fetcher: FetchLike = fetch,
) {
	return request(
		`${base(mailboxId)}/signature`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(signature),
		},
		fetcher,
	);
}
