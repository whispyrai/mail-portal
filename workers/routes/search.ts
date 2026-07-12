import { Hono, type Context } from "hono";
import {
	SearchQueryError,
	parseSearchQuery,
} from "../../shared/mail-search.ts";
import { SAVED_VIEW_SORT_COLUMNS } from "../../shared/saved-views.ts";
import type { MailboxContext } from "../lib/mailbox.ts";
import {
	buildMailSearchPlan,
	type MailSearchOptions,
} from "../lib/mail-search.ts";

export type SearchRouteContext = MailboxContext;

export interface SearchOperations {
	search(options: MailSearchOptions): Promise<unknown[]>;
	count(options: MailSearchOptions): Promise<number>;
}

interface SearchRouteDependencies {
	operations(context: Context<SearchRouteContext>): SearchOperations;
}

function invalid(message: string): never {
	throw new SearchQueryError("INVALID_QUERY", message);
}

function boundedInteger(
	params: URLSearchParams,
	key: string,
	fallback: number,
	max: number,
): number {
	const raw = params.get(key);
	if (raw === null || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) invalid(`${key} must be a whole number`);
	const value = Number(raw);
	if (value < 1 || value > max) invalid(`${key} is outside the allowed range`);
	return value;
}

function optionalBoolean(params: URLSearchParams, key: string): boolean | undefined {
	const raw = params.get(key);
	if (raw === null || raw === "") return undefined;
	if (raw === "true" || raw === "1") return true;
	if (raw === "false" || raw === "0") return false;
	return invalid(`${key} must be true or false`);
}

function repeated(params: URLSearchParams, key: string): string[] | undefined {
	const values = params.getAll(key).map((value) => value.trim()).filter(Boolean);
	if (!values.length) return undefined;
	if (values.length > 8 || values.some((value) => value.length > 200)) {
		invalid(`${key} contains too many or oversized values`);
	}
	return values;
}

function mergeValues(left?: string[], right?: string[]): string[] | undefined {
	const values = [...(left ?? []), ...(right ?? [])];
	return values.length ? [...new Set(values)] : undefined;
}

function optionalDate(params: URLSearchParams, key: string): string | undefined {
	const value = params.get(key)?.trim();
	if (!value) return undefined;
	if (value.length > 40 || !Number.isFinite(Date.parse(value))) {
		invalid(`${key} must be a valid date`);
	}
	return value;
}

export function searchOptionsFromUrl(url: URL): MailSearchOptions {
	const params = url.searchParams;
	const parsed = parseSearchQuery(params.get("q") ?? params.get("query") ?? "");
	const page = boundedInteger(params, "page", 1, 100_000);
	const limit = boundedInteger(params, "limit", 25, 100);
	const sortColumn = params.get("sortColumn")?.trim();
	const sortDirection = params.get("sortDirection")?.trim();
	if (
		sortColumn &&
		!SAVED_VIEW_SORT_COLUMNS.includes(
			sortColumn as (typeof SAVED_VIEW_SORT_COLUMNS)[number],
		)
	) invalid("sortColumn is not supported");
	if (sortDirection && sortDirection !== "ASC" && sortDirection !== "DESC") {
		invalid("sortDirection must be ASC or DESC");
	}
	if (sortDirection && !sortColumn) invalid("sortDirection requires sortColumn");

	const dateStart = optionalDate(params, "date_start") ?? parsed.date_start;
	const dateEnd = optionalDate(params, "date_end") ?? parsed.date_end;
	if (dateStart && dateEnd && Date.parse(dateStart) >= Date.parse(dateEnd)) {
		invalid("The start date must be earlier than the end date");
	}
	const labelId = params.get("label_id")?.trim();
	if (labelId && labelId.length > 128) invalid("label_id is too long");
	const from = mergeValues(parsed.from, repeated(params, "from"));
	const to = mergeValues(parsed.to, repeated(params, "to"));
	const subject = mergeValues(parsed.subject, repeated(params, "subject"));
	const filename = mergeValues(parsed.filename, repeated(params, "filename"));
	const folder = mergeValues(parsed.folder, repeated(params, "folder"));
	const isRead = optionalBoolean(params, "is_read") ?? parsed.is_read;
	const isStarred = optionalBoolean(params, "is_starred") ?? parsed.is_starred;
	const hasAttachment =
		optionalBoolean(params, "has_attachment") ?? parsed.has_attachment;

	return {
		...(parsed.terms.length ? { terms: parsed.terms } : {}),
		...(parsed.phrases.length ? { phrases: parsed.phrases } : {}),
		...(from ? { from } : {}),
		...(to ? { to } : {}),
		...(subject ? { subject } : {}),
		...(filename ? { filename } : {}),
		...(folder ? { folder } : {}),
		...(dateStart ? { date_start: dateStart } : {}),
		...(dateEnd ? { date_end: dateEnd } : {}),
		...(isRead !== undefined ? { is_read: isRead } : {}),
		...(isStarred !== undefined ? { is_starred: isStarred } : {}),
		...(hasAttachment ? { has_attachment: true } : {}),
		...(labelId ? { label_id: labelId } : {}),
		...(sortColumn ? { sortColumn } : {}),
		...(sortDirection ? { sortDirection } : {}),
		page,
		limit,
	};
}

export function createSearchRoutes(dependencies: SearchRouteDependencies) {
	const routes = new Hono<SearchRouteContext>();
	routes.get("/api/v1/mailboxes/:mailboxId/search", async (c) => {
		try {
			const options = searchOptionsFromUrl(new URL(c.req.url));
			buildMailSearchPlan(options);
			const operations = dependencies.operations(c);
			const [emails, totalCount] = await Promise.all([
				operations.search(options),
				operations.count(options),
			]);
			return c.json({ emails, totalCount });
		} catch (error) {
			if (error instanceof SearchQueryError) {
				return c.json({ error: error.message, code: error.code }, 400);
			}
			throw error;
		}
	});
	return routes;
}

export const searchRoutes = createSearchRoutes({
	operations: (c) => {
		const stub = c.var.mailboxStub as unknown as {
			searchEmails(options: MailSearchOptions): Promise<unknown[]>;
			countSearchResults(options: MailSearchOptions): Promise<number>;
		};
		return {
			search: (options) => stub.searchEmails(options),
			count: (options) => stub.countSearchResults(options),
		};
	},
});
