import {
	isCanonicalContentId,
	isInlineImageMimeType,
} from "./content-id.ts";

export const MANAGED_INLINE_IMAGE_ATTRIBUTE = "data-mail-inline-image";
export const MANAGED_INLINE_IMAGE_VERSION = "v1";
export const FORWARDED_MESSAGE_ATTRIBUTE = "data-mail-forwarded-message";
export const INLINE_IMAGE_HTML_MAX_BYTES = 1_048_576;

export interface InlineImageMappingAttachment {
	filename: string;
	mimetype?: string;
	status: string;
	disposition?: string;
	contentId?: string | null;
}

export type InlineImageMappingErrorCode =
	| "inline_html_too_large"
	| "inline_html_malformed"
	| "inline_html_duplicate_attribute"
	| "inline_image_invalid_source"
	| "inline_image_duplicate_body_cid"
	| "inline_image_duplicate_attachment_cid"
	| "inline_image_missing_attachment"
	| "inline_image_not_ready"
	| "inline_image_not_inline"
	| "inline_image_not_image";

export type InlineImageMappingResult =
	| { ok: true; referencedContentIds: string[] }
	| { ok: false; code: InlineImageMappingErrorCode; error: string };

type ParsedStartTag = {
	name: string;
	start: number;
	end: number;
	depth: number;
	attributes: Readonly<Record<string, string | null>>;
};

type HtmlProjection = {
	tags: ParsedStartTag[];
	forwardedStart: number | null;
};

const RELEVANT_ATTRIBUTES = new Set([
	"src",
	MANAGED_INLINE_IMAGE_ATTRIBUTE,
	FORWARDED_MESSAGE_ATTRIBUTE,
]);
const VOID_ELEMENTS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
	"meta", "param", "source", "track", "wbr",
]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

function mappingError(
	code: InlineImageMappingErrorCode,
	error: string,
): InlineImageMappingResult {
	return { ok: false, code, error };
}

function decodeAttributeEntities(value: string): string {
	return value.replace(
		/&(?:#(\d+)|#x([0-9a-f]+)|(amp|quot|apos|lt|gt|colon));/gi,
		(_match, decimal: string | undefined, hexadecimal: string | undefined, named: string | undefined) => {
			if (decimal) {
				const codePoint = Number(decimal);
				return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
					? String.fromCodePoint(codePoint)
					: "\ufffd";
			}
			if (hexadecimal) {
				const codePoint = Number.parseInt(hexadecimal, 16);
				return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
					? String.fromCodePoint(codePoint)
					: "\ufffd";
			}
			switch (named?.toLowerCase()) {
				case "amp": return "&";
				case "quot": return '"';
				case "apos": return "'";
				case "lt": return "<";
				case "gt": return ">";
				case "colon": return ":";
				default: return "\ufffd";
			}
		},
	);
}

function tagEnd(html: string, start: number): number | null {
	let quote: '"' | "'" | null = null;
	for (let index = start + 1; index < html.length; index++) {
		const character = html[index]!;
		if (quote) {
			if (character === quote) quote = null;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === ">") return index + 1;
	}
	return null;
}

function rawTextClose(
	lowerHtml: string,
	element: string,
	from: number,
): number | null {
	const prefix = `</${element}`;
	let candidate = lowerHtml.indexOf(prefix, from);
	while (candidate >= 0) {
		const boundary = lowerHtml[candidate + prefix.length];
		if (boundary === ">" || /\s/.test(boundary ?? "")) return candidate;
		candidate = lowerHtml.indexOf(prefix, candidate + prefix.length);
	}
	return null;
}

function parseAttributes(
	tag: string,
	nameEnd: number,
):
	| { ok: true; attributes: Record<string, string | null>; selfClosing: boolean }
	| { ok: false; code: InlineImageMappingErrorCode; error: string } {
	const attributes: Record<string, string | null> = {};
	const seenRelevant = new Set<string>();
	let index = nameEnd;
	let selfClosing = false;
	while (index < tag.length - 1) {
		while (/\s/.test(tag[index] ?? "")) index++;
		if (tag[index] === ">") break;
		if (tag[index] === "/" && tag[index + 1] === ">") {
			selfClosing = true;
			break;
		}
		const attributeStart = index;
		while (index < tag.length - 1 && !/[\s=/>]/.test(tag[index] ?? "")) index++;
		if (attributeStart === index) {
			return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
		}
		const attributeName = tag.slice(attributeStart, index).toLowerCase();
		while (/\s/.test(tag[index] ?? "")) index++;
		let value: string | null = null;
		if (tag[index] === "=") {
			index++;
			while (/\s/.test(tag[index] ?? "")) index++;
			const quote = tag[index];
			if (quote === '"' || quote === "'") {
				index++;
				const valueStart = index;
				while (index < tag.length - 1 && tag[index] !== quote) index++;
				if (tag[index] !== quote) {
					return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
				}
				value = decodeAttributeEntities(tag.slice(valueStart, index));
				index++;
			} else {
				const valueStart = index;
				while (index < tag.length - 1 && !/[\s>]/.test(tag[index] ?? "")) index++;
				if (valueStart === index || /["'<=`]/.test(tag.slice(valueStart, index))) {
					return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
				}
				value = decodeAttributeEntities(tag.slice(valueStart, index));
			}
		}
		if (RELEVANT_ATTRIBUTES.has(attributeName)) {
			if (seenRelevant.has(attributeName)) {
				return {
					ok: false,
					code: "inline_html_duplicate_attribute",
					error: `Message HTML repeats the ${attributeName} attribute.`,
				};
			}
			seenRelevant.add(attributeName);
		}
		if (!(attributeName in attributes)) attributes[attributeName] = value;
	}
	return { ok: true, attributes, selfClosing };
}

function projectHtml(html: string):
	| { ok: true; projection: HtmlProjection }
	| { ok: false; code: InlineImageMappingErrorCode; error: string } {
	if (new TextEncoder().encode(html).byteLength > INLINE_IMAGE_HTML_MAX_BYTES) {
		return {
			ok: false,
			code: "inline_html_too_large",
			error: "Message HTML is too large to validate safely.",
		};
	}
	const tags: ParsedStartTag[] = [];
	const stack: string[] = [];
	const lowerHtml = html.toLowerCase();
	let forwardedStart: number | null = null;
	let index = 0;
	while (index < html.length) {
		const rawElement = stack.at(-1);
		if (rawElement && RAW_TEXT_ELEMENTS.has(rawElement)) {
			const closeAt = rawTextClose(lowerHtml, rawElement, index);
			if (closeAt === null) {
				return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
			}
			index = closeAt;
		}
		if (html[index] !== "<") {
			index++;
			continue;
		}
		if (html.startsWith("<!--", index)) {
			const commentEnd = html.indexOf("-->", index + 4);
			if (commentEnd < 0) {
				return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
			}
			index = commentEnd + 3;
			continue;
		}
		if (/^<![A-Z]/i.test(html.slice(index, index + 3)) || html.startsWith("<?", index)) {
			const end = tagEnd(html, index);
			if (end === null) {
				return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
			}
			index = end;
			continue;
		}
		const end = tagEnd(html, index);
		if (end === null) {
			return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
		}
		const tag = html.slice(index, end);
		const closing = /^<\s*\//.test(tag);
		const nameMatch = /^<\s*\/?\s*([a-z][a-z0-9-]*)/i.exec(tag);
		if (!nameMatch) {
			index++;
			continue;
		}
		const name = nameMatch[1]!.toLowerCase();
		if (closing) {
			const afterName = nameMatch[0].length;
			if (!/^\s*>$/.test(tag.slice(afterName)) || stack.at(-1) !== name) {
				return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
			}
			stack.pop();
			index = end;
			continue;
		}
		const parsedAttributes = parseAttributes(tag, nameMatch[0].length);
		if (!parsedAttributes.ok) return parsedAttributes;
		const startTag: ParsedStartTag = {
			name,
			start: index,
			end,
			depth: stack.length,
			attributes: parsedAttributes.attributes,
		};
		tags.push(startTag);
		if (
			forwardedStart === null &&
			name === "div" &&
			startTag.depth === 0 &&
			startTag.attributes[FORWARDED_MESSAGE_ATTRIBUTE]?.toLowerCase() ===
				MANAGED_INLINE_IMAGE_VERSION
		) {
			forwardedStart = index;
		}
		if (!parsedAttributes.selfClosing && !VOID_ELEMENTS.has(name)) stack.push(name);
		index = end;
	}
	if (stack.length > 0) {
		return { ok: false, code: "inline_html_malformed", error: "Message HTML is malformed." };
	}
	return { ok: true, projection: { tags, forwardedStart } };
}

export function managedInlineImageContentId(
	source: string | null | undefined,
	marker: string | null | undefined,
): string | null {
	if (marker?.toLowerCase() !== MANAGED_INLINE_IMAGE_VERSION || !source) return null;
	return inlineImageContentIdFromSource(source);
}

export function inlineImageContentIdFromSource(
	source: string | null | undefined,
): string | null {
	if (!source?.toLowerCase().startsWith("cid:")) return null;
	const contentId = source.slice(4);
	return isCanonicalContentId(contentId) ? contentId.toLowerCase() : null;
}

function authoredInlineImages(html: string):
	| { ok: true; contentIds: string[]; ranges: Array<{ start: number; end: number; contentId: string }> }
	| { ok: false; code: InlineImageMappingErrorCode; error: string } {
	const projected = projectHtml(html);
	if (!projected.ok) return projected;
	const contentIds: string[] = [];
	const ranges: Array<{ start: number; end: number; contentId: string }> = [];
	for (const tag of projected.projection.tags) {
		if (tag.name !== "img") continue;
		if (
			projected.projection.forwardedStart !== null &&
			tag.start >= projected.projection.forwardedStart
		) continue;
		const marker = tag.attributes[MANAGED_INLINE_IMAGE_ATTRIBUTE];
		const source = tag.attributes.src;
		const hasMarker = marker !== undefined;
		const isManaged = marker?.toLowerCase() === MANAGED_INLINE_IMAGE_VERSION;
		const isLegacyCid = !hasMarker && source?.toLowerCase().startsWith("cid:");
		if (!isManaged && !isLegacyCid) {
			if (hasMarker) {
				return { ok: false, code: "inline_image_invalid_source", error: "A managed inline image does not use a canonical CID source." };
			}
			continue;
		}
		const contentId = isManaged
			? managedInlineImageContentId(source, marker)
			: inlineImageContentIdFromSource(source);
		if (!contentId) {
			return { ok: false, code: "inline_image_invalid_source", error: "A managed inline image does not use a canonical CID source." };
		}
		contentIds.push(contentId);
		ranges.push({ start: tag.start, end: tag.end, contentId });
	}
	return { ok: true, contentIds, ranges };
}

export function authoredBodyReferencesInlineContentId(
	bodyHtml: string,
	contentId: string | null | undefined,
): boolean {
	const normalized = contentId?.replace(/^<|>$/g, "").toLowerCase();
	if (!normalized) return false;
	const images = authoredInlineImages(bodyHtml);
	return images.ok && images.contentIds.includes(normalized);
}

export function removeManagedInlineImageNodes(
	bodyHtml: string,
	contentId: string,
): string {
	const normalized = contentId.toLowerCase();
	const images = authoredInlineImages(bodyHtml);
	if (!images.ok) return bodyHtml;
	let result = bodyHtml;
	for (const range of images.ranges
		.filter((candidate) => candidate.contentId === normalized)
		.sort((left, right) => right.start - left.start)) {
		result = result.slice(0, range.start) + result.slice(range.end);
	}
	return result;
}

export function validateInlineImageMappings(
	bodyHtml: string,
	attachments: ReadonlyArray<InlineImageMappingAttachment>,
): InlineImageMappingResult {
	const images = authoredInlineImages(bodyHtml);
	if (!images.ok) return images;
	const seenBody = new Set<string>();
	for (const contentId of images.contentIds) {
		if (seenBody.has(contentId)) {
			return mappingError("inline_image_duplicate_body_cid", `The inline image ${contentId} appears more than once in the authored message.`);
		}
		seenBody.add(contentId);
	}
	const byContentId = new Map<string, InlineImageMappingAttachment>();
	for (const attachment of attachments) {
		if (!attachment.contentId) continue;
		const normalized = attachment.contentId.toLowerCase();
		if (byContentId.has(normalized)) {
			return mappingError("inline_image_duplicate_attachment_cid", `Two attachments use the same Content-ID (${attachment.contentId}).`);
		}
		byContentId.set(normalized, attachment);
	}
	for (const contentId of images.contentIds) {
		const attachment = byContentId.get(contentId);
		if (!attachment) return mappingError("inline_image_missing_attachment", `An inline image in the message is missing its attachment (${contentId}).`);
		if (attachment.status !== "ready") return mappingError("inline_image_not_ready", `The embedded inline image "${attachment.filename}" is not ready.`);
		if (attachment.disposition !== "inline") return mappingError("inline_image_not_inline", `The embedded image "${attachment.filename}" is not an inline attachment.`);
		if (!isInlineImageMimeType(attachment.mimetype)) return mappingError("inline_image_not_image", `The embedded inline part "${attachment.filename}" is not an image.`);
	}
	return { ok: true, referencedContentIds: images.contentIds };
}
