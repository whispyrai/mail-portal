import {
	MAIL_SEARCH_LIMITS,
	parseSearchQuery,
	type ParsedSearch,
} from "./mail-search.ts";

export const AI_SEARCH_INTERPRETER_LIMITS = {
	requestBytes: 2_048,
	intentChars: 500,
	intentBytes: 2_000,
	timezoneChars: 100,
	modelSystemChars: 4_000,
	modelUntrustedChars: 36_000,
	modelSerializedBytes: 40_000,
	modelOutputBytes: 8_000,
	modelValuesPerField: 8,
	catalogEntries: 50,
	catalogIdChars: 128,
	catalogNameChars: 100,
} as const;

export const AI_SEARCH_INTERPRETER_STATES = [
	"generated",
	"cached",
	"ambiguous",
	"unsupported",
	"budget_paused",
	"stale",
] as const;

export type AiSearchInterpreterState =
	(typeof AI_SEARCH_INTERPRETER_STATES)[number];

export interface AiSearchInterpreterRequest {
	intent: string;
	timezone: string;
}

export interface AiSearchFilters {
	terms: string[];
	phrases: string[];
	from: string[];
	to: string[];
	subject: string[];
	filename: string[];
	folders: string[];
	isRead: boolean | null;
	isStarred: boolean | null;
	hasAttachment: boolean;
	after: string | null;
	before: string | null;
}

export type AiSearchInterpreterReadyResponse = {
	state: "generated" | "cached";
	query: string;
	labelId: string | null;
	filters: AiSearchFilters;
	requiresReview: true;
};

export type AiSearchInterpreterResponse =
	| AiSearchInterpreterReadyResponse
	| { state: "ambiguous" | "unsupported" | "budget_paused" | "stale" };

const encoder = new TextEncoder();
const UNSAFE_TEXT =
	/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function containsUnsafeAiSearchText(value: string): boolean {
	return UNSAFE_TEXT.test(value);
}

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizedIntent(value: unknown): string {
	if (typeof value !== "string") throw new Error("Search intent is required");
	const intent = value.normalize("NFC").replace(/\s+/gu, " ").trim();
	if (
		!intent ||
		containsUnsafeAiSearchText(intent) ||
		Array.from(intent).length > AI_SEARCH_INTERPRETER_LIMITS.intentChars ||
		byteLength(intent) > AI_SEARCH_INTERPRETER_LIMITS.intentBytes
	) {
		throw new Error("Search intent is invalid");
	}
	return intent;
}

function normalizedTimezone(value: unknown): string {
	if (typeof value !== "string") throw new Error("Search timezone is required");
	const timezone = value.trim();
	if (
		!timezone ||
		timezone !== value ||
		containsUnsafeAiSearchText(timezone) ||
		timezone.length > AI_SEARCH_INTERPRETER_LIMITS.timezoneChars
	) {
		throw new Error("Search timezone is invalid");
	}
	try {
		return new Intl.DateTimeFormat("en-US", { timeZone: timezone })
			.resolvedOptions().timeZone;
	} catch {
		throw new Error("Search timezone is invalid");
	}
}

export function parseAiSearchInterpreterRequest(
	value: unknown,
): AiSearchInterpreterRequest {
	if (!isRecord(value) || !hasExactKeys(value, ["intent", "timezone"])) {
		throw new Error("Search interpretation request is invalid");
	}
	return {
		intent: normalizedIntent(value.intent),
		timezone: normalizedTimezone(value.timezone),
	};
}

function canonicalDate(value: unknown, label: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
		throw new Error(`${label} is invalid`);
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function canonicalValues(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length > AI_SEARCH_INTERPRETER_LIMITS.modelValuesPerField) {
		throw new Error(`${label} is invalid`);
	}
	const seen = new Set<string>();
	const values: string[] = [];
	for (const item of value) {
		if (
			typeof item !== "string" ||
			!item ||
			item !== item.trim() ||
			item !== item.normalize("NFC") ||
			containsUnsafeAiSearchText(item) ||
			Array.from(item).length > MAIL_SEARCH_LIMITS.tokenChars ||
			byteLength(item) > MAIL_SEARCH_LIMITS.tokenChars * 4
		) {
			throw new Error(`${label} is invalid`);
		}
		if (!seen.has(item)) {
			seen.add(item);
			values.push(item);
		} else {
			throw new Error(`${label} contains duplicate values`);
		}
	}
	return values;
}

const FILTER_KEYS = [
	"terms",
	"phrases",
	"from",
	"to",
	"subject",
	"filename",
	"folders",
	"isRead",
	"isStarred",
	"hasAttachment",
	"after",
	"before",
] as const;

export function parseAiSearchFilters(value: unknown): AiSearchFilters {
	if (!isRecord(value) || !hasExactKeys(value, FILTER_KEYS)) {
		throw new Error("Search filters are invalid");
	}
	const isRead = value.isRead;
	const isStarred = value.isStarred;
	if (isRead !== null && typeof isRead !== "boolean") {
		throw new Error("Read filter is invalid");
	}
	if (isStarred !== null && typeof isStarred !== "boolean") {
		throw new Error("Starred filter is invalid");
	}
	if (typeof value.hasAttachment !== "boolean") {
		throw new Error("Attachment filter is invalid");
	}
	const filters: AiSearchFilters = {
		terms: canonicalValues(value.terms, "Search terms"),
		phrases: canonicalValues(value.phrases, "Search phrases"),
		from: canonicalValues(value.from, "Sender filters"),
		to: canonicalValues(value.to, "Recipient filters"),
		subject: canonicalValues(value.subject, "Subject filters"),
		filename: canonicalValues(value.filename, "Filename filters"),
		folders: canonicalValues(value.folders, "Folder filters"),
		isRead,
		isStarred,
		hasAttachment: value.hasAttachment,
		after: canonicalDate(value.after, "After date"),
		before: canonicalDate(value.before, "Before date"),
	};
	if (filters.after && filters.before && filters.after >= filters.before) {
		throw new Error("Search date range is invalid");
	}
	return filters;
}

function quoted(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function filterToken(operator: string, value: string): string {
	return `${operator}:${/\s|["\\]/u.test(value) ? quoted(value) : value}`;
}

export function serializeAiSearchFilters(
	value: unknown,
	options: { allowEmpty?: boolean } = {},
): string {
	const filters = parseAiSearchFilters(value);
	if (filters.terms.some((term) => /\s|[":\\]/u.test(term))) {
		throw new Error("Search terms must be single plain tokens");
	}
	const tokens = [
		...filters.terms,
		...filters.phrases.map(quoted),
		...filters.from.map((item) => filterToken("from", item)),
		...filters.to.map((item) => filterToken("to", item)),
		...filters.subject.map((item) => filterToken("subject", item)),
		...filters.filename.map((item) => filterToken("filename", item)),
		...filters.folders.map((item) => filterToken("in", item)),
		...(filters.isRead === null ? [] : [`is:${filters.isRead ? "read" : "unread"}`]),
		...(filters.isStarred === null
			? []
			: [`is:${filters.isStarred ? "starred" : "unstarred"}`]),
		...(filters.hasAttachment ? ["has:attachment"] : []),
		...(filters.after ? [`after:${filters.after}`] : []),
		...(filters.before ? [`before:${filters.before}`] : []),
	];
	const query = tokens.join(" ");
	if ((!query && !options.allowEmpty) || query.length > MAIL_SEARCH_LIMITS.queryChars) {
		throw new Error("Interpreted search is empty or too large");
	}
	if (query) parseSearchQuery(query);
	return query;
}

function parsedFiltersMatch(filters: AiSearchFilters, parsed: ParsedSearch): boolean {
	return JSON.stringify({
		terms: parsed.terms,
		phrases: parsed.phrases,
		from: parsed.from ?? [],
		to: parsed.to ?? [],
		subject: parsed.subject ?? [],
		filename: parsed.filename ?? [],
		folders: parsed.folder ?? [],
		isRead: parsed.is_read ?? null,
		isStarred: parsed.is_starred ?? null,
		hasAttachment: parsed.has_attachment ?? false,
		after: parsed.date_start?.slice(0, 10) ?? null,
		before: parsed.date_end?.slice(0, 10) ?? null,
	}) === JSON.stringify(filters);
}

export function parseAiSearchInterpreterResponse(
	value: unknown,
): AiSearchInterpreterResponse {
	if (!isRecord(value) || typeof value.state !== "string") {
		throw new Error("Search interpretation response is invalid");
	}
	if (["ambiguous", "unsupported", "budget_paused", "stale"].includes(value.state)) {
		if (!hasExactKeys(value, ["state"])) {
			throw new Error("Search interpretation response is invalid");
		}
		return value as AiSearchInterpreterResponse;
	}
	if (
		(value.state !== "generated" && value.state !== "cached") ||
		!hasExactKeys(value, ["state", "query", "labelId", "filters", "requiresReview"]) ||
		typeof value.query !== "string" ||
		value.query !== value.query.trim() ||
		value.query.length > MAIL_SEARCH_LIMITS.queryChars ||
		(value.labelId !== null &&
			(typeof value.labelId !== "string" ||
				!value.labelId ||
				value.labelId !== value.labelId.trim() ||
				value.labelId !== value.labelId.normalize("NFC") ||
				containsUnsafeAiSearchText(value.labelId) ||
				value.labelId.length > AI_SEARCH_INTERPRETER_LIMITS.catalogIdChars ||
				byteLength(value.labelId) >
					AI_SEARCH_INTERPRETER_LIMITS.catalogIdChars * 4)) ||
		value.requiresReview !== true
	) {
		throw new Error("Search interpretation response is invalid");
	}
	const filters = parseAiSearchFilters(value.filters);
	const canonicalQuery = serializeAiSearchFilters(filters, {
		allowEmpty: value.labelId !== null,
	});
	const parsed = parseSearchQuery(value.query);
	if (value.query !== canonicalQuery || !parsedFiltersMatch(filters, parsed)) {
		throw new Error("Search interpretation response is inconsistent");
	}
	return {
		state: value.state,
		query: canonicalQuery,
		labelId: value.labelId,
		filters,
		requiresReview: true,
	};
}
