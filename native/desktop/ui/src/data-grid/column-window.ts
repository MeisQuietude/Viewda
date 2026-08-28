import type { FieldPath } from "../desktop";
import { fieldPathKey } from "./field-path";

interface ProjectedColumn {
  fieldPath: FieldPath;
}

export function projectedFieldPaths(
  columns: readonly ProjectedColumn[],
  visibleColumnIndices: readonly number[],
  initialColumnCount: number,
): FieldPath[] {
  const visiblePaths = new Set<string>();
  for (const visibleIndex of visibleColumnIndices) {
    const fieldPath = columns[visibleIndex]?.fieldPath;
    if (fieldPath !== undefined) {
      visiblePaths.add(fieldPathKey(fieldPath));
    }
  }
  if (visiblePaths.size === 0) {
    for (const column of columns.slice(0, Math.max(1, initialColumnCount))) {
      visiblePaths.add(fieldPathKey(column.fieldPath));
    }
  }
  return columns
    .filter((column) => visiblePaths.has(fieldPathKey(column.fieldPath)))
    .map((column) => column.fieldPath);
}

export function projectionContains(
  candidate: readonly FieldPath[],
  requested: readonly FieldPath[],
): boolean {
  const available = new Set(candidate.map(fieldPathKey));
  return requested.every((fieldPath) => available.has(fieldPathKey(fieldPath)));
}
