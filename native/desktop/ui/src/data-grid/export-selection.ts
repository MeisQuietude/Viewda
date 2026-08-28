import type { ExportRowRange, FieldPath } from "../desktop";
import { boundedSelectionScope } from "./grid-selection";
import type { GridSelection } from "./grid-model";

export interface ExportSelectionShape {
  fieldPaths: FieldPath[];
  columnCount: number;
  rowCount: number;
  rowRanges: ExportRowRange[];
}

/** Compresses the grid's union selection without expanding contiguous large ranges. */
export function exportSelectionShape(
  selection: GridSelection,
  visibleFieldPaths: readonly FieldPath[],
  viewRowCount: number,
): ExportSelectionShape | null {
  const scope = boundedSelectionScope(
    selection,
    viewRowCount,
    visibleFieldPaths.length,
  );
  if (scope === null) {
    return null;
  }
  const fieldPaths = scope.columnIndices
    .map((visibleIndex) => visibleFieldPaths[visibleIndex])
    .filter((fieldPath): fieldPath is FieldPath => fieldPath !== undefined);

  return {
    fieldPaths,
    columnCount: fieldPaths.length,
    rowCount: scope.rowCount,
    rowRanges: scope.rowRanges.map(([start, end]): ExportRowRange => ({
      start,
      end,
    })),
  };
}
