import { decodeBase64Url } from "./base64url.ts";

export const MAILBOX_CHANGE_LIMITS = {
	cursorChars: 256,
	defaultPageSize: 100,
	maxPageSize: 100,
	identifierChars: 700,
	committedAtChars: 64,
} as const;

export const MAILBOX_CHANGE_RESOURCES = [
	"message",
	"attachment",
	"folder",
	"label",
	"message_label",
	"delivery",
	"delivery_attempt",
	"automation_rule",
	"automation_run",
] as const;

export const MAILBOX_CHANGE_OPERATIONS = ["created", "updated", "deleted"] as const;

export type MailboxChangeResource = (typeof MAILBOX_CHANGE_RESOURCES)[number];
export type MailboxChangeOperation = (typeof MAILBOX_CHANGE_OPERATIONS)[number];

export interface MailboxChange {
	sequence: number;
	schemaVersion: 1;
	committedAt: string;
	resource: MailboxChangeResource;
	entityId: string;
	parentId: string | null;
	operation: MailboxChangeOperation;
}

export interface MailboxChangePage {
	changes: MailboxChange[];
	nextCursor: string;
}

export type MailboxChangeQueryErrorCode = "INVALID_QUERY";

export class MailboxChangeQueryError extends Error {
	readonly code: MailboxChangeQueryErrorCode;

	constructor(message: string) {
		super(message);
		this.name = "MailboxChangeQueryError";
		this.code = "INVALID_QUERY";
	}
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalidCursor(): never {
	throw new MailboxChangeQueryError("Mailbox change cursor is invalid");
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function encodeMailboxChangeCursor(sequence: number): string {
	if (!Number.isSafeInteger(sequence) || sequence < 0) invalidCursor();
	return encodeBase64Url(encoder.encode(JSON.stringify({ v: 1, s: sequence })));
}

export function decodeMailboxChangeCursor(value: string): number {
	if (
		!value ||
		value.length > MAILBOX_CHANGE_LIMITS.cursorChars ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) invalidCursor();
	const bytes = decodeBase64Url(value);
	if (!bytes) invalidCursor();
	let parsed: unknown;
	try {
		parsed = JSON.parse(decoder.decode(bytes));
	} catch {
		invalidCursor();
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidCursor();
	const record = parsed as Record<string, unknown>;
	if (
		Object.keys(record).join(",") !== "v,s" ||
		record.v !== 1 ||
		!Number.isSafeInteger(record.s) ||
		Number(record.s) < 0
	) invalidCursor();
	const sequence = Number(record.s);
	if (encodeMailboxChangeCursor(sequence) !== value) invalidCursor();
	return sequence;
}

export interface NormalizedMailboxChangeQuery {
	after: number | null;
	limit: number;
}

export function validateNormalizedMailboxChangeQuery(
	value: unknown,
): NormalizedMailboxChangeQuery {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new MailboxChangeQueryError("Mailbox change query is invalid");
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "after,limit" ||
		(record.after !== null &&
			(!Number.isSafeInteger(record.after) || Number(record.after) < 0)) ||
		!Number.isSafeInteger(record.limit) ||
		Number(record.limit) < 1 ||
		Number(record.limit) > MAILBOX_CHANGE_LIMITS.maxPageSize
	) {
		throw new MailboxChangeQueryError("Mailbox change query is invalid");
	}
	return {
		after: record.after === null ? null : Number(record.after),
		limit: Number(record.limit),
	};
}

function one(params: URLSearchParams, key: string): string | null {
	const values = params.getAll(key);
	if (values.length > 1) {
		throw new MailboxChangeQueryError(`${key} cannot be repeated`);
	}
	return values[0] ?? null;
}

export function normalizeMailboxChangeQuery(
	params: URLSearchParams,
): NormalizedMailboxChangeQuery {
	for (const key of params.keys()) {
		if (key !== "after" && key !== "limit") {
			throw new MailboxChangeQueryError(`Unsupported mailbox change query parameter: ${key}`);
		}
	}
	const rawLimit = one(params, "limit");
	if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) {
		throw new MailboxChangeQueryError("limit must be a whole number from 1 through 100");
	}
	const limit = rawLimit === null
		? MAILBOX_CHANGE_LIMITS.defaultPageSize
		: Number(rawLimit);
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAILBOX_CHANGE_LIMITS.maxPageSize) {
		throw new MailboxChangeQueryError("limit must be a whole number from 1 through 100");
	}
	const rawAfter = one(params, "after");
	return validateNormalizedMailboxChangeQuery({
		after: rawAfter === null ? null : decodeMailboxChangeCursor(rawAfter),
		limit,
	});
}

function invalidPage(): never {
	throw new MailboxChangeQueryError("Mailbox change page is invalid");
}

function identifier(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim().normalize("NFC") ||
		/[\u0000-\u001F\u007F]/u.test(value) ||
		Array.from(value).length > MAILBOX_CHANGE_LIMITS.identifierChars
	) invalidPage();
	return value;
}

function canonicalCommittedAt(value: unknown): string {
	if (typeof value !== "string" || value.length > MAILBOX_CHANGE_LIMITS.committedAtChars) {
		invalidPage();
	}
	const timestamp = new Date(value);
	if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) invalidPage();
	return value;
}

function validateMailboxChange(value: unknown): MailboxChange {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidPage();
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !==
			"committedAt,entityId,operation,parentId,resource,schemaVersion,sequence" ||
		!Number.isSafeInteger(record.sequence) ||
		Number(record.sequence) < 1 ||
		record.schemaVersion !== 1 ||
		typeof record.resource !== "string" ||
		!MAILBOX_CHANGE_RESOURCES.includes(record.resource as MailboxChangeResource) ||
		typeof record.operation !== "string" ||
		!MAILBOX_CHANGE_OPERATIONS.includes(record.operation as MailboxChangeOperation)
	) invalidPage();
	return {
		sequence: Number(record.sequence),
		schemaVersion: 1,
		committedAt: canonicalCommittedAt(record.committedAt),
		resource: record.resource as MailboxChangeResource,
		entityId: identifier(record.entityId),
		parentId: record.parentId === null ? null : identifier(record.parentId),
		operation: record.operation as MailboxChangeOperation,
	};
}

export function validateMailboxChangePage(
	value: unknown,
	expectedAfter: number | null,
): MailboxChangePage {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidPage();
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "changes,nextCursor" ||
		!Array.isArray(record.changes) ||
		record.changes.length > MAILBOX_CHANGE_LIMITS.maxPageSize ||
		typeof record.nextCursor !== "string"
	) invalidPage();
	const changes = record.changes.map(validateMailboxChange);
	if (expectedAfter === null && changes.length > 0) invalidPage();
	let previous = expectedAfter ?? 0;
	for (const change of changes) {
		if (change.sequence <= previous) invalidPage();
		previous = change.sequence;
	}
	const nextSequence = decodeMailboxChangeCursor(record.nextCursor);
	if (changes.length > 0) {
		if (nextSequence !== changes[changes.length - 1]!.sequence) invalidPage();
	} else if (expectedAfter !== null && nextSequence !== expectedAfter) {
		invalidPage();
	}
	return { changes, nextCursor: record.nextCursor };
}
