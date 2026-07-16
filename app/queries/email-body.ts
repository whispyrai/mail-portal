import api from "../services/api.ts";
import { queryKeys } from "./keys.ts";

export function buildEmailBodyQueryOptions(
	mailboxId: string,
	emailId: string,
	request: typeof api.getEmailBody = api.getEmailBody,
) {
	return {
		queryKey: queryKeys.emails.body(mailboxId, emailId),
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			request(mailboxId, emailId, { signal }),
		retry: false,
	};
}
