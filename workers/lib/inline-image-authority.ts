import { validateInlineImageMappings } from "../../shared/inline-image-mappings.ts";

interface AuthoritativeInlineAttachment {
	filename: string;
	mimetype: string;
	disposition?: string | null;
	content_id?: string | null;
}

/** Validate message HTML against the exact authoritative metadata being stored. */
export function validateResolvedInlineImages(
	bodyHtml: string,
	attachments: ReadonlyArray<AuthoritativeInlineAttachment>,
) {
	return validateInlineImageMappings(
		bodyHtml,
		attachments.map((attachment) => ({
			filename: attachment.filename,
			mimetype: attachment.mimetype,
			status: "ready",
			disposition: attachment.disposition ?? undefined,
			contentId: attachment.content_id,
		})),
	);
}
