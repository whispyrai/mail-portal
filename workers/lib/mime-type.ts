const MIME_TOKEN = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
const MIME_TYPE_PATTERN = new RegExp(`^(${MIME_TOKEN})\/(${MIME_TOKEN})$`);

/** Normalize an RFC 6838 media type for an HTTP response header. */
export function safeAttachmentResponseMimeType(value: string): string {
	const normalized = value.trim().toLowerCase();
	return MIME_TYPE_PATTERN.test(normalized)
		? normalized
		: "application/octet-stream";
}

/** Apply the stricter SES v2 78-character media-type boundary. */
export function safeSesAttachmentMimeType(value: string): string {
	const normalized = safeAttachmentResponseMimeType(value);
	// SES v2 rejects Attachment.ContentType values longer than 78 characters.
	// https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_Attachment.html
	return normalized.length <= 78
		? normalized
		: "application/octet-stream";
}
