import {
  tableFromIPC,
  type DataType,
  type Field,
  type Table,
} from "@uwdata/flechette";

export interface ArrowDataWindow {
  rowOffset: number;
  rowCount: number;
  sourceIndices: readonly number[];
  sourceColumnOffsets: ReadonlyMap<number, number>;
  table: Table;
}

export function decodeArrowWindow(
  bytes: ArrayBuffer,
  rowOffset: number,
  sourceIndices: readonly number[],
): ArrowDataWindow {
  const table = tableFromIPC(bytes, {
    useBigInt: true,
    useBigIntTimestamp: true,
    useDecimalInt: true,
    useMap: true,
  });
  if (table.schema.fields.length !== sourceIndices.length) {
    throw new Error(
      "The data window projection does not match its Arrow schema.",
    );
  }
  const sourceColumnOffsets = new Map<number, number>();
  sourceIndices.forEach((sourceIndex, columnOffset) => {
    if (sourceColumnOffsets.has(sourceIndex)) {
      throw new Error(
        "The data window projection contains a duplicate column.",
      );
    }
    sourceColumnOffsets.set(sourceIndex, columnOffset);
  });
  return {
    rowOffset,
    rowCount: table.numRows,
    sourceIndices: [...sourceIndices],
    sourceColumnOffsets,
    table,
  };
}

export function windowContainsRow(
  window: ArrowDataWindow,
  row: number,
): boolean {
  return row >= window.rowOffset && row < window.rowOffset + window.rowCount;
}

export function windowValue(
  window: ArrowDataWindow,
  column: number,
  row: number,
): unknown {
  const columnOffset = window.sourceColumnOffsets.get(column);
  return columnOffset === undefined
    ? undefined
    : window.table.getChildAt(columnOffset).at(row - window.rowOffset);
}

function windowField(
  window: ArrowDataWindow,
  column: number,
): Field | undefined {
  const columnOffset = window.sourceColumnOffsets.get(column);
  return columnOffset === undefined
    ? undefined
    : window.table.schema.fields[columnOffset];
}

export function windowDataType(
  window: ArrowDataWindow,
  column: number,
): DataType | undefined {
  return windowField(window, column)?.type;
}
