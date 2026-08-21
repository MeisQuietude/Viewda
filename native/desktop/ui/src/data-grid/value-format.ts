import {
  DateUnit,
  Precision,
  TimeUnit,
  Type,
  type DataType,
  type Field,
} from "@uwdata/flechette";

import { decimalToText, timestampToText } from "./filter-query";

export const VALUE_PREVIEW_LIMIT = 120;
const BASE64_INPUT_CHUNK_BYTES = 24 * 1024;

export type ValuePathSegment = string | number;

export type TypedValue =
  | { kind: "value"; value: unknown; dataType: DataType }
  | {
      kind: "mapEntry";
      key: unknown;
      value: unknown;
      keyType: DataType;
      valueType: DataType;
    };

export interface ValueChild {
  label: string;
  pathSegment: ValuePathSegment;
  value: TypedValue;
}

export function typedValue(value: unknown, dataType: DataType): TypedValue {
  return { kind: "value", value, dataType };
}

export function formatValuePreview(
  input: TypedValue,
  limit = VALUE_PREVIEW_LIMIT,
): string {
  return preview(input, Math.max(1, limit), 0);
}

export function formatCellDisplay(input: TypedValue): string {
  if (input.kind === "mapEntry") return formatValuePreview(input);
  const type = unwrapDictionary(input.dataType);
  return isNested(type)
    ? formatValuePreview(input)
    : formatScalarDisplay(input.value, type, false);
}

export function valueToJson(input: TypedValue): string {
  if (input.kind === "mapEntry") {
    return `[${valueToJson(typedValue(input.key, input.keyType))},${valueToJson(
      typedValue(input.value, input.valueType),
    )}]`;
  }

  const type = unwrapDictionary(input.dataType);
  const value = input.value;
  if (value === null || value === undefined) return "null";
  if (isBinary(type)) {
    return JSON.stringify(bytesToBase64(asBytes(value)));
  }
  if (type.typeId === Type.Decimal) {
    return decimalToText(value, type.scale);
  }
  if (type.typeId === Type.Date) {
    return JSON.stringify(formatScalarDisplay(value, type));
  }
  if (type.typeId === Type.Int || type.typeId === Type.Time) {
    return jsonInteger(value);
  }
  if (type.typeId === Type.Timestamp || type.typeId === Type.Duration) {
    return jsonInteger(value);
  }
  if (isList(type)) {
    const count = arrayLikeLength(value);
    const output: string[] = [];
    const childType = listChildType(type);
    if (childType === undefined) return "[]";
    for (let index = 0; index < count; index += 1) {
      output.push(
        valueToJson(typedValue(arrayLikeAt(value, index), childType)),
      );
    }
    return `[${output.join(",")}]`;
  }
  if (type.typeId === Type.Struct) {
    const output: string[] = [];
    for (const field of type.children) {
      output.push(
        `${JSON.stringify(field.name)}:${valueToJson(
          typedValue(structFieldValue(value, field.name), field.type),
        )}`,
      );
    }
    return `{${output.join(",")}}`;
  }
  if (type.typeId === Type.Map) {
    const [keyType, valueType] = mapTypes(type.children[0]);
    if (keyType === undefined || valueType === undefined) return "[]";
    const entries = mapEntries(value);
    if (isStringType(keyType)) {
      const output: string[] = [];
      for (const [key, item] of entries) {
        output.push(
          `${JSON.stringify(String(key))}:${valueToJson(
            typedValue(item, valueType),
          )}`,
        );
      }
      return `{${output.join(",")}}`;
    }
    const output: string[] = [];
    for (const [key, item] of entries) {
      output.push(
        `[${valueToJson(typedValue(key, keyType))},${valueToJson(
          typedValue(item, valueType),
        )}]`,
      );
    }
    return `[${output.join(",")}]`;
  }

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return jsonInteger(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  return JSON.stringify(String(value));
}

export function valueChildCount(input: TypedValue): number {
  if (input.kind === "mapEntry") return 2;
  if (input.value === null || input.value === undefined) return 0;
  const type = unwrapDictionary(input.dataType);
  if (isList(type)) return arrayLikeLength(input.value);
  if (type.typeId === Type.Struct) return type.children.length;
  if (type.typeId === Type.Map) {
    return input.value instanceof Map
      ? input.value.size
      : Array.isArray(input.value)
        ? input.value.length
        : 0;
  }
  return 0;
}

export function valueChildAt(
  input: TypedValue,
  index: number,
): ValueChild | undefined {
  if (index < 0 || index >= valueChildCount(input)) return undefined;
  if (input.kind === "mapEntry") {
    return index === 0
      ? {
          label: "[0]",
          pathSegment: 0,
          value: typedValue(input.key, input.keyType),
        }
      : {
          label: "[1]",
          pathSegment: 1,
          value: typedValue(input.value, input.valueType),
        };
  }

  const type = unwrapDictionary(input.dataType);
  if (isList(type)) {
    const childType = listChildType(type);
    return childType === undefined
      ? undefined
      : {
          label: `[${index}]`,
          pathSegment: index,
          value: typedValue(arrayLikeAt(input.value, index), childType),
        };
  }
  if (type.typeId === Type.Struct) {
    const field = type.children[index];
    return field === undefined
      ? undefined
      : {
          label: field.name,
          pathSegment: field.name,
          value: typedValue(
            structFieldValue(input.value, field.name),
            field.type,
          ),
        };
  }
  if (type.typeId === Type.Map) {
    const entry = mapEntryAt(input.value, index);
    const [keyType, valueType] = mapTypes(type.children[0]);
    if (
      entry === undefined ||
      keyType === undefined ||
      valueType === undefined
    ) {
      return undefined;
    }
    const [key, value] = entry;
    if (isStringType(keyType)) {
      return {
        label: String(key),
        pathSegment: String(key),
        value: typedValue(value, valueType),
      };
    }
    return {
      label: `[${index}]`,
      pathSegment: index,
      value: { kind: "mapEntry", key, value, keyType, valueType },
    };
  }
  return undefined;
}

export function valueTypeLabel(input: TypedValue): string {
  return input.kind === "mapEntry"
    ? `[${dataTypeLabel(input.keyType)}, ${dataTypeLabel(input.valueType)}]`
    : dataTypeLabel(input.dataType);
}

export function formatValuePath(segments: readonly ValuePathSegment[]): string {
  let output = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      output += `[${segment}]`;
      continue;
    }
    const encoded = /^[A-Za-z0-9_]+$/.test(segment)
      ? segment
      : JSON.stringify(segment);
    output += output.length === 0 ? encoded : `.${encoded}`;
  }
  return output;
}

export function fullValueText(input: TypedValue): string {
  if (input.kind === "mapEntry") return formatValuePreview(input);
  const type = unwrapDictionary(input.dataType);
  if (isBinary(type)) return bytesToHexDump(asBytes(input.value));
  if (isNested(type)) return formatValuePreview(input);
  return formatScalarDisplay(input.value, type, false);
}

export function isBinaryValue(input: TypedValue): boolean {
  return input.kind === "value" && isBinary(unwrapDictionary(input.dataType));
}

export function isNestedValue(input: TypedValue): boolean {
  return (
    input.kind === "mapEntry" ||
    (input.kind === "value" && isNested(unwrapDictionary(input.dataType)))
  );
}

export function isNumericType(dataType: DataType): boolean {
  const type = unwrapDictionary(dataType);
  return (
    type.typeId === Type.Int ||
    type.typeId === Type.Float ||
    type.typeId === Type.Decimal
  );
}

export function dataTypeLabel(dataType: DataType): string {
  const type = unwrapDictionary(dataType);
  switch (type.typeId) {
    case Type.Null:
      return "null";
    case Type.Int:
      return `${type.signed ? "int" : "uint"}${type.bitWidth}`;
    case Type.Float:
      return `float${
        type.precision === Precision.HALF
          ? 16
          : type.precision === Precision.SINGLE
            ? 32
            : 64
      }`;
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
    case Type.BinaryView:
      return "binary";
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Utf8View:
      return "string";
    case Type.Bool:
      return "boolean";
    case Type.Decimal:
      return `decimal(${type.precision}, ${type.scale})`;
    case Type.Date:
      return type.unit === DateUnit.DAY ? "date32" : "date64";
    case Type.Time:
      return `time[${timeUnitLabel(type.unit)}]`;
    case Type.Timestamp:
      return `timestamp[${timeUnitLabel(type.unit)}${
        type.timezone === null ? "" : `, ${type.timezone}`
      }]`;
    case Type.Duration:
      return `duration[${timeUnitLabel(type.unit)}]`;
    case Type.List:
    case Type.LargeList:
    case Type.FixedSizeList:
    case Type.ListView:
    case Type.LargeListView:
      return `list<${
        listChildType(type) === undefined
          ? "unknown"
          : dataTypeLabel(listChildType(type)!)
      }>`;
    case Type.Struct:
      return `struct<${type.children
        .map((field) => `${field.name}: ${dataTypeLabel(field.type)}`)
        .join(", ")}>`;
    case Type.Map: {
      const [keyType, valueType] = mapTypes(type.children[0]);
      return `map<${
        keyType === undefined ? "unknown" : dataTypeLabel(keyType)
      }, ${valueType === undefined ? "unknown" : dataTypeLabel(valueType)}>`;
    }
    default:
      return "value";
  }
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function preview(input: TypedValue, limit: number, depth: number): string {
  if (input.kind === "mapEntry") {
    return fitToken(
      `${preview(typedValue(input.key, input.keyType), limit, depth + 1)} → ${preview(
        typedValue(input.value, input.valueType),
        limit,
        depth + 1,
      )}`,
      limit,
    );
  }
  const type = unwrapDictionary(input.dataType);
  const value = input.value;
  if (value === null || value === undefined) return "null";
  if (depth > 0 && isNested(type)) {
    return isList(type) ? "[…]" : "{…}";
  }
  if (isList(type)) {
    const count = arrayLikeLength(value);
    return previewItems(`[${count}]`, count, limit, (index, itemLimit) => {
      const childType = listChildType(type);
      return childType === undefined
        ? "null"
        : preview(
            typedValue(arrayLikeAt(value, index), childType),
            itemLimit,
            depth + 1,
          );
    });
  }
  if (type.typeId === Type.Struct) {
    return previewDelimited(
      "{",
      "}",
      type.children.length,
      limit,
      (index, itemLimit) => {
        const field = type.children[index];
        if (field === undefined) return "";
        const name = /^[A-Za-z0-9_]+$/.test(field.name)
          ? field.name
          : JSON.stringify(field.name);
        return `${name}: ${preview(
          typedValue(structFieldValue(value, field.name), field.type),
          Math.max(1, itemLimit - name.length - 2),
          depth + 1,
        )}`;
      },
    );
  }
  if (type.typeId === Type.Map) {
    const count = valueChildCount(input);
    const [keyType, valueType] = mapTypes(type.children[0]);
    return previewItems(`{${count}}`, count, limit, (index, itemLimit) => {
      const entry = mapEntryAt(value, index);
      if (
        entry === undefined ||
        keyType === undefined ||
        valueType === undefined
      ) {
        return "";
      }
      return `${preview(
        typedValue(entry[0], keyType),
        itemLimit,
        depth + 1,
      )} → ${preview(typedValue(entry[1], valueType), itemLimit, depth + 1)}`;
    });
  }
  return fitToken(formatScalarDisplay(value, type), limit);
}

function previewItems(
  prefix: string,
  count: number,
  limit: number,
  item: (index: number, limit: number) => string,
): string {
  if (count === 0 || prefix.length >= limit) return fitToken(prefix, limit);
  let output = prefix;
  for (let index = 0; index < count; index += 1) {
    const separator = index === 0 ? " " : ", ";
    const remaining = limit - output.length - separator.length;
    const token = remaining > 0 ? item(index, remaining) : "";
    if (token.length === 0 || token.length > remaining) {
      return appendEllipsis(output, limit);
    }
    output += `${separator}${token}`;
  }
  return output;
}

function previewDelimited(
  open: string,
  close: string,
  count: number,
  limit: number,
  item: (index: number, limit: number) => string,
): string {
  if (count === 0) return `${open}${close}`;
  let output = open;
  for (let index = 0; index < count; index += 1) {
    const separator = index === 0 ? "" : ", ";
    const remaining = limit - output.length - separator.length - close.length;
    const token = remaining > 0 ? item(index, remaining) : "";
    if (token.length === 0 || token.length > remaining) {
      return `${appendEllipsis(output, Math.max(1, limit - close.length))}${close}`;
    }
    output += `${separator}${token}`;
  }
  return `${output}${close}`;
}

function formatScalarDisplay(
  value: unknown,
  dataType: DataType,
  quoteStrings = true,
): string {
  if (value === null || value === undefined) return "null";
  if (isBinary(dataType)) {
    return `binary · ${formatByteSize(asBytes(value).byteLength)}`;
  }
  if (dataType.typeId === Type.Timestamp) {
    return timestampToText(value, dataType.unit);
  }
  if (dataType.typeId === Type.Date) {
    return timestampToText(value, TimeUnit.MILLISECOND).slice(0, 10);
  }
  if (dataType.typeId === Type.Decimal) {
    return decimalToText(value, dataType.scale);
  }
  if (typeof value === "string") {
    return quoteStrings ? JSON.stringify(value) : value;
  }
  return String(value);
}

function jsonInteger(value: unknown): string {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? value.toString()
      : JSON.stringify(value.toString());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isSafeInteger(value)
      ? String(value)
      : JSON.stringify(String(value));
  }
  return JSON.stringify(String(value));
}

function fitToken(token: string, limit: number): string {
  if (token.length <= limit) return token;
  if (limit <= 1) return "…";
  return `${token.slice(0, limit - 1)}…`;
}

function appendEllipsis(output: string, limit: number): string {
  if (output.endsWith("…")) return output;
  if (output.length < limit) return `${output}…`;
  return fitToken(output, limit);
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
}

function isBinary(dataType: DataType): boolean {
  return (
    dataType.typeId === Type.Binary ||
    dataType.typeId === Type.LargeBinary ||
    dataType.typeId === Type.FixedSizeBinary ||
    dataType.typeId === Type.BinaryView
  );
}

function isStringType(dataType: DataType): boolean {
  const type = unwrapDictionary(dataType);
  return (
    type.typeId === Type.Utf8 ||
    type.typeId === Type.LargeUtf8 ||
    type.typeId === Type.Utf8View
  );
}

function isList(dataType: DataType): boolean {
  return (
    dataType.typeId === Type.List ||
    dataType.typeId === Type.LargeList ||
    dataType.typeId === Type.FixedSizeList ||
    dataType.typeId === Type.ListView ||
    dataType.typeId === Type.LargeListView
  );
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

function isNested(dataType: DataType): boolean {
  return (
    isList(dataType) ||
    dataType.typeId === Type.Struct ||
    dataType.typeId === Type.Map
  );
}

function arrayLikeLength(value: unknown): number {
  return value !== null &&
    typeof value === "object" &&
    "length" in value &&
    typeof value.length === "number"
    ? Math.max(0, Math.floor(value.length))
    : 0;
}

function arrayLikeAt(value: unknown, index: number): unknown {
  return value !== null && typeof value === "object" && index in value
    ? (value as Record<number, unknown>)[index]
    : undefined;
}

function structFieldValue(value: unknown, name: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function mapEntries(value: unknown): Iterable<readonly [unknown, unknown]> {
  if (value instanceof Map) return value.entries();
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      Array.isArray(entry) && entry.length >= 2
        ? [[entry[0], entry[1]] as const]
        : [],
    );
  }
  return [];
}

function mapEntryAt(
  value: unknown,
  index: number,
): readonly [unknown, unknown] | undefined {
  if (value instanceof Map) {
    let entryIndex = 0;
    for (const entry of value.entries()) {
      if (entryIndex === index) return entry;
      entryIndex += 1;
    }
    return undefined;
  }
  const entry = Array.isArray(value) ? value[index] : undefined;
  return Array.isArray(entry) && entry.length >= 2
    ? [entry[0], entry[1]]
    : undefined;
}

function mapTypes(
  entriesField: Field | undefined,
): [DataType | undefined, DataType | undefined] {
  const entriesType =
    entriesField === undefined
      ? undefined
      : unwrapDictionary(entriesField.type);
  return entriesType?.typeId === Type.Struct
    ? [entriesType.children[0]?.type, entriesType.children[1]?.type]
    : [undefined, undefined];
}

function asBytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array();
}

function bytesToBase64(bytes: Uint8Array): string {
  const encodedChunks: string[] = [];
  for (
    let offset = 0;
    offset < bytes.length;
    offset += BASE64_INPUT_CHUNK_BYTES
  ) {
    encodedChunks.push(
      btoa(
        String.fromCharCode(
          ...bytes.subarray(offset, offset + BASE64_INPUT_CHUNK_BYTES),
        ),
      ),
    );
  }
  return encodedChunks.join("");
}

function bytesToHexDump(bytes: Uint8Array): string {
  const lines = [`binary · ${formatByteSize(bytes.byteLength)}`];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const chunk = bytes.subarray(offset, offset + 16);
    const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(chunk, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`);
  }
  return lines.join("\n");
}

function timeUnitLabel(unit: number): string {
  if (unit === TimeUnit.SECOND) return "s";
  if (unit === TimeUnit.MILLISECOND) return "ms";
  if (unit === TimeUnit.MICROSECOND) return "us";
  return "ns";
}
