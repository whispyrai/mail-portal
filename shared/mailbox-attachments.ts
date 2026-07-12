export const ATTACHMENT_KINDS = [
	"image",
	"pdf",
	"document",
	"spreadsheet",
	"presentation",
	"archive",
	"other",
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export interface MailboxAttachmentItem {
	id: string;
	emailId: string;
	filename: string;
	mimetype: string;
	size: number;
	kind: AttachmentKind;
	message: {
		subject: string;
		sender: string;
		date: string;
		folderId: string;
		folderName: string;
	};
}

export interface MailboxAttachmentPage {
	items: MailboxAttachmentItem[];
	nextCursor: string | null;
}

export type MailboxAttachmentQueryErrorCode = "INVALID_QUERY" | "QUERY_TOO_LARGE";

export class MailboxAttachmentQueryError extends Error {
	readonly code: MailboxAttachmentQueryErrorCode;

	constructor(code: MailboxAttachmentQueryErrorCode, message: string) {
		super(message);
		this.name = "MailboxAttachmentQueryError";
		this.code = code;
	}
}

export interface MailboxAttachmentFilterInput {
	q?: string | null;
	kind?: AttachmentKind | null;
	folder?: string | null;
}

export interface MailboxAttachmentCursorPosition {
	date: string;
	emailId: string;
	attachmentId: string;
}

export interface NormalizedMailboxAttachmentListOptions {
	limit: number;
	q: string | null;
	kind: AttachmentKind | null;
	folder: string | null;
	cursor: MailboxAttachmentCursorPosition | null;
}

const UTF8 = new TextEncoder();
const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
export const MAILBOX_ATTACHMENT_LIMITS = {
	likePatternBytes: 50,
	cursorChars: 2_048,
	identifierChars: 300,
	folderChars: 200,
	cursorDateChars: 64,
} as const;

const MIME_BY_KIND: Record<Exclude<AttachmentKind, "other">, readonly string[]> = {
	image: [
		"image/avif",
		"image/bmp",
		"image/gif",
		"image/heic",
		"image/heif",
		"image/jpeg",
		"image/png",
		"image/svg+xml",
		"image/tiff",
		"image/webp",
	],
	pdf: ["application/pdf"],
	document: [
		"application/msword",
		"application/rtf",
		"application/vnd.oasis.opendocument.text",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"text/plain",
		"text/rtf",
	],
	spreadsheet: [
		"application/vnd.ms-excel",
		"application/vnd.oasis.opendocument.spreadsheet",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"text/csv",
	],
	presentation: [
		"application/vnd.ms-powerpoint",
		"application/vnd.oasis.opendocument.presentation",
		"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	],
	archive: [
		"application/gzip",
		"application/vnd.rar",
		"application/x-7z-compressed",
		"application/x-bzip2",
		"application/x-rar-compressed",
		"application/x-tar",
		"application/zip",
	],
};

const EXTENSIONS_BY_KIND: Record<Exclude<AttachmentKind, "other">, readonly string[]> = {
	image: ["avif", "bmp", "gif", "heic", "heif", "jpeg", "jpg", "png", "svg", "tif", "tiff", "webp"],
	pdf: ["pdf"],
	document: ["doc", "docx", "odt", "rtf", "txt"],
	spreadsheet: ["csv", "ods", "xls", "xlsx"],
	presentation: ["odp", "ppt", "pptx"],
	archive: ["7z", "bz2", "gz", "rar", "tar", "tgz", "zip"],
};

function invalid(message: string): never {
	throw new MailboxAttachmentQueryError("INVALID_QUERY", message);
}

function one(params: URLSearchParams, key: string): string | null {
	const values = params.getAll(key);
	if (values.length > 1) invalid(`${key} cannot be repeated`);
	return values[0] ?? null;
}

function baseMime(value: string): string {
	return value.split(";", 1)[0]!.trim().toLowerCase();
}

function extension(filename: string): string {
	const match = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
	return match?.[1] ?? "";
}

export function classifyMailboxAttachment(filename: string, mimetype: string): AttachmentKind {
	const mime = baseMime(mimetype);
	for (const kind of ATTACHMENT_KINDS) {
		if (kind !== "other" && MIME_BY_KIND[kind].includes(mime)) return kind;
	}
	const ext = extension(filename);
	for (const kind of ATTACHMENT_KINDS) {
		if (kind !== "other" && EXTENSIONS_BY_KIND[kind].includes(ext)) return kind;
	}
	return "other";
}

export function mailboxAttachmentFilenameLikePattern(value: string): string {
	const pattern = `%${value.replace(/[\\%_]/g, "\\$&")}%`;
	if (UTF8.encode(pattern).byteLength > MAILBOX_ATTACHMENT_LIMITS.likePatternBytes) {
		throw new MailboxAttachmentQueryError(
			"QUERY_TOO_LARGE",
			`Attachment filename search cannot exceed the ${MAILBOX_ATTACHMENT_LIMITS.likePatternBytes}-byte query boundary`,
		);
	}
	return pattern;
}

function normalizedFilters(filters: MailboxAttachmentFilterInput) {
	return {
		q: filters.q ?? null,
		kind: filters.kind ?? null,
		folder: filters.folder ?? null,
	};
}

export function mailboxAttachmentFilterFingerprint(filters: MailboxAttachmentFilterInput): string {
	const value = normalizedFilters(filters);
	return JSON.stringify([value.q, value.kind, value.folder]);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
	const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeMailboxAttachmentCursor(
	position: MailboxAttachmentCursorPosition,
	filters: MailboxAttachmentFilterInput,
): string {
	return bytesToBase64Url(UTF8.encode(JSON.stringify({
		v: 1,
		d: position.date,
		e: position.emailId,
		a: position.attachmentId,
		f: mailboxAttachmentFilterFingerprint(filters),
	})));
}

export function decodeMailboxAttachmentCursor(
	value: string,
	filters: MailboxAttachmentFilterInput,
): MailboxAttachmentCursorPosition {
	if (!value || value.length > MAILBOX_ATTACHMENT_LIMITS.cursorChars || !/^[A-Za-z0-9_-]+$/.test(value)) {
		invalid("Attachment cursor is invalid");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(UTF8_FATAL.decode(base64UrlToBytes(value)));
	} catch {
		invalid("Attachment cursor is invalid");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		invalid("Attachment cursor is invalid");
	}
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "a,d,e,f,v" ||
		record.v !== 1 ||
		typeof record.d !== "string" || record.d.length > MAILBOX_ATTACHMENT_LIMITS.cursorDateChars ||
		typeof record.e !== "string" || !record.e || record.e.length > MAILBOX_ATTACHMENT_LIMITS.identifierChars ||
		typeof record.a !== "string" || !record.a || record.a.length > MAILBOX_ATTACHMENT_LIMITS.identifierChars ||
		typeof record.f !== "string" ||
		record.f !== mailboxAttachmentFilterFingerprint(filters)
	) invalid("Attachment cursor is invalid or does not match these filters");
	const position = { date: record.d, emailId: record.e, attachmentId: record.a };
	if (encodeMailboxAttachmentCursor(position, filters) !== value) {
		invalid("Attachment cursor is not canonical");
	}
	return position;
}

export function normalizeMailboxAttachmentListQuery(
	params: URLSearchParams,
): NormalizedMailboxAttachmentListOptions {
	for (const key of params.keys()) {
		if (!new Set(["limit", "cursor", "q", "kind", "folder"]).has(key)) {
			invalid(`Unsupported attachment query parameter: ${key}`);
		}
	}
	const rawLimit = one(params, "limit");
	const limit = rawLimit === null ? 25 : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
		invalid("limit must be a whole number from 1 through 50");
	}
	const rawQuery = one(params, "q")?.trim().normalize("NFC") ?? "";
	const q = rawQuery || null;
	if (q) mailboxAttachmentFilenameLikePattern(q);
	const rawKind = one(params, "kind")?.trim().toLowerCase() ?? "";
	if (rawKind && !ATTACHMENT_KINDS.includes(rawKind as AttachmentKind)) {
		invalid("kind is not supported");
	}
	const kind = (rawKind || null) as AttachmentKind | null;
	const rawFolder = one(params, "folder")?.trim() ?? "";
	if (rawFolder.length > MAILBOX_ATTACHMENT_LIMITS.folderChars) invalid("folder is too long");
	const folder = rawFolder || null;
	const rawCursor = one(params, "cursor");
	const filters = { q, kind, folder };
	return {
		limit,
		...filters,
		cursor: rawCursor === null ? null : decodeMailboxAttachmentCursor(rawCursor, filters),
	};
}

export function validateNormalizedMailboxAttachmentListOptions(
	value: unknown,
): NormalizedMailboxAttachmentListOptions {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid("Attachment list options are invalid");
	}
	const record = value as Record<string, unknown>;
	if (Object.keys(record).sort().join(",") !== "cursor,folder,kind,limit,q") {
		invalid("Attachment list options are invalid");
	}
	if (!Number.isInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > 50) {
		invalid("Attachment list limit is invalid");
	}
	if (record.q !== null && typeof record.q !== "string") invalid("Attachment filename query is invalid");
	const q = record.q as string | null;
	if (q !== null) {
		if (!q || q !== q.trim().normalize("NFC")) invalid("Attachment filename query is not normalized");
		mailboxAttachmentFilenameLikePattern(q);
	}
	if (record.kind !== null && (
		typeof record.kind !== "string" || !ATTACHMENT_KINDS.includes(record.kind as AttachmentKind)
	)) invalid("Attachment kind is invalid");
	if (record.folder !== null && (
		typeof record.folder !== "string" || !record.folder ||
		record.folder !== record.folder.trim() || record.folder.length > MAILBOX_ATTACHMENT_LIMITS.folderChars
	)) invalid("Attachment folder is invalid");
	let cursor: MailboxAttachmentCursorPosition | null = null;
	if (record.cursor !== null) {
		if (!record.cursor || typeof record.cursor !== "object" || Array.isArray(record.cursor)) {
			invalid("Attachment cursor position is invalid");
		}
		const candidate = record.cursor as Record<string, unknown>;
		if (
			Object.keys(candidate).sort().join(",") !== "attachmentId,date,emailId" ||
			typeof candidate.date !== "string" || candidate.date.length > MAILBOX_ATTACHMENT_LIMITS.cursorDateChars ||
			typeof candidate.emailId !== "string" || !candidate.emailId || candidate.emailId.length > MAILBOX_ATTACHMENT_LIMITS.identifierChars ||
			typeof candidate.attachmentId !== "string" || !candidate.attachmentId || candidate.attachmentId.length > MAILBOX_ATTACHMENT_LIMITS.identifierChars
		) invalid("Attachment cursor position is invalid");
		cursor = {
			date: candidate.date,
			emailId: candidate.emailId,
			attachmentId: candidate.attachmentId,
		};
	}
	return {
		limit: Number(record.limit),
		q,
		kind: record.kind as AttachmentKind | null,
		folder: record.folder as string | null,
		cursor,
	};
}

function quotedSqlList(values: readonly string[]): string {
	return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

/** SQLite CASE expression whose result is intentionally pinned to the shared classifier. */
export function mailboxAttachmentKindSql(alias = "a"): string {
	const mime = `lower(trim(CASE WHEN instr(COALESCE(${alias}.mimetype, ''), ';') > 0 THEN substr(COALESCE(${alias}.mimetype, ''), 1, instr(COALESCE(${alias}.mimetype, ''), ';') - 1) ELSE COALESCE(${alias}.mimetype, '') END))`;
	const filename = `lower(trim(COALESCE(${alias}.filename, '')))`;
	const clauses: string[] = [];
	for (const kind of ATTACHMENT_KINDS) {
		if (kind === "other") continue;
		clauses.push(`WHEN ${mime} IN (${quotedSqlList(MIME_BY_KIND[kind])}) THEN '${kind}'`);
	}
	for (const kind of ATTACHMENT_KINDS) {
		if (kind === "other") continue;
		const extensions = EXTENSIONS_BY_KIND[kind]
			.map((value) => `${filename} LIKE '%.${value}'`)
			.join(" OR ");
		clauses.push(`WHEN (${extensions}) THEN '${kind}'`);
	}
	return `(CASE ${clauses.join(" ")} ELSE 'other' END)`;
}

export const MAILBOX_ATTACHMENT_PREVIEW_MIME_TYPES = new Set([
	"application/pdf",
	"image/avif",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);

export function isMailboxAttachmentPreviewMimeType(mimetype: string): boolean {
	return MAILBOX_ATTACHMENT_PREVIEW_MIME_TYPES.has(baseMime(mimetype));
}

const PREVIEW_EXTENSIONS_BY_MIME: Readonly<Record<string, readonly string[]>> = {
	"application/pdf": ["pdf"],
	"image/avif": ["avif"],
	"image/gif": ["gif"],
	"image/jpeg": ["jpeg", "jpg"],
	"image/png": ["png"],
	"image/webp": ["webp"],
};

/** Strict preview admission requires both an allowlisted MIME and matching extension. */
export function isMailboxAttachmentPreviewable(
	filename: string,
	mimetype: string,
): boolean {
	const mime = baseMime(mimetype);
	return PREVIEW_EXTENSIONS_BY_MIME[mime]?.includes(extension(filename)) ?? false;
}
