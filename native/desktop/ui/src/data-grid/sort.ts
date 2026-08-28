import type { FieldPath, SortColumn } from "../desktop";
import { sameFieldPath } from "./field-path";
import { sameJsonPath } from "./json-path";

export function sameSortIdentity(
  left: Pick<SortColumn, "fieldPath" | "jsonTarget">,
  right: Pick<SortColumn, "fieldPath" | "jsonTarget">,
): boolean {
  if (!sameFieldPath(left.fieldPath, right.fieldPath)) return false;
  if (left.jsonTarget === undefined || right.jsonTarget === undefined) {
    return left.jsonTarget === undefined && right.jsonTarget === undefined;
  }
  return sameJsonPath(left.jsonTarget.path, right.jsonTarget.path);
}

function isWholeColumnSort(column: SortColumn, fieldPath: FieldPath): boolean {
  return (
    column.jsonTarget === undefined &&
    sameFieldPath(column.fieldPath, fieldPath)
  );
}

export function nextSort(
  current: readonly SortColumn[],
  fieldPath: FieldPath,
  additive: boolean,
): SortColumn[] {
  const existingIndex = current.findIndex((column) =>
    isWholeColumnSort(column, fieldPath),
  );
  const direction =
    existingIndex < 0
      ? "ascending"
      : current[existingIndex]?.direction === "ascending"
        ? "descending"
        : null;

  if (!additive) {
    const jsonFieldSorts = current.filter(
      (column) => column.jsonTarget !== undefined,
    );
    return direction === null
      ? jsonFieldSorts
      : [{ fieldPath, direction }, ...jsonFieldSorts];
  }
  if (existingIndex < 0) {
    return [...current, { fieldPath, direction: "ascending" }];
  }
  if (direction === null) {
    return current.filter((column) => !isWholeColumnSort(column, fieldPath));
  }
  return current.map((column) =>
    isWholeColumnSort(column, fieldPath) ? { ...column, direction } : column,
  );
}

export function sortedColumnIcon(
  sort: readonly SortColumn[],
  fieldPath: FieldPath,
): string {
  const ordinal = sort.findIndex((column) =>
    isWholeColumnSort(column, fieldPath),
  );
  if (ordinal < 0) {
    return "viewda-sort-neutral";
  }
  const direction = sort[ordinal]?.direction ?? "ascending";
  return sort.length > 1
    ? `viewda-sort-${direction}-${ordinal + 1}`
    : `viewda-sort-${direction}`;
}
