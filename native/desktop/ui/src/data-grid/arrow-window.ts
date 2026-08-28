import {
  Endianness,
  tableFromIPC,
  type Batch,
  type DataType,
  type Field,
  type Table,
} from "@uwdata/flechette";

import type { ArrowValueRef } from "./arrow-value";
import type { FieldPath } from "../desktop";
import { fieldPathKey } from "./field-path";

export interface ArrowDataWindow {
  rowOffset: number;
  rowCount: number;
  fieldPaths: readonly FieldPath[];
  fieldColumnOffsets: ReadonlyMap<string, number>;
  table: Table;
}

export function decodeArrowWindow(
  bytes: ArrayBuffer,
  rowOffset: number,
  fieldPaths: readonly FieldPath[],
  options: { allowDuplicateTopLevelIdentity?: boolean } = {},
): ArrowDataWindow {
  const table = tableFromIPC(bytes, {
    useBigInt: true,
    useBigIntTimestamp: true,
    useDecimalInt: true,
    // Ordered entries preserve duplicate Arrow map keys and make child lookup
    // constant-time; JavaScript Map would discard duplicates on extraction.
    useMap: false,
  });
  if (table.schema.fields.length !== fieldPaths.length) {
    throw new Error(
      "The data window projection does not match its Arrow schema.",
    );
  }
  const fieldColumnOffsets = new Map<string, number>();
  fieldPaths.forEach((fieldPath, columnOffset) => {
    const key = fieldPathKey(fieldPath);
    if (fieldColumnOffsets.has(key)) {
      if (
        !options.allowDuplicateTopLevelIdentity ||
        fieldPaths.some((path) => path.length !== 1)
      ) {
        throw new Error(
          "The data window projection contains a duplicate column.",
        );
      }
    } else {
      fieldColumnOffsets.set(key, columnOffset);
    }
  });
  return {
    rowOffset,
    rowCount: table.numRows,
    fieldPaths: fieldPaths.map((path) => [...path]),
    fieldColumnOffsets,
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
  fieldPath: readonly string[],
  row: number,
): unknown {
  const columnOffset = window.fieldColumnOffsets.get(fieldPathKey(fieldPath));
  // Flechette may materialize a nested JavaScript value at this Arrow boundary.
  // Preview formatting must not add a full traversal or serialization afterward.
  return columnOffset === undefined
    ? undefined
    : windowValueAt(window, columnOffset, row);
}

export function windowValueAt(
  window: ArrowDataWindow,
  columnOffset: number,
  row: number,
): unknown {
  return window.table.getChildAt(columnOffset).at(row - window.rowOffset);
}

export function windowArrowValue(
  window: ArrowDataWindow,
  fieldPath: readonly string[],
  row: number,
): ArrowValueRef | undefined {
  const columnOffset = window.fieldColumnOffsets.get(fieldPathKey(fieldPath));
  return columnOffset === undefined
    ? undefined
    : windowArrowValueAt(window, columnOffset, row);
}

export function windowArrowValueAt(
  window: ArrowDataWindow,
  columnOffset: number,
  row: number,
): ArrowValueRef | undefined {
  const field = window.table.schema.fields[columnOffset];
  if (field === undefined) return undefined;
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
  fieldPath: readonly string[],
): Field | undefined {
  const columnOffset = window.fieldColumnOffsets.get(fieldPathKey(fieldPath));
  return columnOffset === undefined
    ? undefined
    : window.table.schema.fields[columnOffset];
}

export function windowDataType(
  window: ArrowDataWindow,
  fieldPath: readonly string[],
): DataType | undefined {
  return windowField(window, fieldPath)?.type;
}

export function windowDataTypeAt(
  window: ArrowDataWindow,
  columnOffset: number,
): DataType | undefined {
  return window.table.schema.fields[columnOffset]?.type;
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
