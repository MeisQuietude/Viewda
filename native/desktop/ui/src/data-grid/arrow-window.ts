import {
  Endianness,
  tableFromIPC,
  type Batch,
  type DataType,
  type Field,
  type Table,
} from "@uwdata/flechette";

import type { ArrowValueRef } from "./arrow-value";

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
    // Ordered entries preserve duplicate Arrow map keys and make child lookup
    // constant-time; JavaScript Map would discard duplicates on extraction.
    useMap: false,
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
  // Flechette may materialize a nested JavaScript value at this Arrow boundary.
  // Preview formatting must not add a full traversal or serialization afterward.
  return columnOffset === undefined
    ? undefined
    : window.table.getChildAt(columnOffset).at(row - window.rowOffset);
}

export function windowArrowValue(
  window: ArrowDataWindow,
  column: number,
  row: number,
): ArrowValueRef | undefined {
  const columnOffset = window.sourceColumnOffsets.get(column);
  const field = windowField(window, column);
  if (columnOffset === undefined || field === undefined) return undefined;
  const dataColumn = window.table.getChildAt(columnOffset);
  const relativeRow = row - window.rowOffset;
  if (dataColumn.offsets === undefined || dataColumn.data === undefined) {
    return undefined;
  }
  const batchIndex = batchIndexAt(dataColumn.offsets, relativeRow);
  const batch = dataColumn.data[batchIndex] as Batch<unknown> | undefined;
  const batchStart = dataColumn.offsets[batchIndex];
  return batch === undefined || batchStart === undefined
    ? undefined
    : {
        batch,
        index: relativeRow - batchStart,
        dataType: field.type,
        littleEndian: window.table.schema.endianness !== Endianness.Big,
      };
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

function batchIndexAt(offsets: Int32Array, index: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (offsets[middle]! <= index) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, Math.max(0, offsets.length - 2));
}
