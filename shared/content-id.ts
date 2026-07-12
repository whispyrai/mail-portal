export const CONTENT_ID_LIMITS = {
	maxBytes: 255,
} as const;

const LOCAL_ATOM = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~]+";
const DOMAIN_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?";
const CONTENT_ID_PATTERN = new RegExp(
	`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*@${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`,
);

/**
 * A Content-ID crosses an email-header boundary, so only one stable,
 * unquoted ASCII addr-spec form is accepted. Callers must not trim or unwrap
 * values: a value is either canonical as supplied or it is rejected.
 */
export function isCanonicalContentId(value: string): boolean {
	return (
		new TextEncoder().encode(value).byteLength <= CONTENT_ID_LIMITS.maxBytes &&
		CONTENT_ID_PATTERN.test(value)
	);
}

/** Content-ID is meaningful only for an authoritative inline disposition. */
export function contentIdForDisposition(
	disposition: string | null | undefined,
	contentId: string | null | undefined,
): string | null {
	return disposition === "inline" ? contentId ?? null : null;
}

/** Fresh inline uploads are intentionally limited to image MIME parts. */
export function isInlineImageMimeType(value: string | null | undefined): boolean {
	return typeof value === "string" && /^image\/[a-z0-9][a-z0-9.+-]*$/i.test(value);
}
