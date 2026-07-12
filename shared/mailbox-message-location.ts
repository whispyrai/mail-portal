export interface MailboxMessageLocation {
	emailId: string;
	folderId: string;
}

export class MailboxMessageLocationContractError extends Error {
	constructor() {
		super("Mailbox Message location response is invalid");
		this.name = "MailboxMessageLocationContractError";
	}
}

const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

function safeIdentifier(value: unknown, maximum: number): value is string {
	return typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maximum &&
		value === value.trim() &&
		value === value.normalize("NFC") &&
		!UNSAFE_TEXT.test(value);
}

export function validateMailboxMessageLocation(
	value: unknown,
	expectedEmailId: string,
): MailboxMessageLocation {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new MailboxMessageLocationContractError();
	}
	const row = value as Record<string, unknown>;
	if (
		Object.keys(row).sort().join(",") !== "emailId,folderId" ||
		row.emailId !== expectedEmailId ||
		!safeIdentifier(row.emailId, 300) ||
		!safeIdentifier(row.folderId, 128)
	) throw new MailboxMessageLocationContractError();
	return { emailId: row.emailId, folderId: row.folderId };
}
