import type { SortColumn } from "../desktop";
import type { ColumnSortIndicator } from "./grid-model";

export function nextSort(
  current: readonly SortColumn[],
  sourceIndex: number,
  additive: boolean,
): SortColumn[] {
  const existingIndex = current.findIndex(
    (column) => column.sourceIndex === sourceIndex,
  );
  const direction =
    existingIndex < 0
      ? "ascending"
      : current[existingIndex]?.direction === "ascending"
        ? "descending"
        : null;

  if (!additive) {
    return direction === null ? [] : [{ sourceIndex, direction }];
  }
  if (existingIndex < 0) {
    return [...current, { sourceIndex, direction: "ascending" }];
  }
  if (direction === null) {
    return current.filter((column) => column.sourceIndex !== sourceIndex);
  }
  return current.map((column) =>
    column.sourceIndex === sourceIndex ? { ...column, direction } : column,
  );
}

export function sortIndicator(
  sort: readonly SortColumn[],
  sourceIndex: number,
): ColumnSortIndicator {
  const ordinal = sort.findIndex(
    (column) => column.sourceIndex === sourceIndex,
  );
  if (ordinal < 0) {
    return { direction: "neutral" };
  }
  const direction = sort[ordinal]?.direction ?? "ascending";
  return sort.length > 1 ? { direction, priority: ordinal + 1 } : { direction };
}
