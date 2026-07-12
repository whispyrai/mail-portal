import { containsUnsafeAiSearchText } from "../../shared/ai-search-interpreter.ts";
import { parseSearchQuery, type ParsedSearch } from "../../shared/mail-search.ts";

export type SearchFilterSummaryGroup = {
	label: string;
	values: string[];
	mode: "all" | "any";
};

export function searchFilterSummary(query: string): SearchFilterSummaryGroup[] {
	const parsed = parseSearchQuery(query);
	const groups: SearchFilterSummaryGroup[] = [];
	const add = (
		label: string,
		values: string[] | undefined,
		mode: "all" | "any" = "any",
	) => {
		if (values?.length) groups.push({ label, values, mode });
	};
	add(
		"Contains all",
		[
			...parsed.terms,
			...parsed.phrases.map((phrase) => `“${phrase}”`),
		],
		"all",
	);
	add("From", parsed.from);
	add("To", parsed.to);
	add("Subject", parsed.subject);
	add("Filename", parsed.filename);
	add("Folder", parsed.folder);
	add(
		"State",
		[
			...(parsed.is_read === undefined
				? []
				: [parsed.is_read ? "Read" : "Unread"]),
			...(parsed.is_starred === undefined
				? []
				: [parsed.is_starred ? "Starred" : "Unstarred"]),
			...(parsed.has_attachment ? ["Has attachment"] : []),
		],
		"all",
	);
	add(
		"After",
		parsed.date_start ? [parsed.date_start.slice(0, 10)] : undefined,
		"all",
	);
	add(
		"Before",
		parsed.date_end ? [parsed.date_end.slice(0, 10)] : undefined,
		"all",
	);
	return groups;
}

export type AiSearchReviewValidation =
	| { ok: true; parsed: ParsedSearch }
	| { ok: false; error: string };

export function validateAiSearchReview(
	query: string,
	labelId: string | null,
	authorizedLabelIds: readonly string[],
): AiSearchReviewValidation {
	if (containsUnsafeAiSearchText(query)) {
		return {
			ok: false,
			error: "Search contains hidden directional or control characters.",
		};
	}
	let parsed: ParsedSearch;
	try {
		parsed = parseSearchQuery(query);
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : "Search query is invalid.",
		};
	}
	if (!parsed.query && !labelId) {
		return { ok: false, error: "Enter a search query or choose a label." };
	}
	if (labelId && !authorizedLabelIds.includes(labelId)) {
		return {
			ok: false,
			error: "That label is no longer available. Interpret the request again.",
		};
	}
	return { ok: true, parsed };
}
