import {
  SAVED_VIEW_SORT_COLUMNS,
  type SavedViewFilters,
  type SavedViewSort,
} from "../../shared/saved-views.ts";
import { parseSearchQuery } from "./search-parser.ts";

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
  const parsed = parseSearchQuery(input.query);
  return {
    filters: {
      ...(parsed.query ? { query: parsed.query } : {}),
      ...(parsed.folder ? { folder: parsed.folder } : {}),
      ...(parsed.from ? { from: parsed.from } : {}),
      ...(parsed.to ? { to: parsed.to } : {}),
      ...(parsed.subject ? { subject: parsed.subject } : {}),
      ...(parsed.date_start ? { dateStart: parsed.date_start } : {}),
      ...(parsed.date_end ? { dateEnd: parsed.date_end } : {}),
      ...(parsed.is_read !== undefined ? { isRead: parsed.is_read } : {}),
      ...(parsed.is_starred !== undefined
        ? { isStarred: parsed.is_starred }
        : {}),
      ...(parsed.has_attachment ? { hasAttachment: true as const } : {}),
      ...labelFilter(input.searchParams),
    },
    sort: sortFromParams(input.searchParams),
  };
}

export function savedViewRoute(mailboxId: string, viewId: string): string {
  return `/mailbox/${encodeURIComponent(mailboxId)}/views/${encodeURIComponent(viewId)}`;
}
