import type { ExportRowRange } from "../desktop";
import { boundedSelectionScope } from "./grid-selection";
import type { GridSelection } from "./grid-model";

export interface ExportSelectionShape {
  columnIndices: number[];
  columnCount: number;
  rowCount: number;
  rowRanges: ExportRowRange[];
}

/** Compresses the grid's union selection without expanding contiguous large ranges. */
export function exportSelectionShape(
  selection: GridSelection,
  visibleSourceIndices: readonly number[],
  viewRowCount: number,
): ExportSelectionShape | null {
  const scope = boundedSelectionScope(
    selection,
    viewRowCount,
    visibleSourceIndices.length,
  );
  if (scope === null) {
    return null;
  }
  const columnIndices = scope.columnIndices
    .map((visibleIndex) => visibleSourceIndices[visibleIndex])
    .filter((sourceIndex): sourceIndex is number => sourceIndex !== undefined);

  return {
    columnIndices,
    columnCount: columnIndices.length,
    rowCount: scope.rowCount,
    rowRanges: scope.rowRanges.map(([start, end]): ExportRowRange => ({
      start,
      end,
    })),
  };
}
