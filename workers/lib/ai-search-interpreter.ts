import { z } from "zod";
import {
	AI_SEARCH_INTERPRETER_LIMITS,
	containsUnsafeAiSearchText,
	parseAiSearchFilters,
	parseAiSearchInterpreterResponse,
	serializeAiSearchFilters,
	type AiSearchFilters,
	type AiSearchInterpreterResponse,
} from "../../shared/ai-search-interpreter.ts";
import { wrapUntrustedAiContext } from "../../shared/ai-untrusted-context.ts";
import { parseSearchQuery } from "../../shared/mail-search.ts";
import { buildAiCacheKey } from "./ai-cost-control.ts";
import { buildMailSearchPlan } from "./mail-search.ts";

export const AI_SEARCH_INTERPRETER_AI_CONFIG = {
	feature: "search_interpreter",
	requestedTier: "cheap",
	promptVersion: "ai-search-interpreter-v1",
	sourceVersion: "search-v2-folder-label-catalog-v1",
	estimatedCostMicros: 5_000,
	maxTokens: 700,
	temperature: 0,
} as const;

export type AiSearchCatalogEntry = { id: string; name: string };
export type AiSearchCatalog = {
	folders: AiSearchCatalogEntry[];
	labels: AiSearchCatalogEntry[];
};

export type AiSearchCatalogSnapshot = {
	catalog: AiSearchCatalog;
	fingerprint: string;
};

export type AiSearchInterpreterModelMessage = {
	role: "system" | "user";
	content: string;
};

export type AiSearchInterpreterModelOutput =
	| { status: "ambiguous" | "unsupported" }
	| { status: "ready"; filters: AiSearchFilters; labelId: string | null };

export type ParsedAiSearchInterpreterModelOutput = {
	modelOutput: AiSearchInterpreterModelOutput;
	response: Exclude<AiSearchInterpreterResponse, { state: "budget_paused" | "stale" }>;
};

const encoder = new TextEncoder();
const ACTIVE_MARKUP =
	/<\/?[a-z][^>\n]*>|(?:^|\s)[#*_`]{1,3}\S|(?:^|\n)\s{0,3}(?:[-+*]\s|\d+\.\s|>\s|```|~~~)|\[[^\]\n]+\]\([^\)\n]+\)/im;

function byteLength(value: string): number {
	return encoder.encode(value).byteLength;
}

function boundedCatalogText(
	value: unknown,
	label: string,
	maxChars: number,
	options: { identifier?: boolean } = {},
): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value !== value.normalize("NFC") ||
		containsUnsafeAiSearchText(value) ||
		ACTIVE_MARKUP.test(value) ||
		(options.identifier && !/^[A-Za-z0-9._-]+$/u.test(value)) ||
		Array.from(value).length > maxChars ||
		byteLength(value) > maxChars * 4
	) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function catalogEntries(value: unknown, label: string): AiSearchCatalogEntry[] {
	if (!Array.isArray(value)) throw new Error(`${label} catalog is invalid`);
	const entries = value.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`${label} catalog is invalid`);
		}
		const record = entry as Record<string, unknown>;
		return {
			id: boundedCatalogText(
				record.id,
				`${label} ID`,
				AI_SEARCH_INTERPRETER_LIMITS.catalogIdChars,
				{ identifier: true },
			),
			name: boundedCatalogText(
				record.name,
				`${label} name`,
				AI_SEARCH_INTERPRETER_LIMITS.catalogNameChars,
			),
		};
	});
	if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
		throw new Error(`${label} catalog contains duplicate IDs`);
	}
	return entries.sort((left, right) => {
		if (left.id !== right.id) return left.id < right.id ? -1 : 1;
		if (left.name === right.name) return 0;
		return left.name < right.name ? -1 : 1;
	});
}

export function normalizeAiSearchCatalog(value: unknown): AiSearchCatalog {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Search catalog is invalid");
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length !== 2 ||
		!("folders" in record) ||
		!("labels" in record)
	) {
		throw new Error("Search catalog is invalid");
	}
	const catalog = {
		folders: catalogEntries(record.folders, "Folder"),
		labels: catalogEntries(record.labels, "Label"),
	};
	if (
		catalog.folders.length + catalog.labels.length >
		AI_SEARCH_INTERPRETER_LIMITS.catalogEntries
	) {
		throw new Error("Search catalog exceeds its safe bound");
	}
	return catalog;
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export async function snapshotAiSearchCatalog(
	value: unknown,
): Promise<AiSearchCatalogSnapshot> {
	const catalog = normalizeAiSearchCatalog(value);
	return {
		catalog,
		fingerprint: `asic:v1:${await sha256(JSON.stringify({ version: 1, catalog }))}`,
	};
}

export function localDateForTimezone(now: number, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date(now));
	const values = new Map(parts.map((part) => [part.type, part.value]));
	const date = `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error("Search local date is unavailable");
	}
	return date;
}

const SYSTEM_POLICY = `You translate one user's ordinary-language mail search intent into the existing deterministic Search v2 filters. You never search mail, call tools, infer facts from mail, mutate anything, or claim a search ran.

The only supported filters are literal free terms, exact phrases, sender, recipient, subject, attachment filename, one of the supplied folder IDs, one supplied label ID, read or unread, starred or unstarred, has attachment, and explicit after/before calendar dates. Multiple free terms are AND, not synonyms. Repeated values within sender, recipient, subject, filename, or folder are OR. Do not add synonyms or hidden constraints. Convert relative dates using only supplied localDate and timezone. Requests for semantic similarity, importance, sentiment, summaries, actions, external systems, negative attachment state, or anything not exactly expressible are unsupported. Use ambiguous only when multiple materially different supported interpretations remain.

Return JSON only. It must be exactly one of:
{"status":"ambiguous"}
{"status":"unsupported"}
{"status":"ready","filters":{"terms":[string],"phrases":[string],"from":[string],"to":[string],"subject":[string],"filename":[string],"folders":[folderId],"isRead":boolean|null,"isStarred":boolean|null,"hasAttachment":boolean,"after":"YYYY-MM-DD"|null,"before":"YYYY-MM-DD"|null},"labelId":labelId|null}

Use only exact supplied folder and label IDs. A ready result must contain at least one Search v2 filter or one supplied label ID. No explanations, markdown, HTML, or extra fields.`;

export function buildAiSearchInterpreterModelMessages(input: {
	intent: string;
	timezone: string;
	localDate: string;
	catalog: AiSearchCatalog;
}): AiSearchInterpreterModelMessage[] {
	if (SYSTEM_POLICY.length > AI_SEARCH_INTERPRETER_LIMITS.modelSystemChars) {
		throw new Error("Search interpreter system policy exceeds its safe bound");
	}
	const context = wrapUntrustedAiContext(
		JSON.stringify({
			intent: input.intent,
			timezone: input.timezone,
			localDate: input.localDate,
			folders: input.catalog.folders,
			labels: input.catalog.labels,
		}),
		{
			label: "SEARCH_INTERPRETATION_INPUT",
			maxChars: AI_SEARCH_INTERPRETER_LIMITS.modelUntrustedChars,
			truncate: false,
		},
	);
	const messages: AiSearchInterpreterModelMessage[] = [
		{ role: "system", content: SYSTEM_POLICY },
		{ role: "user", content: context },
	];
	if (byteLength(JSON.stringify(messages)) > AI_SEARCH_INTERPRETER_LIMITS.modelSerializedBytes) {
		throw new Error("Search interpreter model envelope exceeds its safe bound");
	}
	return messages;
}

const filtersSchema = z.object({
	terms: z.array(z.string()),
	phrases: z.array(z.string()),
	from: z.array(z.string()),
	to: z.array(z.string()),
	subject: z.array(z.string()),
	filename: z.array(z.string()),
	folders: z.array(z.string()),
	isRead: z.boolean().nullable(),
	isStarred: z.boolean().nullable(),
	hasAttachment: z.boolean(),
	after: z.string().nullable(),
	before: z.string().nullable(),
}).strict();
const modelOutputSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("ambiguous") }).strict(),
	z.object({ status: z.literal("unsupported") }).strict(),
	z.object({
		status: z.literal("ready"),
		filters: filtersSchema,
		labelId: z.string().nullable(),
	}).strict(),
]);

export class AiSearchInterpreterValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiSearchInterpreterValidationError";
	}
}

function readyResponse(
	filters: AiSearchFilters,
	labelId: string | null,
	state: "generated" | "cached",
): AiSearchInterpreterResponse {
	const query = serializeAiSearchFilters(filters, { allowEmpty: labelId !== null });
	const parsed = parseSearchQuery(query);
	buildMailSearchPlan({
		...(parsed.terms.length ? { terms: parsed.terms } : {}),
		...(parsed.phrases.length ? { phrases: parsed.phrases } : {}),
		...(parsed.from ? { from: parsed.from } : {}),
		...(parsed.to ? { to: parsed.to } : {}),
		...(parsed.subject ? { subject: parsed.subject } : {}),
		...(parsed.filename ? { filename: parsed.filename } : {}),
		...(parsed.folder ? { folder: parsed.folder } : {}),
		...(parsed.date_start ? { date_start: parsed.date_start } : {}),
		...(parsed.date_end ? { date_end: parsed.date_end } : {}),
		...(parsed.is_read !== undefined ? { is_read: parsed.is_read } : {}),
		...(parsed.is_starred !== undefined ? { is_starred: parsed.is_starred } : {}),
		...(parsed.has_attachment ? { has_attachment: true } : {}),
		...(labelId ? { label_id: labelId } : {}),
		page: 1,
		limit: 25,
	});
	return parseAiSearchInterpreterResponse({
		state,
		query,
		labelId,
		filters,
		requiresReview: true,
	});
}

function parseModelValue(
	value: unknown,
	catalog: AiSearchCatalog,
	state: "generated" | "cached",
): ParsedAiSearchInterpreterModelOutput {
	const decoded = modelOutputSchema.safeParse(value);
	if (!decoded.success) {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter output has an invalid structure",
		);
	}
	if (decoded.data.status !== "ready") {
		return {
			modelOutput: decoded.data,
			response: { state: decoded.data.status },
		};
	}
	let filters: AiSearchFilters;
	try {
		filters = parseAiSearchFilters(decoded.data.filters);
	} catch {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter filters are invalid",
		);
	}
	for (const value of [
		...filters.terms,
		...filters.phrases,
		...filters.from,
		...filters.to,
		...filters.subject,
		...filters.filename,
	]) {
		if (ACTIVE_MARKUP.test(value)) {
			throw new AiSearchInterpreterValidationError(
				"Search interpreter filters contain active markup",
			);
		}
	}
	const folderIds = new Set(catalog.folders.map(({ id }) => id));
	if (filters.folders.some((id) => !folderIds.has(id))) {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter references an unknown folder",
		);
	}
	const labelIds = new Set(catalog.labels.map(({ id }) => id));
	const labelId = decoded.data.labelId;
	if (labelId !== null && !labelIds.has(labelId)) {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter references an unknown label",
		);
	}
	let response: AiSearchInterpreterResponse;
	try {
		response = readyResponse(filters, labelId, state);
	} catch {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter output cannot produce a valid Search v2 plan",
		);
	}
	return {
		modelOutput: { status: "ready", filters, labelId },
		response,
	};
}

export function parseAiSearchInterpreterModelOutput(
	raw: string,
	catalog: AiSearchCatalog,
	state: "generated" | "cached" = "generated",
): ParsedAiSearchInterpreterModelOutput {
	if (typeof raw !== "string" || byteLength(raw) > AI_SEARCH_INTERPRETER_LIMITS.modelOutputBytes) {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter output is oversized",
		);
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new AiSearchInterpreterValidationError(
			"Search interpreter output is malformed JSON",
		);
	}
	return parseModelValue(value, catalog, state);
}

export function parseCachedAiSearchInterpreterModelOutput(
	value: unknown,
	catalog: AiSearchCatalog,
): ParsedAiSearchInterpreterModelOutput {
	return parseModelValue(value, catalog, "cached");
}

export async function buildAiSearchInterpreterCacheKey(input: {
	environment: string;
	model: string;
	actorUserId: string;
	mailboxId: string;
	intent: string;
	timezone: string;
	localDate: string;
	catalogFingerprint: string;
}): Promise<string> {
	return buildAiCacheKey({
		feature: AI_SEARCH_INTERPRETER_AI_CONFIG.feature,
		tier: AI_SEARCH_INTERPRETER_AI_CONFIG.requestedTier,
		model: input.model,
		promptVersion: AI_SEARCH_INTERPRETER_AI_CONFIG.promptVersion,
		sourceVersion: AI_SEARCH_INTERPRETER_AI_CONFIG.sourceVersion,
		mailboxId: input.mailboxId,
		input: {
			environment: input.environment,
			actorUserId: input.actorUserId,
			intent: input.intent,
			timezone: input.timezone,
			localDate: input.localDate,
			catalogFingerprint: input.catalogFingerprint,
		},
	});
}
