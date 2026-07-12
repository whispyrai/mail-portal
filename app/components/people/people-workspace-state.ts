import {
	MAIL_PEOPLE_LIMITS,
	MAIL_PEOPLE_SORTS,
	hasUnsafeMailPeopleText,
	type MailPeopleSort,
} from "../../../shared/mail-people.ts";

export const PEOPLE_SORT_OPTIONS = MAIL_PEOPLE_SORTS;
export type PeopleSort = MailPeopleSort;

export type PeopleWorkspaceState = {
	q: string;
	sort: PeopleSort;
	invalidQuery: string | null;
	invalidSort: string | null;
	invalidSelection: string | null;
	selected: string | null;
};

export type PeopleWorkspaceFilters = {
	q: string;
	sort: PeopleSort;
};

function normalizedText(value: string | null): string {
	return value?.trim().normalize("NFC") ?? "";
}

function boundedDisplayValue(value: string): string {
	if (hasUnsafeMailPeopleText(value)) return "invalid value";
	const safe = value
		.trim();
	const characters = [...safe];
	return characters.length > 60
		? `${characters.slice(0, 60).join("")}…`
		: safe || "invalid value";
}

function invalidUrlText(value: string, maximum: number): boolean {
	return (
		Array.from(value).length > maximum ||
		hasUnsafeMailPeopleText(value)
	);
}

export function peopleWorkspaceStateFromParams(
	params: URLSearchParams,
): PeopleWorkspaceState {
	const rawSort = normalizedText(params.get("sort")).toLowerCase();
	const validSort = !rawSort || PEOPLE_SORT_OPTIONS.includes(rawSort as PeopleSort);
	const rawQuery = normalizedText(params.get("q"));
	const queryInvalid = invalidUrlText(rawQuery, MAIL_PEOPLE_LIMITS.queryChars);
	const rawSelection = normalizedText(params.get("selected"));
	const selectionInvalid = invalidUrlText(
		rawSelection,
		MAIL_PEOPLE_LIMITS.identifierChars,
	);
	return {
		q: queryInvalid ? "" : rawQuery,
		sort: validSort && rawSort ? rawSort as PeopleSort : "recent",
		invalidQuery: queryInvalid
			? `Search must be ${MAIL_PEOPLE_LIMITS.queryChars} characters or fewer and cannot contain control characters.`
			: null,
		invalidSort: validSort ? null : boundedDisplayValue(rawSort),
		invalidSelection: selectionInvalid
			? "The selected Person link is invalid."
			: null,
		selected: selectionInvalid ? null : rawSelection || null,
	};
}

function setOptional(
	params: URLSearchParams,
	key: string,
	value: string,
): void {
	if (value) params.set(key, value);
	else params.delete(key);
}

export function paramsWithPeopleFilters(
	current: URLSearchParams,
	filters: PeopleWorkspaceFilters,
): URLSearchParams {
	const next = new URLSearchParams(current);
	setOptional(next, "q", normalizedText(filters.q));
	setOptional(next, "sort", filters.sort === "recent" ? "" : filters.sort);
	next.delete("selected");
	return next;
}

export function paramsWithSelectedPerson(
	current: URLSearchParams,
	personId: string | null,
): URLSearchParams {
	const next = new URLSearchParams(current);
	setOptional(next, "selected", normalizedText(personId));
	return next;
}
