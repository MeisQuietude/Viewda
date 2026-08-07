import {
  type CompactSelection,
  type GridSelection,
  type Rectangle,
} from "@glideapps/glide-data-grid";

import type { ExportRowRange } from "../desktop";

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
  const rowRanges: ExportRowRange[] = [];
  const visibleColumns = new Set<number>();
  const rectangles =
    selection.current === undefined
      ? []
      : [selection.current.range, ...selection.current.rangeStack];

  for (const rectangle of rectangles) {
    addRectangleRows(rowRanges, rectangle, viewRowCount);
    addRectangleColumns(visibleColumns, rectangle, visibleSourceIndices.length);
  }
  rowRanges.push(...compactSelectionRanges(selection.rows, viewRowCount));
  for (const visibleIndex of selection.columns) {
    if (visibleIndex >= 0 && visibleIndex < visibleSourceIndices.length) {
      visibleColumns.add(visibleIndex);
    }
  }

  const hasSelectedRows = rowRanges.length > 0;
  const hasSelectedColumns = visibleColumns.size > 0;
  if (!hasSelectedRows && !hasSelectedColumns) {
    return null;
  }
  if (!hasSelectedRows && viewRowCount > 0) {
    rowRanges.push({ start: 0, end: viewRowCount });
  }
  if (!hasSelectedColumns) {
    for (let index = 0; index < visibleSourceIndices.length; index += 1) {
      visibleColumns.add(index);
    }
  }

  const normalizedRows = normalizeRanges(rowRanges);
  const columnIndices = [...visibleColumns]
    .sort((left, right) => left - right)
    .map((visibleIndex) => visibleSourceIndices[visibleIndex])
    .filter((sourceIndex): sourceIndex is number => sourceIndex !== undefined);
  if (normalizedRows.length === 0 || columnIndices.length === 0) {
    return null;
  }

  return {
    columnIndices,
    columnCount: columnIndices.length,
    rowCount: normalizedRows.reduce(
      (count, range) => count + range.end - range.start,
      0,
    ),
    rowRanges: normalizedRows,
  };
}

function addRectangleRows(
  ranges: ExportRowRange[],
  rectangle: Rectangle,
  rowCount: number,
) {
  const start = Math.max(0, Math.min(rowCount, rectangle.y));
  const end = Math.max(
    start,
    Math.min(rowCount, rectangle.y + rectangle.height),
  );
  if (start < end) {
    ranges.push({ start, end });
  }
}

function addRectangleColumns(
  columns: Set<number>,
  rectangle: Rectangle,
  columnCount: number,
) {
  const start = Math.max(0, Math.min(columnCount, rectangle.x));
  const end = Math.max(
    start,
    Math.min(columnCount, rectangle.x + rectangle.width),
  );
  for (let index = start; index < end; index += 1) {
    columns.add(index);
  }
}

function compactSelectionRanges(
  selection: CompactSelection,
  upperBound: number,
): ExportRowRange[] {
  const first = selection.first();
  const last = selection.last();
  if (first === undefined || last === undefined) {
    return [];
  }
  if (selection.length === last - first + 1) {
    const start = Math.max(0, Math.min(upperBound, first));
    const end = Math.max(start, Math.min(upperBound, last + 1));
    return start < end ? [{ start, end }] : [];
  }

  const ranges: ExportRowRange[] = [];
  for (const index of selection) {
    if (index < 0 || index >= upperBound) {
      continue;
    }
    const previous = ranges.at(-1);
    if (previous?.end === index) {
      previous.end += 1;
    } else {
      ranges.push({ start: index, end: index + 1 });
    }
  }
  return ranges;
}

function normalizeRanges(ranges: readonly ExportRowRange[]): ExportRowRange[] {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const normalized: ExportRowRange[] = [];
  for (const range of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      normalized.push({ ...range });
    }
  }
  return normalized;
}
