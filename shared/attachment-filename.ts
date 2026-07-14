export const ATTACHMENT_PRESENTATION_FILENAME_CHARACTERS = 255;
export const R2_OBJECT_KEY_MAX_BYTES = 1_024;

export type AttachmentStorageSource =
	| { kind: "upload"; uploadId: string }
	| { kind: "existing"; emailId: string; attachmentId: string };

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function takeBoundedCharacters(
	value: string,
	maximumCharacters: number,
	maximumBytes: number,
): string {
	let bytes = 0;
	const accepted: string[] = [];
	for (const character of value) {
		if (accepted.length >= maximumCharacters) break;
		const characterBytes = utf8Bytes(character);
		if (bytes + characterBytes > maximumBytes) break;
		accepted.push(character);
		bytes += characterBytes;
	}
	return accepted.join("");
}

function boundedFilename(
	value: string,
	maximumCharacters: number,
	maximumBytes: number,
): string {
	const dot = value.lastIndexOf(".");
	const extension = dot > 0 ? value.slice(dot) : "";
	const extensionCharacters = [...extension].length;
	const preserveExtension =
		extensionCharacters <= 64 &&
		extensionCharacters < maximumCharacters &&
		utf8Bytes(extension) < maximumBytes;
	const suffix = preserveExtension ? extension : "";
	const stem = preserveExtension ? value.slice(0, dot) : value;
	const boundedStem = takeBoundedCharacters(
		stem,
		maximumCharacters - [...suffix].length,
		maximumBytes - utf8Bytes(suffix),
	);
	return `${boundedStem}${suffix}`;
}

/** Prefix preceding the filename for permanent attachment storage. */
export function attachmentStorageKeyPrefix(
	emailId: string,
	attachmentId: string,
): string {
	return `attachments/${emailId}/${attachmentId}/`;
}

export function attachmentStorageSourceIdentity(
	source: AttachmentStorageSource,
): string {
	return source.kind === "upload"
		? `upload:${source.uploadId}`
		: `existing:${source.emailId}:${source.attachmentId}`;
}

/** Stable permanent identity for one source occurrence in one destination. */
export async function attachmentStorageId(
	destinationEmailId: string,
	source: AttachmentStorageSource,
	occurrence: number,
	operationScope?: string,
): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify([
			destinationEmailId,
			attachmentStorageSourceIdentity(source),
			occurrence,
			operationScope ?? null,
		])),
	));
	const bytes = digest.slice(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Bound a filename used in an external header or provider request without
 * changing authoritative storage identity. Preserve a conventional extension.
 */
export function safeAttachmentPresentationFilename(value: string): string {
	const sanitized = (value || "untitled").replace(/[\x00-\x1f\x7f]/g, "_");
	return boundedFilename(
		sanitized,
		ATTACHMENT_PRESENTATION_FILENAME_CHARACTERS,
		Number.MAX_SAFE_INTEGER,
	);
}

/**
 * Normalize a filename before it becomes durable R2 identity. The exact key
 * prefix determines the remaining UTF-8 budget beneath R2's 1,024-byte limit.
 * https://developers.cloudflare.com/r2/platform/limits/#limits
 */
export function safeAttachmentStorageFilename(
	value: string,
	keyPrefix: string,
): string {
	const availableBytes = R2_OBJECT_KEY_MAX_BYTES - utf8Bytes(keyPrefix);
	if (availableBytes <= 0) {
		throw new Error("Attachment storage identity exceeds the R2 key limit.");
	}
	const sanitized = (value || "untitled").replace(
		/[\/\\:*?"<>|\x00-\x1f\x7f]/g,
		"_",
	);
	const bounded = boundedFilename(
		sanitized,
		ATTACHMENT_PRESENTATION_FILENAME_CHARACTERS,
		availableBytes,
	);
	if (bounded) return bounded;
	const fallback = takeBoundedCharacters("untitled", 8, availableBytes);
	if (fallback) return fallback;
	throw new Error("Attachment filename cannot fit the R2 key limit.");
}
