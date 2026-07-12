export const MAIL_SEARCH_LIMITS = {
	queryChars: 500,
	tokens: 32,
	tokenChars: 200,
	valuesPerFilter: 8,
} as const;

export type SearchQueryErrorCode = "INVALID_QUERY" | "QUERY_TOO_LARGE";

export class SearchQueryError extends Error {
	readonly code: SearchQueryErrorCode;

	constructor(code: SearchQueryErrorCode, message: string) {
		super(message);
		this.name = "SearchQueryError";
		this.code = code;
	}
}

export interface ParsedSearch {
	/** The original bounded query, retained so personal Saved Views stay exact. */
	query: string;
	terms: string[];
	phrases: string[];
	from?: string[];
	to?: string[];
	subject?: string[];
	filename?: string[];
	folder?: string[];
	is_read?: boolean;
	is_starred?: boolean;
	has_attachment?: boolean;
	date_start?: string;
	date_end?: string;
}

interface LexedToken {
	value: string;
	quoted: boolean;
}

function invalid(message: string): never {
	throw new SearchQueryError("INVALID_QUERY", message);
}

function lex(input: string): LexedToken[] {
	const tokens: LexedToken[] = [];
	let value = "";
	let quoted = false;
	let inQuote = false;
	let escaped = false;

	const push = () => {
		if (!value) return;
		if (value.length > MAIL_SEARCH_LIMITS.tokenChars) {
			throw new SearchQueryError(
				"QUERY_TOO_LARGE",
				`Search terms cannot exceed ${MAIL_SEARCH_LIMITS.tokenChars} characters`,
			);
		}
		tokens.push({ value, quoted });
		value = "";
		quoted = false;
	};

	for (const character of input) {
		if (escaped) {
			value += character;
			escaped = false;
			continue;
		}
		if (inQuote && character === "\\") {
			escaped = true;
			continue;
		}
		if (character === '"') {
			inQuote = !inQuote;
			quoted = true;
			continue;
		}
		if (!inQuote && /\s/.test(character)) {
			push();
			continue;
		}
		value += character;
	}
	if (inQuote || escaped) invalid("Search contains an unterminated quote");
	push();
	if (tokens.length > MAIL_SEARCH_LIMITS.tokens) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			`Search cannot contain more than ${MAIL_SEARCH_LIMITS.tokens} terms`,
		);
	}
	return tokens;
}

function pushBounded(target: string[], value: string, label: string) {
	if (!value.trim()) invalid(`${label} requires a value`);
	if (target.length >= MAIL_SEARCH_LIMITS.valuesPerFilter) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			`${label} cannot be repeated more than ${MAIL_SEARCH_LIMITS.valuesPerFilter} times`,
		);
	}
	target.push(value.trim());
}

function dateAtUtcStart(value: string, operator: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		invalid(`${operator} requires a date in YYYY-MM-DD format`);
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
		invalid(`${operator} requires a valid calendar date`);
	}
	return date.toISOString();
}

/** Parse the complete user-entered search grammar. */
export function parseSearchQuery(input: string): ParsedSearch {
	const query = input.trim();
	if (query.length > MAIL_SEARCH_LIMITS.queryChars) {
		throw new SearchQueryError(
			"QUERY_TOO_LARGE",
			`Search cannot exceed ${MAIL_SEARCH_LIMITS.queryChars} characters`,
		);
	}

	const parsed: ParsedSearch = { query, terms: [], phrases: [] };
	const repeated = {
		from: [] as string[],
		to: [] as string[],
		subject: [] as string[],
		filename: [] as string[],
		folder: [] as string[],
	};

	for (const token of lex(query)) {
		const separator = token.value.indexOf(":");
		const operator = separator > 0
			? token.value.slice(0, separator).toLowerCase()
			: "";
		const value = separator > 0 ? token.value.slice(separator + 1) : token.value;

		switch (operator) {
			case "from":
			case "to":
			case "subject":
			case "filename":
				pushBounded(repeated[operator], value, `${operator}:`);
				break;
			case "in":
				pushBounded(repeated.folder, value.toLowerCase(), "in:");
				break;
			case "is": {
				if (!value) invalid("is: requires a value");
				const normalized = value.toLowerCase();
				if (normalized === "read" || normalized === "unread") {
					const next = normalized === "read";
					if (parsed.is_read !== undefined && parsed.is_read !== next) {
						invalid("Search cannot be both read and unread");
					}
					parsed.is_read = next;
				} else if (normalized === "starred" || normalized === "unstarred") {
					const next = normalized === "starred";
					if (parsed.is_starred !== undefined && parsed.is_starred !== next) {
						invalid("Search cannot be both starred and unstarred");
					}
					parsed.is_starred = next;
				} else invalid(`Unsupported is: filter "${value}"`);
				break;
			}
			case "has":
				if (value.toLowerCase() !== "attachment") {
					invalid(`Unsupported has: filter "${value}"`);
				}
				parsed.has_attachment = true;
				break;
			case "after": {
				const next = dateAtUtcStart(value, "after:");
				if (!parsed.date_start || next > parsed.date_start) parsed.date_start = next;
				break;
			}
			case "before": {
				const next = dateAtUtcStart(value, "before:");
				if (!parsed.date_end || next < parsed.date_end) parsed.date_end = next;
				break;
			}
			default:
				if (!value && operator) invalid(`${operator}: requires a value`);
				(token.quoted ? parsed.phrases : parsed.terms).push(token.value);
		}
	}

	if (parsed.date_start && parsed.date_end && parsed.date_start >= parsed.date_end) {
		invalid("after: must be earlier than before:");
	}
	for (const [key, values] of Object.entries(repeated)) {
		if (values.length) {
			parsed[key as keyof typeof repeated] = values;
		}
	}
	return parsed;
}

/** Terms that the result UI may safely highlight without interpreting regex. */
export function searchHighlightTerms(parsed: ParsedSearch): string[] {
	return [...parsed.terms, ...parsed.phrases].filter(Boolean).slice(0, 16);
}
