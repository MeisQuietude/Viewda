import type { FieldPath, SortColumn } from "../desktop";
import { sameFieldPath } from "./field-path";

export function nextSort(
  current: readonly SortColumn[],
  fieldPath: FieldPath,
  additive: boolean,
): SortColumn[] {
  const existingIndex = current.findIndex((column) =>
    sameFieldPath(column.fieldPath, fieldPath),
  );
  const direction =
    existingIndex < 0
      ? "ascending"
      : current[existingIndex]?.direction === "ascending"
        ? "descending"
        : null;

  if (!additive) {
    return direction === null ? [] : [{ fieldPath, direction }];
  }
  if (existingIndex < 0) {
    return [...current, { fieldPath, direction: "ascending" }];
  }
  if (direction === null) {
    return current.filter(
      (column) => !sameFieldPath(column.fieldPath, fieldPath),
    );
  }
  return current.map((column) =>
    sameFieldPath(column.fieldPath, fieldPath)
      ? { ...column, direction }
      : column,
  );
}

export function sortedColumnIcon(
  sort: readonly SortColumn[],
  fieldPath: FieldPath,
): string {
  const ordinal = sort.findIndex((column) =>
    sameFieldPath(column.fieldPath, fieldPath),
  );
  if (ordinal < 0) {
    return "viewda-sort-neutral";
  }
  const direction = sort[ordinal]?.direction ?? "ascending";
  return sort.length > 1
    ? `viewda-sort-${direction}-${ordinal + 1}`
    : `viewda-sort-${direction}`;
}
