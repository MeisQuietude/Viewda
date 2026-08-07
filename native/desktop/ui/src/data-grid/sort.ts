import type { SortColumn } from "../desktop";

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

export function sortedColumnIcon(
  sort: readonly SortColumn[],
  sourceIndex: number,
): string {
  const ordinal = sort.findIndex(
    (column) => column.sourceIndex === sourceIndex,
  );
  if (ordinal < 0) {
    return "viewda-sort-neutral";
  }
  const direction = sort[ordinal]?.direction ?? "ascending";
  return sort.length > 1
    ? `viewda-sort-${direction}-${ordinal + 1}`
    : `viewda-sort-${direction}`;
}
