import { isCanonicalContentId } from "../../shared/content-id.ts";

export const SES_ATTACHMENT_LIMITS = {
	contentIdCharacters: 78,
} as const;

/** Outbound Content-ID must satisfy both the portal header contract and SES. */
export function isSesAttachmentContentId(value: string): boolean {
	return (
		value.length <= SES_ATTACHMENT_LIMITS.contentIdCharacters &&
		isCanonicalContentId(value)
	);
}
