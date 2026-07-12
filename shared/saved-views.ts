export const SAVED_VIEW_SORT_COLUMNS = [
  "date",
  "sender",
  "recipient",
  "subject",
  "read",
  "starred",
] as const;

export type SavedViewSortColumn = (typeof SAVED_VIEW_SORT_COLUMNS)[number];
export type SavedViewSortDirection = "ASC" | "DESC";

export interface SavedViewFilters {
  /** Exact Search v2 grammar, including repeated filters and quoted phrases. */
  searchQuery?: string;
  /** Apply Search v2's relevance/recency order instead of the D1 sort placeholder. */
  useDefaultSearchOrder?: true;
  /** Legacy free-text filter retained for existing saved records. */
  query?: string;
  folder?: string;
  from?: string;
  to?: string;
  subject?: string;
  dateStart?: string;
  dateEnd?: string;
  isRead?: boolean;
  isStarred?: boolean;
  hasAttachment?: true;
  labelId?: string;
}

export interface SavedViewSort {
  column: SavedViewSortColumn;
  direction: SavedViewSortDirection;
}

export interface SavedViewDefinition {
  name: string;
  filters: SavedViewFilters;
  sort: SavedViewSort;
}

export interface SavedView extends SavedViewDefinition {
  id: string;
  mailboxAddress: string;
  createdAt: number;
  updatedAt: number;
}

export function savedViewSearchParams(
  definition: Pick<SavedViewDefinition, "filters" | "sort">,
): Record<string, string> {
  const { filters, sort } = definition;
  return {
	...(filters.searchQuery ? { q: filters.searchQuery } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.folder ? { folder: filters.folder } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
    ...(filters.subject ? { subject: filters.subject } : {}),
    ...(filters.dateStart ? { date_start: filters.dateStart } : {}),
    ...(filters.dateEnd ? { date_end: filters.dateEnd } : {}),
    ...(filters.isRead !== undefined
      ? { is_read: String(filters.isRead) }
      : {}),
    ...(filters.isStarred !== undefined
      ? { is_starred: String(filters.isStarred) }
      : {}),
    ...(filters.hasAttachment ? { has_attachment: "true" } : {}),
    // Never omit an unknown label ID. The mailbox query deliberately returns
    // no matches for unknown or removed IDs instead of broadening the view.
    ...(filters.labelId ? { label_id: filters.labelId } : {}),
    ...(!filters.useDefaultSearchOrder
      ? { sortColumn: sort.column, sortDirection: sort.direction }
      : {}),
  };
}
