import { Type, type Batch, type DataType } from "@uwdata/flechette";

import { codePointSafePrefix } from "./unicode";

export interface ArrowValueRef {
  batch: Batch<unknown>;
  index: number;
  dataType: DataType;
  littleEndian?: boolean;
}

export interface ArrowMapEntryRef {
  entries: Batch<unknown>;
  index: number;
  keyType: DataType;
  valueType: DataType;
  littleEndian?: boolean;
}

export function arrowValueIsNull(value: ArrowValueRef): boolean {
  return value.batch.nullCount > 0 && !value.batch.isValid(value.index);
}

export function arrowScalarValue(value: ArrowValueRef): unknown {
  return arrowValueIsNull(value) ? null : value.batch.at(value.index);
}

export function arrowChildCount(value: ArrowValueRef): number {
  if (arrowValueIsNull(value)) return 0;
  const type = unwrapDictionary(value.dataType);
  if (type.typeId === Type.Struct) return type.children.length;
  const range = childRange(value, type);
  return range === null ? 0 : range.end - range.start;
}

export function arrowListChild(
  value: ArrowValueRef,
  ordinal: number,
): ArrowValueRef | undefined {
  const type = unwrapDictionary(value.dataType);
  const range = childRange(value, type);
  const childType = listChildType(type);
  const child = value.batch.children[0];
  if (
    range === null ||
    childType === undefined ||
    child === undefined ||
    ordinal < 0 ||
    range.start + ordinal >= range.end
  ) {
    return undefined;
  }
  return {
    batch: child,
    index: range.start + ordinal,
    dataType: childType,
    littleEndian: value.littleEndian,
  };
}

export function arrowStructChild(
  value: ArrowValueRef,
  ordinal: number,
): ArrowValueRef | undefined {
  const type = unwrapDictionary(value.dataType);
  const field =
    type.typeId === Type.Struct ? type.children[ordinal] : undefined;
  const child = value.batch.children[ordinal];
  return arrowValueIsNull(value) || field === undefined || child === undefined
    ? undefined
    : {
        batch: child,
        index: value.index,
        dataType: field.type,
        littleEndian: value.littleEndian,
      };
}

export function arrowMapEntry(
  value: ArrowValueRef,
  ordinal: number,
): ArrowMapEntryRef | undefined {
  const type = unwrapDictionary(value.dataType);
  if (type.typeId !== Type.Map) return undefined;
  const range = childRange(value, type);
  const entries = value.batch.children[0];
  const entriesType = type.children[0]?.type;
  const entriesStruct =
    entriesType === undefined ? undefined : unwrapDictionary(entriesType);
  const keyType =
    entriesStruct?.typeId === Type.Struct
      ? entriesStruct.children[0]?.type
      : undefined;
  const valueType =
    entriesStruct?.typeId === Type.Struct
      ? entriesStruct.children[1]?.type
      : undefined;
  if (
    range === null ||
    entries === undefined ||
    keyType === undefined ||
    valueType === undefined ||
    ordinal < 0 ||
    range.start + ordinal >= range.end
  ) {
    return undefined;
  }
  return {
    entries,
    index: range.start + ordinal,
    keyType,
    valueType,
    littleEndian: value.littleEndian,
  };
}

export function arrowMapEntryChild(
  entry: ArrowMapEntryRef,
  ordinal: number,
): ArrowValueRef | undefined {
  const batch = entry.entries.children[ordinal];
  const dataType = ordinal === 0 ? entry.keyType : entry.valueType;
  return batch === undefined || (ordinal !== 0 && ordinal !== 1)
    ? undefined
    : {
        batch,
        index: entry.index,
        dataType,
        littleEndian: entry.littleEndian,
      };
}

export function arrowUtf8Bytes(
  value: ArrowValueRef,
): { bytes: Uint8Array; start: number; end: number } | null {
  const type = value.dataType;
  if (
    arrowValueIsNull(value) ||
    (type.typeId !== Type.Utf8 &&
      type.typeId !== Type.LargeUtf8 &&
      type.typeId !== Type.Utf8View)
  ) {
    return null;
  }
  if (type.typeId === Type.Utf8View) return arrowViewBytes(value);
  const start = offsetNumber(value.batch.offsets[value.index]);
  const end = offsetNumber(value.batch.offsets[value.index + 1]);
  return start === null || end === null
    ? null
    : {
        bytes: value.batch.values as Uint8Array,
        start,
        end,
      };
}

export function arrowBinaryBytes(value: ArrowValueRef): Uint8Array | null {
  const type = value.dataType;
  if (arrowValueIsNull(value)) return null;
  if (type.typeId === Type.Binary || type.typeId === Type.LargeBinary) {
    const start = offsetNumber(value.batch.offsets[value.index]);
    const end = offsetNumber(value.batch.offsets[value.index + 1]);
    return start === null || end === null
      ? null
      : (value.batch.values as Uint8Array).subarray(start, end);
  }
  if (type.typeId === Type.FixedSizeBinary) {
    const start = value.index * type.stride;
    return (value.batch.values as Uint8Array).subarray(
      start,
      start + type.stride,
    );
  }
  if (type.typeId === Type.BinaryView) {
    const range = arrowViewBytes(value);
    return range === null ? null : range.bytes.subarray(range.start, range.end);
  }
  return null;
}

function arrowViewBytes(
  value: ArrowValueRef,
): { bytes: Uint8Array; start: number; end: number } | null {
  // Flechette raw-buffer layout access is intentionally isolated here; IPC
  // round-trip tests protect this boundary's layout compatibility.
  const descriptors = value.batch.values;
  if (!(descriptors instanceof Uint8Array)) return null;
  const descriptor = value.index * 16;
  if (descriptor < 0 || descriptor + 16 > descriptors.byteLength) return null;
  const view = new DataView(
    descriptors.buffer,
    descriptors.byteOffset,
    descriptors.byteLength,
  );
  const littleEndian = value.littleEndian ?? true;
  const length = view.getInt32(descriptor, littleEndian);
  if (length < 0) return null;
  if (length <= 12) {
    return {
      bytes: descriptors,
      start: descriptor + 4,
      end: descriptor + 4 + length,
    };
  }
  const buffers = (value.batch as Batch<unknown> & { data?: Uint8Array[] })
    .data;
  const bytes = buffers?.[view.getInt32(descriptor + 8, littleEndian)];
  const start = view.getInt32(descriptor + 12, littleEndian);
  return bytes === undefined || start < 0 || start + length > bytes.byteLength
    ? null
    : { bytes, start, end: start + length };
}

export function decodeArrowUtf8Prefix(
  value: ArrowValueRef,
  characterLimit: number,
): { text: string; truncated: boolean; totalBytes: number } | null {
  const range = arrowUtf8Bytes(value);
  if (range === null) return null;
  const byteLimit = Math.max(1, characterLimit) * 4;
  const rawEnd = Math.min(range.end, range.start + byteLimit);
  const safeEnd = utf8Boundary(range.bytes, range.start, rawEnd, range.end);
  const decoded = new TextDecoder().decode(
    range.bytes.subarray(range.start, safeEnd),
  );
  const text = codePointSafePrefix(decoded, characterLimit);
  return {
    text,
    truncated: safeEnd < range.end || decoded.length > text.length,
    totalBytes: range.end - range.start,
  };
}

function childRange(
  value: ArrowValueRef,
  type: DataType,
): { start: number; end: number } | null {
  if (arrowValueIsNull(value)) return null;
  if (
    type.typeId === Type.List ||
    type.typeId === Type.LargeList ||
    type.typeId === Type.Map
  ) {
    const start = offsetNumber(value.batch.offsets[value.index]);
    const end = offsetNumber(value.batch.offsets[value.index + 1]);
    return start === null || end === null ? null : { start, end };
  }
  if (type.typeId === Type.ListView || type.typeId === Type.LargeListView) {
    const start = offsetNumber(value.batch.offsets[value.index]);
    const size = offsetNumber(value.batch.sizes[value.index]);
    return start === null || size === null
      ? null
      : { start, end: start + size };
  }
  if (type.typeId === Type.FixedSizeList) {
    const start = value.index * type.stride;
    return { start, end: start + type.stride };
  }
  return null;
}

function offsetNumber(value: number | bigint | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "bigint") return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function utf8Boundary(
  bytes: Uint8Array,
  start: number,
  candidate: number,
  end: number,
): number {
  if (candidate >= end) return end;
  let boundary = candidate;
  while (boundary > start && (bytes[boundary]! & 0xc0) === 0x80) {
    boundary -= 1;
  }
  return boundary;
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
}

function listChildType(dataType: DataType): DataType | undefined {
  switch (dataType.typeId) {
    case Type.List:
    case Type.LargeList:
    case Type.FixedSizeList:
    case Type.ListView:
    case Type.LargeListView:
      return dataType.children[0]?.type;
    default:
      return undefined;
  }
}
