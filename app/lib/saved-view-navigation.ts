import {
  SAVED_VIEW_SORT_COLUMNS,
  type SavedViewFilters,
  type SavedViewSort,
} from "../../shared/saved-views.ts";

function sortFromParams(searchParams: URLSearchParams): SavedViewSort {
  const column = searchParams.get("sortColumn");
  const direction = searchParams.get("sortDirection");
  return {
    column:
      column &&
      SAVED_VIEW_SORT_COLUMNS.includes(
        column as (typeof SAVED_VIEW_SORT_COLUMNS)[number],
      )
        ? (column as SavedViewSort["column"])
        : "date",
    direction: direction === "ASC" || direction === "DESC" ? direction : "DESC",
  };
}

function hasExplicitSort(searchParams: URLSearchParams): boolean {
  const column = searchParams.get("sortColumn");
  return Boolean(
    column &&
      SAVED_VIEW_SORT_COLUMNS.includes(
        column as (typeof SAVED_VIEW_SORT_COLUMNS)[number],
      ),
  );
}

function labelFilter(
  searchParams: URLSearchParams,
): Pick<SavedViewFilters, "labelId"> {
  const labelId = searchParams.get("label_id")?.trim();
  return labelId ? { labelId } : {};
}

export function definitionFromFolderView(input: {
  folder: string;
  searchParams: URLSearchParams;
}) {
  return {
    filters: {
      folder: input.folder,
      ...labelFilter(input.searchParams),
    },
    sort: sortFromParams(input.searchParams),
  };
}

export function definitionFromSearchView(input: {
  query: string;
  searchParams: URLSearchParams;
}) {
  return {
    filters: {
		...(input.query.trim() ? { searchQuery: input.query.trim() } : {}),
      ...labelFilter(input.searchParams),
		...(!hasExplicitSort(input.searchParams)
			? { useDefaultSearchOrder: true as const }
			: {}),
    },
    sort: sortFromParams(input.searchParams),
  };
}

export function savedViewRoute(mailboxId: string, viewId: string): string {
  return `/mailbox/${encodeURIComponent(mailboxId)}/views/${encodeURIComponent(viewId)}`;
}
