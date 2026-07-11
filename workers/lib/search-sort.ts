import {
  SAVED_VIEW_SORT_COLUMNS,
  type SavedViewSort,
} from "../../shared/saved-views.ts";

export function normalizeSearchSort(
  column: unknown,
  direction: unknown,
): SavedViewSort {
  return {
    column:
      typeof column === "string" &&
      SAVED_VIEW_SORT_COLUMNS.includes(column as SavedViewSort["column"])
        ? (column as SavedViewSort["column"])
        : "date",
    direction: direction === "ASC" || direction === "DESC" ? direction : "DESC",
  };
}
