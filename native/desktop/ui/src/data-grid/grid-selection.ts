import {
  CompactSelection,
  type GridAddress,
  type GridSelection,
  type Rectangle,
  type SelectionRange,
} from "./grid-model";

export interface BoundedSelectionScope {
  columnIndices: number[];
  rowCount: number;
  rowRanges: SelectionRange[];
}

export function emptyGridSelection(): GridSelection {
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
}

export function selectCell(
  selection: GridSelection,
  cell: GridAddress,
  extend: boolean,
  additive: boolean,
): GridSelection {
  const anchor =
    extend && selection.current !== undefined
      ? selectionAnchor(selection.current)
      : cell;
  const range = rectangleBetween(anchor, cell);
  const previous = selection.current;
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    current: {
      cell,
      range,
      rangeStack:
        additive && previous !== undefined
          ? [previous.range, ...previous.rangeStack]
          : extend
            ? (previous?.rangeStack ?? [])
            : [],
    },
  };
}

export function selectRow(
  selection: GridSelection,
  row: number,
  extend: boolean,
  additive: boolean,
): GridSelection {
  const anchor = extend
    ? (selection.rowAnchor ?? selection.rows.first() ?? row)
    : row;
  const range = [Math.min(anchor, row), Math.max(anchor, row) + 1] as const;
  return {
    columns: CompactSelection.empty(),
    rows: additive
      ? selection.rows.add(range)
      : CompactSelection.fromSingleSelection(range),
    rowAnchor: anchor,
  };
}

export function selectColumn(
  selection: GridSelection,
  column: number,
  extend: boolean,
  additive: boolean,
): GridSelection {
  const anchor = extend
    ? (selection.columnAnchor ?? selection.columns.first() ?? column)
    : column;
  const range = [
    Math.min(anchor, column),
    Math.max(anchor, column) + 1,
  ] as const;
  return {
    columns: additive
      ? selection.columns.add(range)
      : CompactSelection.fromSingleSelection(range),
    rows: CompactSelection.empty(),
    columnAnchor: anchor,
  };
}

/** Returns the bounded Cartesian union represented by a grid selection. */
export function boundedSelectionScope(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): BoundedSelectionScope | null {
  if (rowCount <= 0 || columnCount <= 0) {
    return null;
  }
  const rowRanges: SelectionRange[] = [];
  const columns = new Set<number>();
  const rectangles =
    selection.current === undefined
      ? []
      : [selection.current.range, ...selection.current.rangeStack];
  for (const rectangle of rectangles) {
    addRectangleRows(rowRanges, rectangle, rowCount);
    addRectangleColumns(columns, rectangle, columnCount);
  }
  rowRanges.push(...boundedRanges(selection.rows.ranges(), rowCount));
  for (const column of selection.columns) {
    if (column >= 0 && column < columnCount) {
      columns.add(column);
    }
  }

  if (rowRanges.length === 0 && columns.size === 0) {
    return null;
  }
  if (rowRanges.length === 0) {
    rowRanges.push([0, rowCount]);
  }
  if (columns.size === 0) {
    for (let column = 0; column < columnCount; column += 1) {
      columns.add(column);
    }
  }
  const normalizedRows = normalizeRanges(rowRanges);
  if (normalizedRows.length === 0 || columns.size === 0) {
    return null;
  }
  return {
    columnIndices: [...columns].sort((left, right) => left - right),
    rowCount: normalizedRows.reduce(
      (count, [start, end]) => count + end - start,
      0,
    ),
    rowRanges: normalizedRows,
  };
}

export function moveSelection(
  selection: GridSelection,
  rowDelta: number,
  columnDelta: number,
  rowCount: number,
  columnCount: number,
  extend: boolean,
): GridSelection {
  const current = selection.current?.cell ?? { row: 0, column: 0 };
  return selectCell(
    selection,
    {
      row: clamp(current.row + rowDelta, 0, Math.max(0, rowCount - 1)),
      column: clamp(
        current.column + columnDelta,
        0,
        Math.max(0, columnCount - 1),
      ),
    },
    extend,
    false,
  );
}

export function cellIsSelected(
  selection: GridSelection,
  row: number,
  column: number,
): boolean {
  if (selection.rows.hasIndex(row) || selection.columns.hasIndex(column)) {
    return true;
  }
  const ranges =
    selection.current === undefined
      ? []
      : [selection.current.range, ...selection.current.rangeStack];
  return ranges.some(
    (range) =>
      row >= range.y &&
      row < range.y + range.height &&
      column >= range.x &&
      column < range.x + range.width,
  );
}

function rectangleBetween(left: GridAddress, right: GridAddress): Rectangle {
  const x = Math.min(left.column, right.column);
  const y = Math.min(left.row, right.row);
  return {
    x,
    y,
    width: Math.abs(left.column - right.column) + 1,
    height: Math.abs(left.row - right.row) + 1,
  };
}

function addRectangleRows(
  ranges: SelectionRange[],
  rectangle: Rectangle,
  rowCount: number,
) {
  const bounded = boundedRange(
    [rectangle.y, rectangle.y + rectangle.height],
    rowCount,
  );
  if (bounded !== null) {
    ranges.push(bounded);
  }
}

function addRectangleColumns(
  columns: Set<number>,
  rectangle: Rectangle,
  columnCount: number,
) {
  const bounded = boundedRange(
    [rectangle.x, rectangle.x + rectangle.width],
    columnCount,
  );
  if (bounded !== null) {
    for (let column = bounded[0]; column < bounded[1]; column += 1) {
      columns.add(column);
    }
  }
}

function boundedRanges(
  ranges: readonly SelectionRange[],
  upperBound: number,
): SelectionRange[] {
  return ranges.flatMap((range) => {
    const bounded = boundedRange(range, upperBound);
    return bounded === null ? [] : [bounded];
  });
}

function boundedRange(
  [rangeStart, rangeEnd]: SelectionRange,
  upperBound: number,
): SelectionRange | null {
  const start = Math.max(0, Math.min(upperBound, rangeStart));
  const end = Math.max(start, Math.min(upperBound, rangeEnd));
  return start < end ? [start, end] : null;
}

function normalizeRanges(ranges: readonly SelectionRange[]): SelectionRange[] {
  const sorted = [...ranges].sort(
    ([leftStart, leftEnd], [rightStart, rightEnd]) =>
      leftStart - rightStart || leftEnd - rightEnd,
  );
  const normalized: [number, number][] = [];
  for (const [start, end] of sorted) {
    const previous = normalized.at(-1);
    if (previous !== undefined && start <= previous[1]) {
      previous[1] = Math.max(previous[1], end);
    } else {
      normalized.push([start, end]);
    }
  }
  return normalized;
}

function selectionAnchor(
  current: NonNullable<GridSelection["current"]>,
): GridAddress {
  const right = current.range.x + current.range.width - 1;
  const bottom = current.range.y + current.range.height - 1;
  return {
    column: current.cell.column === current.range.x ? right : current.range.x,
    row: current.cell.row === current.range.y ? bottom : current.range.y,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
