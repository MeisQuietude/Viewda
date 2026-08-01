import {
  tableFromIPC,
  type DataType,
  type Field,
  type Table,
} from "@uwdata/flechette";

export interface ArrowDataWindow {
  rowOffset: number;
  rowCount: number;
  table: Table;
}

export function decodeArrowWindow(
  bytes: ArrayBuffer,
  rowOffset: number,
): ArrowDataWindow {
  const table = tableFromIPC(bytes, {
    useBigInt: true,
    useBigIntTimestamp: true,
    useDecimalInt: true,
    useMap: true,
  });
  return { rowOffset, rowCount: table.numRows, table };
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
  return window.table.getChildAt(column).at(row - window.rowOffset);
}

export function windowField(
  window: ArrowDataWindow,
  column: number,
): Field | undefined {
  return window.table.schema.fields[column];
}

export function windowDataType(
  window: ArrowDataWindow,
  column: number,
): DataType | undefined {
  return windowField(window, column)?.type;
}
