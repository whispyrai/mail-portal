export const SEARCH_PAGE_SIZE = 25;

export interface SearchRequestInput {
	query: string;
	page: number;
	labelId?: string;
	sortColumn?: string;
	sortDirection?: string;
}

export function searchRequestParams(input: SearchRequestInput): Record<string, string> {
	return {
		...(input.query.trim() ? { q: input.query.trim() } : {}),
		page: String(input.page),
		limit: String(SEARCH_PAGE_SIZE),
		...(input.labelId ? { label_id: input.labelId } : {}),
		...(input.sortColumn ? { sortColumn: input.sortColumn } : {}),
		...(input.sortColumn && input.sortDirection
			? { sortDirection: input.sortDirection }
			: {}),
	};
}

export function shouldRetrySearch(failureCount: number, error: unknown): boolean {
	const status =
		typeof error === "object" && error !== null && "status" in error
			? Number(error.status)
			: undefined;
	if (status !== undefined && status < 500) return false;
	return failureCount < 2;
}
