import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MailboxSignature } from "../../shared/mailbox-signature-settings.ts";
import {
	getMailboxSignatureSettings,
	updateMailboxSignature,
} from "../services/mailbox-signature-settings.ts";

export const mailboxSignatureSettingsKey = (mailboxId: string) =>
	["mailbox-signature-settings", mailboxId] as const;

export function useMailboxSignatureSettings(mailboxId: string | undefined) {
	return useQuery({
		queryKey: mailboxId
			? mailboxSignatureSettingsKey(mailboxId)
			: ["mailbox-signature-settings", "disabled"],
		queryFn: ({ signal }) => getMailboxSignatureSettings(mailboxId!, signal),
		enabled: Boolean(mailboxId),
		retry: 1,
	});
}

export function useUpdateMailboxSignature() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ mailboxId, signature }: { mailboxId: string; signature: MailboxSignature }) =>
			updateMailboxSignature(mailboxId, signature),
		onSuccess: (response, { mailboxId }) => {
			queryClient.setQueryData(mailboxSignatureSettingsKey(mailboxId), response);
		},
	});
}
