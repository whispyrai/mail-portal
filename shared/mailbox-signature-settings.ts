export const MAILBOX_SIGNATURE_LIMITS = {
	requestBytes: 8 * 1024,
	textCharacters: 2_000,
} as const;

export type MailboxSignature = {
	enabled: boolean;
	text: string;
};

export type MailboxSignatureSettingsResponse = {
	signature: MailboxSignature;
	canManage: boolean;
};
