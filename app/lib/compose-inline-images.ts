import {
	isCanonicalContentId,
} from "../../shared/content-id.ts";

export {
	authoredBodyReferencesInlineContentId,
	inlineImageContentIdFromSource,
	managedInlineImageContentId,
	removeManagedInlineImageNodes,
	validateInlineImageMappings,
	MANAGED_INLINE_IMAGE_ATTRIBUTE,
	MANAGED_INLINE_IMAGE_VERSION,
} from "../../shared/inline-image-mappings.ts";
export type {
	InlineImageMappingAttachment,
	InlineImageMappingResult,
} from "../../shared/inline-image-mappings.ts";
import {
	MANAGED_INLINE_IMAGE_ATTRIBUTE,
	MANAGED_INLINE_IMAGE_VERSION,
} from "../../shared/inline-image-mappings.ts";

export const CLIENT_INLINE_CONTENT_ID_DOMAIN = "mail-portal.local";

export interface InlineImageInsertion {
	contentId: string;
	alt: string;
}

function escapeHtmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export function generateClientInlineContentId(
	randomUUID: () => string = () => crypto.randomUUID(),
): string {
	const contentId = `${randomUUID()}@${CLIENT_INLINE_CONTENT_ID_DOMAIN}`;
	if (!isCanonicalContentId(contentId)) {
		throw new Error("Could not generate a valid inline image Content-ID.");
	}
	return contentId;
}

export function createManagedInlineImageHtml(input: {
	contentId: string;
	alt: string;
}): string {
	if (!isCanonicalContentId(input.contentId)) {
		throw new Error("Inline images require a canonical Content-ID.");
	}
	return `<img src="cid:${input.contentId}" alt="${escapeHtmlAttribute(input.alt)}" ${MANAGED_INLINE_IMAGE_ATTRIBUTE}="${MANAGED_INLINE_IMAGE_VERSION}">`;
}
