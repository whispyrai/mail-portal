import { truncateSemanticSearchText } from "../../shared/semantic-search.ts";

export const SEMANTIC_ATTACHMENT_POLICY_VERSION = 2;
export const SEMANTIC_ATTACHMENT_EXTRACTION_VERSION = 2;
export const SEMANTIC_ATTACHMENT_CHUNK_VERSION = 1;

export const SEMANTIC_ATTACHMENT_LIMITS = {
	inputBytes: 64 * 1024,
	richInputBytes: 4 * 1024 * 1024,
	outputBytes: 64 * 1024,
	outputChars: 48_000,
	filenameChars: 255,
	chunkChars: 1_400,
	chunkOverlapChars: 200,
	chunksPerAttachment: 40,
} as const;

export type SemanticDirectTextFormat =
	| "text"
	| "markdown"
	| "json"
	| "xml"
	| "csv";
export type SemanticRichDocumentFormat =
	| "pdf"
	| "docx"
	| "xls"
	| "xlsx"
	| "odt"
	| "ods"
	| "numbers";
export type SemanticAttachmentFormat =
	| SemanticDirectTextFormat
	| SemanticRichDocumentFormat;
export type SemanticAttachmentAdmission =
	| {
		kind: "direct";
		format: SemanticDirectTextFormat;
		mimetype: string;
		maxBytes: number;
	}
	| {
		kind: "rich";
		format: SemanticRichDocumentFormat;
		mimetype: string;
		maxBytes: number;
	};

export type SemanticAttachmentChunk = {
	ordinal: number;
	embeddingText: string;
	excerpt: string;
};

export type SemanticAttachmentExtractionFailure =
	| "unsupported_format"
	| "size_mismatch"
	| "size_exceeded"
	| "invalid_utf8"
	| "unsafe_text"
	| "invalid_container"
	| "encrypted_document"
	| "active_content"
	| "decompression_exceeded"
	| "conversion_rejected"
	| "empty_output"
	| "output_exceeded";

export class SemanticAttachmentExtractionError extends Error {
	readonly code: SemanticAttachmentExtractionFailure;

	constructor(code: SemanticAttachmentExtractionFailure) {
		super(code);
		this.name = "SemanticAttachmentExtractionError";
		this.code = code;
	}
}

const MIME_BY_EXTENSION = new Map<string, ReadonlySet<string>>([
	["txt", new Set(["text/plain"])],
	["md", new Set(["text/markdown", "text/plain"])],
	["markdown", new Set(["text/markdown", "text/plain"])],
	["json", new Set(["application/json"])],
	["xml", new Set(["application/xml", "text/xml"])],
	["csv", new Set(["text/csv"])],
]);

const RICH_ADMISSION_BY_EXTENSION = new Map<
	string,
	{
		format: SemanticRichDocumentFormat;
		mimetype: string;
	}
>([
	["pdf", { format: "pdf", mimetype: "application/pdf" }],
	[
		"docx",
		{
			format: "docx",
			mimetype:
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		},
	],
	["xls", { format: "xls", mimetype: "application/vnd.ms-excel" }],
	[
		"xlsx",
		{
			format: "xlsx",
			mimetype:
				"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		},
	],
	[
		"odt",
		{ format: "odt", mimetype: "application/vnd.oasis.opendocument.text" },
	],
	[
		"ods",
		{
			format: "ods",
			mimetype: "application/vnd.oasis.opendocument.spreadsheet",
		},
	],
	["numbers", { format: "numbers", mimetype: "application/vnd.apple.numbers" }],
]);

const MAX_COMBINING_MARK_RUN = 64;
const MIN_TEXT_PLAUSIBILITY_SCALARS = 32;

function normalizedMime(value: string): string {
	return value.split(";", 1)[0]!.trim().toLowerCase();
}

function extension(filename: string): string {
	const position = filename.lastIndexOf(".");
	return position > -1 ? filename.slice(position + 1).trim().toLowerCase() : "";
}

function scalarAt(value: string, index: number): string {
	const codePoint = value.codePointAt(index);
	return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

function scalarWidthAt(value: string, index: number): number {
	const codePoint = value.codePointAt(index);
	return codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
}

function previousScalarStart(value: string, index: number): number {
	const previous = Math.max(index - 1, 0);
	return /^[\uDC00-\uDFFF]$/.test(value[previous] ?? "") &&
		/^[\uD800-\uDBFF]$/.test(value[previous - 1] ?? "")
		? previous - 1
		: previous;
}

function isCombiningMarkAt(value: string, index: number): boolean {
	return /^\p{M}$/u.test(scalarAt(value, index));
}

export function semanticDirectTextFormat(
	filename: string,
	mimetype: string,
): SemanticDirectTextFormat | null {
	const fileExtension = extension(filename);
	const acceptedMimes = MIME_BY_EXTENSION.get(fileExtension);
	if (!acceptedMimes?.has(normalizedMime(mimetype))) return null;
	if (fileExtension === "md" || fileExtension === "markdown") return "markdown";
	if (fileExtension === "json") return "json";
	if (fileExtension === "xml") return "xml";
	if (fileExtension === "csv") return "csv";
	return "text";
}

export function semanticAttachmentAdmission(
	filename: string,
	mimetype: string,
): SemanticAttachmentAdmission | null {
	const normalized = normalizedMime(mimetype);
	const direct = semanticDirectTextFormat(filename, normalized);
	if (direct) {
		return {
			kind: "direct",
			format: direct,
			mimetype: normalized,
			maxBytes: SEMANTIC_ATTACHMENT_LIMITS.inputBytes,
		};
	}
	const fileExtension = extension(filename);
	const richAdmission = RICH_ADMISSION_BY_EXTENSION.get(fileExtension);
	if (!richAdmission || richAdmission.mimetype !== normalized) return null;
	return {
		kind: "rich",
		format: richAdmission.format,
		mimetype: richAdmission.mimetype,
		maxBytes: SEMANTIC_ATTACHMENT_LIMITS.richInputBytes,
	};
}

function normalizeExtractedText(value: string): string {
	return value
		.replace(/\r\n?/g, "\n")
		.replace(/[\u2028\u2029]/g, "\n")
		.replace(/[ \t]+$/gm, "")
		.replace(/\n{4,}/g, "\n\n\n")
		.trim();
}

export function semanticAttachmentText(value: string): string {
	if (
		/[\uD800-\uDFFF]/u.test(value) ||
		/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(
			value,
		)
	) {
		throw new SemanticAttachmentExtractionError("unsafe_text");
	}
	const text = normalizeExtractedText(value);
	if (!text) throw new SemanticAttachmentExtractionError("empty_output");
	assertSemanticAttachmentText(text);
	if (text.length > SEMANTIC_ATTACHMENT_LIMITS.outputChars) {
		throw new SemanticAttachmentExtractionError("output_exceeded");
	}
	if (new TextEncoder().encode(text).byteLength > SEMANTIC_ATTACHMENT_LIMITS.outputBytes) {
		throw new SemanticAttachmentExtractionError("output_exceeded");
	}
	return text;
}

function assertSemanticAttachmentText(value: string): void {
	let visibleScalars = 0;
	let textAnchors = 0;
	let suspiciousScalars = 0;
	let combiningMarkRun = 0;
	for (const scalar of value) {
		if (/^\p{M}$/u.test(scalar)) {
			combiningMarkRun += 1;
			if (combiningMarkRun > MAX_COMBINING_MARK_RUN) {
				throw new SemanticAttachmentExtractionError("unsafe_text");
			}
		} else {
			combiningMarkRun = 0;
		}
		if (/^\s$/u.test(scalar)) continue;
		visibleScalars += 1;
		if (/^[\p{L}\p{N}\p{P}]$/u.test(scalar)) textAnchors += 1;
		if (/^[\p{Co}\p{Cn}]$/u.test(scalar)) suspiciousScalars += 1;
	}
	if (
		visibleScalars >= MIN_TEXT_PLAUSIBILITY_SCALARS &&
		(
			suspiciousScalars * 20 > visibleScalars ||
			textAnchors * 5 < visibleScalars
		)
	) {
		throw new SemanticAttachmentExtractionError("unsafe_text");
	}
}

export function extractSemanticAttachmentText(input: {
	filename: string;
	mimetype: string;
	declaredSize: number;
	bytes: ArrayBuffer;
}): { format: SemanticDirectTextFormat; text: string } {
	const format = semanticDirectTextFormat(input.filename, input.mimetype);
	if (!format) throw new SemanticAttachmentExtractionError("unsupported_format");
	const actualSize = input.bytes.byteLength;
	if (actualSize !== input.declaredSize) {
		throw new SemanticAttachmentExtractionError("size_mismatch");
	}
	if (actualSize > SEMANTIC_ATTACHMENT_LIMITS.inputBytes) {
		throw new SemanticAttachmentExtractionError("size_exceeded");
	}
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
	} catch {
		throw new SemanticAttachmentExtractionError("invalid_utf8");
	}
	const text = semanticAttachmentText(decoded);
	return { format, text };
}

export function semanticAttachmentChunks(
	filename: string,
	text: string,
): SemanticAttachmentChunk[] {
	assertSemanticAttachmentText(text);
	const safeFilename = truncateSemanticSearchText(filename
		.replace(/[\u0000-\u001F\u007F]/g, " ")
		.replace(/\s+/g, " ")
		.trim(), SEMANTIC_ATTACHMENT_LIMITS.filenameChars);
	const chunks: SemanticAttachmentChunk[] = [];
	let start = 0;
	const minimumAdvance =
		SEMANTIC_ATTACHMENT_LIMITS.chunkChars -
		SEMANTIC_ATTACHMENT_LIMITS.chunkOverlapChars;
	while (
		start < text.length &&
		chunks.length < SEMANTIC_ATTACHMENT_LIMITS.chunksPerAttachment
	) {
		const hardEnd = Math.min(
			start + SEMANTIC_ATTACHMENT_LIMITS.chunkChars,
			text.length,
		);
		const minimumEnd = Math.min(start + minimumAdvance, hardEnd);
		let end = hardEnd;
		if (
			end < text.length &&
			/^[\uD800-\uDBFF]$/.test(text[end - 1] ?? "") &&
			/^[\uDC00-\uDFFF]$/.test(text[end] ?? "")
		) end -= 1;
		if (end < text.length) {
			const boundary = text.lastIndexOf(" ", end);
			if (boundary >= minimumEnd) end = boundary;
			let clusterBoundary = end;
			while (clusterBoundary > start && isCombiningMarkAt(text, clusterBoundary)) {
				clusterBoundary = previousScalarStart(text, clusterBoundary);
			}
			if (clusterBoundary >= minimumEnd) end = clusterBoundary;
		}
		const excerpt = text.slice(start, end).trim().replace(/^\p{M}+/u, "");
		if (excerpt) {
			chunks.push({
				ordinal: chunks.length,
				embeddingText: safeFilename ? `Attachment: ${safeFilename}\n${excerpt}` : excerpt,
				excerpt,
			});
		}
		if (end >= text.length) break;
		const minimumNextStart = Math.min(start + minimumAdvance, end);
		let nextStart = Math.max(
			end - SEMANTIC_ATTACHMENT_LIMITS.chunkOverlapChars,
			minimumNextStart,
		);
		if (
			/^[\uDC00-\uDFFF]$/.test(text[nextStart] ?? "") &&
			/^[\uD800-\uDBFF]$/.test(text[nextStart - 1] ?? "")
		) {
			nextStart = nextStart - 1 >= minimumNextStart
				? nextStart - 1
				: nextStart + 1;
		}
		while (nextStart < text.length && isCombiningMarkAt(text, nextStart)) {
			nextStart += scalarWidthAt(text, nextStart);
		}
		start = Math.max(nextStart, start + 1);
	}
	return chunks;
}

export function semanticAttachmentVectorId(sourceToken: string, ordinal: number): string {
	if (!/^[a-f0-9]{32}$/.test(sourceToken)) {
		throw new Error("Semantic attachment source token is invalid");
	}
	if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 100) {
		throw new Error("Semantic attachment chunk ordinal is invalid");
	}
	return `sa1_${sourceToken}_${ordinal.toString(36).padStart(2, "0")}`;
}

export async function semanticAttachmentFingerprint(input: {
	bytes: ArrayBuffer;
	format: SemanticAttachmentFormat;
}): Promise<{ byteSha256: string; sourceFingerprint: string }> {
	const byteDigest = await crypto.subtle.digest("SHA-256", input.bytes);
	const byteSha256 = Array.from(new Uint8Array(byteDigest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const canonical = JSON.stringify({
		policyVersion: SEMANTIC_ATTACHMENT_POLICY_VERSION,
		extractionVersion: SEMANTIC_ATTACHMENT_EXTRACTION_VERSION,
		chunkVersion: SEMANTIC_ATTACHMENT_CHUNK_VERSION,
		format: input.format,
		byteSha256,
	});
	const sourceDigest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical),
	);
	return {
		byteSha256,
		sourceFingerprint: Array.from(new Uint8Array(sourceDigest), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join(""),
	};
}
