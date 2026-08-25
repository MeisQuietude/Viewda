import {
  DateUnit,
  IntervalUnit,
  Precision,
  TimeUnit,
  Type,
  type DataType,
  type Field,
} from "@uwdata/flechette";

import { decimalToText, timestampToText } from "./filter-query";
import {
  decodeJsonStringPrefix,
  jsonNodeRaw,
  jsonNodeType,
  sourceSlice,
  type JsonNode,
  type JsonSource,
} from "./json-value";
import {
  arrowBinaryBytes,
  arrowChildCount,
  arrowListChild,
  arrowMapEntry,
  arrowMapEntryChild,
  arrowScalarValue,
  arrowStructChild,
  arrowUtf8Bytes,
  arrowValueIsNull,
  decodeArrowUtf8Prefix,
  type ArrowMapEntryRef,
  type ArrowValueRef,
} from "./arrow-value";
import { codePointSafePrefix } from "./unicode";

export const VALUE_PREVIEW_LIMIT = 120;
export const BINARY_HEX_ROW_BYTES = 8;
const BASE64_INPUT_CHUNK_BYTES = 24 * 1024;

export type ValueSearchText =
  | { kind: "plain"; text: string }
  | { kind: "slice"; source: JsonSource; start: number; end: number }
  | { kind: "utf8"; bytes: Uint8Array; start: number; end: number }
  | { kind: "jsonString"; source: JsonSource; start: number; end: number };

export type TypedValue =
  | { kind: "value"; value: unknown; dataType: DataType }
  | ({ kind: "arrow"; logicalType?: string | null } & ArrowValueRef)
  | ({ kind: "arrowMapEntry" } & ArrowMapEntryRef)
  | {
      kind: "mapEntry";
      key: unknown;
      value: unknown;
      keyType: DataType;
      valueType: DataType;
    }
  | { kind: "jsonText"; value: JsonSource; dataType: DataType }
  | { kind: "rawJson"; value: JsonSource; dataType: DataType }
  | { kind: "json"; source: JsonSource; node: JsonNode; root: boolean }
  | {
      kind: "invalidJson";
      value: JsonSource;
      dataType: DataType;
      errorOffset: number;
    };

export interface ValueChild {
  label: string;
  labelSearch?: ValueSearchText;
  key: boolean;
  objectKey?: string;
  value: TypedValue;
}

export interface PreviewToken {
  text: string;
  tone:
    "key" | "string" | "number" | "boolean" | "null" | "secondary" | "value";
}

export function typedValue(
  value: unknown,
  dataType: DataType,
  logicalType?: string | null,
): TypedValue {
  if (logicalType === "JSON" && typeof value === "string") {
    return { kind: "jsonText", value, dataType };
  }
  return { kind: "value", value, dataType };
}

export function arrowTypedValue(
  value: ArrowValueRef,
  logicalType?: string | null,
): TypedValue {
  // Flechette materializes dictionary caches while decoding IPC. Reuse that
  // value instead of decoding the backing dictionary a second time.
  if (value.dataType.typeId === Type.Dictionary) {
    return typedValue(arrowScalarValue(value), value.dataType, logicalType);
  }
  return { kind: "arrow", ...value, logicalType };
}

export function materializedScalarValue(
  input: Extract<TypedValue, { dataType: DataType }>,
): unknown {
  return scalarMaterializedValue(input);
}

export function parsedJsonValue(
  source: JsonSource,
  node: JsonNode,
  root = false,
): TypedValue {
  return { kind: "json", source, node, root };
}

export function invalidJsonValue(
  value: JsonSource,
  dataType: DataType,
  errorOffset: number,
): TypedValue {
  return { kind: "invalidJson", value, dataType, errorOffset };
}

export function rawJsonValue(
  value: JsonSource,
  dataType: DataType,
): TypedValue {
  return { kind: "rawJson", value, dataType };
}

export function formatValuePreview(
  input: TypedValue,
  limit = VALUE_PREVIEW_LIMIT,
): string {
  return preview(input, Math.max(1, limit), 0);
}

export function formatValuePreviewTokens(
  input: TypedValue,
  limit = VALUE_PREVIEW_LIMIT,
): PreviewToken[] {
  return semanticPreview(input, Math.max(1, limit), 0);
}

export function formatCellDisplay(input: TypedValue): string {
  if (input.kind !== "value" && input.kind !== "arrow") {
    return formatValuePreview(input);
  }
  const type = unwrapDictionary(input.dataType);
  if (input.kind === "arrow") {
    if (arrowValueIsNull(input)) return "null";
    if (isNested(type)) return formatValuePreview(input);
    const utf8 = decodeArrowUtf8Prefix(input, VALUE_PREVIEW_LIMIT);
    if (utf8 !== null) return `${utf8.text}${utf8.truncated ? "…" : ""}`;
    const binary = arrowBinaryBytes(input);
    return binary === null
      ? formatScalarDisplay(arrowScalarValue(input), type, false)
      : `binary · ${formatByteSize(binary.byteLength)}`;
  }
  return isNested(type)
    ? formatValuePreview(input)
    : typeof input.value === "string"
      ? fitToken(input.value, VALUE_PREVIEW_LIMIT)
      : formatScalarDisplay(input.value, type, false);
}

export function valueToJson(input: TypedValue): string {
  if (input.kind === "json") {
    return input.root
      ? sourceSlice(input.source, 0, input.source.length)
      : jsonNodeRaw(input.source, input.node);
  }
  if (
    input.kind === "jsonText" ||
    input.kind === "rawJson" ||
    input.kind === "invalidJson"
  ) {
    return sourceSlice(input.value, 0, input.value.length);
  }
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") {
    const key = valueChildAt(input, 0)?.value;
    const value = valueChildAt(input, 1)?.value;
    return `[${key === undefined ? "null" : valueToJson(key)},${
      value === undefined ? "null" : valueToJson(value)
    }]`;
  }

  const type = unwrapDictionary(input.dataType);
  if (valueIsNull(input)) return "null";
  const value = scalarMaterializedValue(input);
  if (isBinary(type)) {
    return JSON.stringify(
      bytesToBase64(binaryValueBytes(input) ?? new Uint8Array()),
    );
  }
  if (type.typeId === Type.Decimal) {
    return decimalToJson(value, type.scale);
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
    const count = valueChildCount(input);
    const output: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const child = valueChildAt(input, index);
      output.push(child === undefined ? "null" : valueToJson(child.value));
    }
    return `[${output.join(",")}]`;
  }
  if (type.typeId === Type.Struct) {
    const output: string[] = [];
    for (let index = 0; index < type.children.length; index += 1) {
      const field = type.children[index]!;
      const child = valueChildAt(input, index);
      output.push(
        `${JSON.stringify(field.name)}:${
          child === undefined ? "null" : valueToJson(child.value)
        }`,
      );
    }
    return `{${output.join(",")}}`;
  }
  if (type.typeId === Type.Map) {
    const output: string[] = [];
    const [keyType, valueType] = mapTypes(type.children[0]);
    for (let index = 0; index < valueChildCount(input); index += 1) {
      const entryValue =
        input.kind === "arrow"
          ? (() => {
              const entry = arrowMapEntry(input, index);
              return entry === undefined
                ? undefined
                : ({ kind: "arrowMapEntry", ...entry } as const);
            })()
          : input.kind === "value" &&
              keyType !== undefined &&
              valueType !== undefined
            ? (() => {
                const entry = mapEntryAt(input.value, index);
                return entry === undefined
                  ? undefined
                  : ({
                      kind: "mapEntry",
                      key: entry[0],
                      value: entry[1],
                      keyType,
                      valueType,
                    } as const);
              })()
            : undefined;
      output.push(entryValue === undefined ? "null" : valueToJson(entryValue));
    }
    return `[${output.join(",")}]`;
  }

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return jsonInteger(value);
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? String(value)
      : JSON.stringify(String(value));
  }
  return JSON.stringify(String(value));
}

export function valueChildCount(input: TypedValue): number {
  if (input.kind === "json") {
    return input.node.kind === "object"
      ? input.node.entries.length
      : input.node.kind === "array"
        ? input.node.items.length
        : 0;
  }
  if (
    input.kind === "jsonText" ||
    input.kind === "rawJson" ||
    input.kind === "invalidJson"
  ) {
    return 0;
  }
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") return 2;
  if (input.kind === "arrow") return arrowChildCount(input);
  if (input.value === null || input.value === undefined) return 0;
  const type = unwrapDictionary(input.dataType);
  if (isList(type)) return arrayLikeLength(input.value);
  if (type.typeId === Type.Struct) return type.children.length;
  if (type.typeId === Type.Map)
    return Array.isArray(input.value) ? input.value.length : 0;
  return 0;
}

export function valueChildAt(
  input: TypedValue,
  index: number,
): ValueChild | undefined {
  if (index < 0 || index >= valueChildCount(input)) return undefined;
  if (input.kind === "json") {
    if (input.node.kind === "array") {
      const child = input.node.items[index];
      return child === undefined
        ? undefined
        : {
            label: `[${index}]`,
            key: false,
            value: parsedJsonValue(input.source, child),
          };
    }
    if (input.node.kind === "object") {
      const entry = input.node.entries[index];
      if (entry === undefined) return undefined;
      const prefix = decodeJsonStringPrefix(
        input.source,
        entry.keyStart,
        entry.keyEnd,
        160,
      );
      const label = prefix.text.length === 0 ? '[""]' : prefix.text;
      return {
        label: `${label}${prefix.truncated ? "…" : ""}`,
        labelSearch: {
          kind: "jsonString",
          source: input.source,
          start: entry.keyStart,
          end: entry.keyEnd,
        },
        key: true,
        value: parsedJsonValue(input.source, entry.value),
      };
    }
    return undefined;
  }
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") {
    if (input.kind === "arrowMapEntry") {
      const value = arrowMapEntryChild(input, index);
      return value === undefined
        ? undefined
        : {
            label: `[${index}]`,
            key: false,
            value: arrowTypedValue(value),
          };
    }
    return index === 0
      ? {
          label: "[0]",
          key: false,
          value: typedValue(input.key, input.keyType),
        }
      : {
          label: "[1]",
          key: false,
          value: typedValue(input.value, input.valueType),
        };
  }

  if (input.kind === "arrow") {
    const type = unwrapDictionary(input.dataType);
    if (isList(type)) {
      const value = arrowListChild(input, index);
      return value === undefined
        ? undefined
        : { label: `[${index}]`, key: false, value: arrowTypedValue(value) };
    }
    if (type.typeId === Type.Struct) {
      const field = type.children[index];
      const value = arrowStructChild(input, index);
      return field === undefined || value === undefined
        ? undefined
        : {
            label: boundedChildLabel(field.name),
            labelSearch: { kind: "plain", text: field.name },
            key: true,
            objectKey: field.name,
            value: arrowTypedValue(value),
          };
    }
    if (type.typeId === Type.Map) {
      const entry = arrowMapEntry(input, index);
      if (entry === undefined) return undefined;
      const key = arrowMapEntryChild(entry, 0);
      if (key !== undefined && isStringType(entry.keyType)) {
        const value = arrowMapEntryChild(entry, 1);
        if (value === undefined) return undefined;
        if (key.dataType.typeId === Type.Dictionary) {
          const cached = arrowScalarValue(key);
          if (cached !== null && cached !== undefined) {
            const keyText = String(cached);
            return {
              label: boundedChildLabel(keyText),
              labelSearch: { kind: "plain", text: keyText },
              key: true,
              value: arrowTypedValue(value),
            };
          }
        } else {
          const keyPrefix = decodeArrowUtf8Prefix(key, 160);
          const keyText = keyPrefix?.text ?? "";
          const keyRange = arrowUtf8Bytes(key);
          return {
            label: `${boundedChildLabel(keyText)}${
              keyPrefix?.truncated ? "…" : ""
            }`,
            labelSearch:
              keyRange === null
                ? { kind: "plain", text: keyText }
                : { kind: "utf8", ...keyRange },
            key: true,
            value: arrowTypedValue(value),
          };
        }
      }
      return {
        label: `[${index}]`,
        key: false,
        value: { kind: "arrowMapEntry", ...entry },
      };
    }
    return undefined;
  }

  const type = unwrapDictionary(input.dataType);
  if (isList(type)) {
    const childType = listChildType(type);
    return childType === undefined
      ? undefined
      : {
          label: `[${index}]`,
          key: false,
          value: typedValue(arrayLikeAt(input.value, index), childType),
        };
  }
  if (type.typeId === Type.Struct) {
    const field = type.children[index];
    return field === undefined
      ? undefined
      : {
          label: boundedChildLabel(field.name),
          labelSearch: { kind: "plain", text: field.name },
          key: true,
          objectKey: field.name,
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
      const keyText = String(key);
      return {
        label: boundedChildLabel(keyText),
        labelSearch: { kind: "plain", text: keyText },
        key: true,
        value: typedValue(value, valueType),
      };
    }
    return {
      label: `[${index}]`,
      key: false,
      value: { kind: "mapEntry", key, value, keyType, valueType },
    };
  }
  return undefined;
}

export function valueTypeLabel(input: TypedValue): string {
  if (input.kind === "json") return jsonNodeType(input.node);
  if (input.kind === "jsonText") return "JSON (parsing)";
  if (input.kind === "rawJson") return "JSON (raw tree fallback)";
  if (input.kind === "invalidJson") return "invalid JSON";
  return input.kind === "mapEntry" || input.kind === "arrowMapEntry"
    ? `[${dataTypeLabel(input.keyType)}, ${dataTypeLabel(input.valueType)}]`
    : dataTypeLabel(input.dataType);
}

export function fullValueText(input: TypedValue): string {
  if (input.kind === "json") {
    return input.root
      ? sourceSlice(input.source, 0, input.source.length)
      : jsonNodeRaw(input.source, input.node);
  }
  if (
    input.kind === "jsonText" ||
    input.kind === "rawJson" ||
    input.kind === "invalidJson"
  ) {
    return sourceSlice(input.value, 0, input.value.length);
  }
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") {
    return formatValuePreview(input);
  }
  const type = unwrapDictionary(input.dataType);
  if (valueIsNull(input)) return "null";
  if (isNested(type)) return formatValuePreview(input);
  if (input.kind === "arrow") {
    const utf8 = decodeArrowUtf8Prefix(input, Number.MAX_SAFE_INTEGER);
    return (
      utf8?.text ?? formatScalarDisplay(arrowScalarValue(input), type, false)
    );
  }
  return formatScalarDisplay(input.value, type, false);
}

export function binaryValueBytes(input: TypedValue): Uint8Array | null {
  if (input.kind === "arrow") return arrowBinaryBytes(input);
  return input.kind === "value" && isBinaryValue(input)
    ? asBytes(input.value)
    : null;
}

export function formatBinaryHexRow(
  bytes: Uint8Array,
  rowIndex: number,
): string {
  const offset = rowIndex * BINARY_HEX_ROW_BYTES;
  const chunk = bytes.subarray(offset, offset + BINARY_HEX_ROW_BYTES);
  const hex = Array.from(chunk, (byte) => byte.toString(16).padStart(2, "0"))
    .join(" ")
    .padEnd(BINARY_HEX_ROW_BYTES * 3 - 1, " ");
  const ascii = Array.from(chunk, (byte) =>
    byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".",
  ).join("");
  return `${offset.toString(16).padStart(8, "0")}  ${hex}  ${ascii}`;
}

export function isBinaryValue(input: TypedValue): boolean {
  return (
    (input.kind === "value" || input.kind === "arrow") &&
    !valueIsNull(input) &&
    isBinary(unwrapDictionary(input.dataType))
  );
}

export function valueSearchText(input: TypedValue): ValueSearchText | null {
  if (input.kind === "json") {
    if (input.node.kind === "string") {
      return {
        kind: "jsonString",
        source: input.source,
        start: input.node.start,
        end: input.node.end,
      };
    }
    if (
      input.node.kind === "number" ||
      input.node.kind === "boolean" ||
      input.node.kind === "null"
    ) {
      return {
        kind: "slice",
        source: input.source,
        start: input.node.start,
        end: input.node.end,
      };
    }
    return null;
  }
  if (
    input.kind === "jsonText" ||
    input.kind === "rawJson" ||
    input.kind === "invalidJson"
  ) {
    return {
      kind: "slice",
      source: input.value,
      start: 0,
      end: input.value.length,
    };
  }
  if (
    input.kind === "mapEntry" ||
    input.kind === "arrowMapEntry" ||
    valueChildCount(input) > 0
  ) {
    return null;
  }
  if (isBinaryValue(input)) return null;
  if (input.kind === "arrow") {
    const utf8 = arrowUtf8Bytes(input);
    if (utf8 !== null) {
      return {
        kind: "utf8",
        bytes: utf8.bytes,
        start: utf8.start,
        end: utf8.end,
      };
    }
    return { kind: "plain", text: fullValueText(input) };
  }
  if (typeof input.value === "string") {
    return { kind: "plain", text: input.value };
  }
  return { kind: "plain", text: fullValueText(input) };
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
    case Type.Interval:
      return `interval[${intervalUnitLabel(type.unit)}]`;
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
  return semanticPreview(input, limit, depth)
    .map((token) => token.text)
    .join("");
}

function semanticPreview(
  input: TypedValue,
  limit: number,
  depth: number,
): PreviewToken[] {
  if (input.kind === "json") return jsonPreviewTokens(input, limit);
  if (
    input.kind === "jsonText" ||
    input.kind === "rawJson" ||
    input.kind === "invalidJson"
  ) {
    return [
      {
        text: formatPreviewString(
          sourceSlice(input.value, 0, Math.min(input.value.length, limit)),
          limit,
        ),
        tone: "string",
      },
    ];
  }
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") {
    const key = valueChildAt(input, 0)?.value;
    const value = valueChildAt(input, 1)?.value;
    return fitSemanticTokens(
      [
        ...semanticPreview(
          key ?? nullValueForEntry(input, true),
          limit,
          depth + 1,
        ),
        { text: " → ", tone: "secondary" },
        ...semanticPreview(
          value ?? nullValueForEntry(input, false),
          limit,
          depth + 1,
        ),
      ],
      limit,
    );
  }
  const type = unwrapDictionary(input.dataType);
  if (valueIsNull(input)) return [{ text: "null", tone: "null" }];
  if (depth > 0 && isNested(type)) {
    return [{ text: isList(type) ? "[…]" : "{…}", tone: "secondary" }];
  }
  if (isList(type)) {
    const count = valueChildCount(input);
    return previewItemsTokens(
      `[${count}]`,
      count,
      limit,
      (index, itemLimit) => {
        const child = valueChildAt(input, index);
        return semanticPreview(
          child?.value ?? typedValue(null, listChildType(type) ?? type),
          itemLimit,
          depth + 1,
        );
      },
    );
  }
  if (type.typeId === Type.Struct) {
    return previewDelimitedTokens(
      type.children.length,
      limit,
      (index, itemLimit) => {
        const field = type.children[index];
        if (field === undefined) return [];
        const name = formatPreviewKey(field.name, Math.max(1, itemLimit - 2));
        const child = valueChildAt(input, index);
        return [
          { text: name, tone: "key" },
          { text: ": ", tone: "secondary" },
          ...semanticPreview(
            child?.value ?? typedValue(null, field.type),
            Math.max(1, itemLimit - name.length - 2),
            depth + 1,
          ),
        ];
      },
    );
  }
  if (type.typeId === Type.Map) {
    const count = valueChildCount(input);
    const [keyType, valueType] = mapTypes(type.children[0]);
    return previewItemsTokens(
      `{${count}}`,
      count,
      limit,
      (index, itemLimit) => {
        if (keyType === undefined || valueType === undefined) {
          return [];
        }
        let key: TypedValue | undefined;
        let value: TypedValue | undefined;
        if (input.kind === "arrow") {
          const entry = arrowMapEntry(input, index);
          const keyRef =
            entry === undefined ? undefined : arrowMapEntryChild(entry, 0);
          const valueRef =
            entry === undefined ? undefined : arrowMapEntryChild(entry, 1);
          key = keyRef === undefined ? undefined : arrowTypedValue(keyRef);
          value =
            valueRef === undefined ? undefined : arrowTypedValue(valueRef);
        } else {
          const entry = mapEntryAt(input.value, index);
          key = entry === undefined ? undefined : typedValue(entry[0], keyType);
          value =
            entry === undefined ? undefined : typedValue(entry[1], valueType);
        }
        if (key === undefined || value === undefined) return [];
        return fitSemanticTokens(
          [
            ...semanticPreview(key, itemLimit, depth + 1),
            { text: " → ", tone: "secondary" },
            ...semanticPreview(value, itemLimit, depth + 1),
          ],
          itemLimit,
        );
      },
    );
  }
  let text: string;
  let value: unknown;
  if (input.kind === "arrow") {
    const utf8 = decodeArrowUtf8Prefix(input, Math.max(1, limit - 2));
    value = utf8 === null ? arrowScalarValue(input) : utf8.text;
    text =
      utf8 === null
        ? formatPreviewScalar(value, type, limit)
        : formatPreviewString(
            `${utf8.text}${utf8.truncated ? "…" : ""}`,
            limit,
          );
  } else {
    value = input.value;
    text = formatPreviewScalar(value, type, limit);
  }
  return [{ text, tone: scalarTone(value, type) }];
}

function previewItemsTokens(
  prefix: string,
  count: number,
  limit: number,
  item: (index: number, limit: number) => PreviewToken[],
): PreviewToken[] {
  const tokens: PreviewToken[] = [
    { text: fitToken(prefix, limit), tone: "secondary" },
  ];
  if (count === 0 || prefix.length >= limit) return tokens;
  for (let index = 0; index < count; index += 1) {
    const separator = index === 0 ? " " : ", ";
    const remaining = limit - tokenLength(tokens) - separator.length;
    const child = remaining > 0 ? item(index, remaining) : [];
    if (child.length === 0 || tokenLength(child) > remaining) {
      appendPreviewToken(
        tokens,
        index === 0 ? " …" : ", …",
        "secondary",
        limit,
      );
      return tokens;
    }
    appendPreviewToken(tokens, separator, "secondary", limit);
    appendPreviewTokens(tokens, child);
  }
  return tokens;
}

function previewDelimitedTokens(
  count: number,
  limit: number,
  item: (index: number, limit: number) => PreviewToken[],
): PreviewToken[] {
  const tokens: PreviewToken[] = [{ text: "{", tone: "secondary" }];
  for (let index = 0; index < count; index += 1) {
    const separator = index === 0 ? "" : ", ";
    const remaining = limit - tokenLength(tokens) - separator.length - 1;
    const child = remaining > 0 ? item(index, remaining) : [];
    if (child.length === 0 || tokenLength(child) > remaining) {
      appendPreviewToken(
        tokens,
        index === 0 ? "…" : ", …",
        "secondary",
        limit - 1,
      );
      break;
    }
    appendPreviewToken(tokens, separator, "secondary", limit);
    appendPreviewTokens(tokens, child);
  }
  appendPreviewToken(tokens, "}", "secondary", limit);
  return tokens;
}

function scalarTone(value: unknown, type: DataType): PreviewToken["tone"] {
  if (value == null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    isNumericType(type)
  ) {
    return "number";
  }
  return "value";
}

function nullValueForEntry(
  input: Extract<TypedValue, { kind: "mapEntry" | "arrowMapEntry" }>,
  key: boolean,
): TypedValue {
  return typedValue(null, key ? input.keyType : input.valueType);
}

function fitSemanticTokens(
  tokens: PreviewToken[],
  limit: number,
): PreviewToken[] {
  if (tokenLength(tokens) <= limit) return tokens;
  const output: PreviewToken[] = [];
  for (const token of tokens) {
    const remaining = limit - tokenLength(output);
    if (remaining <= 0) break;
    if (token.text.length <= remaining) appendPreviewTokens(output, [token]);
    else {
      appendPreviewToken(output, "…", "secondary", limit);
      break;
    }
  }
  return output;
}

function appendPreviewTokens(
  target: PreviewToken[],
  source: readonly PreviewToken[],
): void {
  for (const token of source)
    appendPreviewToken(target, token.text, token.tone, Infinity);
}

function appendPreviewToken(
  tokens: PreviewToken[],
  text: string,
  tone: PreviewToken["tone"],
  limit: number,
): void {
  const fitted = codePointSafePrefix(
    text,
    Math.max(0, limit - tokenLength(tokens)),
  );
  if (fitted.length === 0) return;
  const previous = tokens.at(-1);
  if (previous?.tone === tone) previous.text += fitted;
  else tokens.push({ text: fitted, tone });
}

function tokenLength(tokens: readonly PreviewToken[]): number {
  return tokens.reduce((length, token) => length + token.text.length, 0);
}

function jsonNodePreview(
  input: Extract<TypedValue, { kind: "json" }>,
  limit: number,
): string {
  const { node, source } = input;
  if (node.kind === "object") return `{${node.entries.length}}`;
  if (node.kind === "array") return `[${node.items.length}]`;
  if (node.kind === "string") {
    const prefix = decodeJsonStringPrefix(
      source,
      node.start,
      node.end,
      Math.max(1, limit),
    );
    return formatPreviewString(
      `${prefix.text}${prefix.truncated ? "…" : ""}`,
      limit,
    );
  }
  return fitToken(jsonNodeRaw(source, node), limit);
}

function jsonPreviewTokens(
  input: Extract<TypedValue, { kind: "json" }>,
  limit: number,
): PreviewToken[] {
  const text = jsonNodePreview(input, limit);
  const tone: PreviewToken["tone"] =
    input.node.kind === "object" || input.node.kind === "array"
      ? "secondary"
      : input.node.kind;
  return [{ text, tone }];
}

function formatPreviewScalar(
  value: unknown,
  dataType: DataType,
  limit: number,
): string {
  if (typeof value === "string") {
    return formatPreviewString(value, limit);
  }
  return fitToken(formatScalarDisplay(value, dataType), limit);
}

function formatPreviewString(value: string, limit: number): string {
  if (value.length === 0) return limit >= 2 ? '""' : "…";
  if (limit < 3) return "…";

  let output = '"';
  let offset = 0;
  while (offset < value.length) {
    const codePoint = value.codePointAt(offset);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    const escaped = JSON.stringify(character).slice(1, -1);
    const nextOffset = offset + character.length;
    const reserved = nextOffset < value.length ? 2 : 1;
    if (output.length + escaped.length + reserved > limit) break;
    output += escaped;
    offset = nextOffset;
  }
  if (offset < value.length) output += "…";
  return `${output}"`;
}

function formatPreviewKey(value: string, limit: number): string {
  let offset = 0;
  let identifier = value.length > 0;
  while (offset < value.length && offset <= limit) {
    const codePoint = value.codePointAt(offset)!;
    const character = String.fromCodePoint(codePoint);
    if (!/[A-Za-z0-9_]/.test(character)) identifier = false;
    offset += character.length;
  }
  return identifier && offset >= value.length
    ? value
    : formatPreviewString(value, limit);
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
  if (dataType.typeId === Type.Time) {
    return formatTime(value, dataType.unit);
  }
  if (dataType.typeId === Type.Timestamp) {
    return timestampToText(value, dataType.unit);
  }
  if (dataType.typeId === Type.Date) {
    return formatDateDecimalText(value, dataType);
  }
  if (dataType.typeId === Type.Decimal) {
    return formatDateDecimalText(value, dataType);
  }
  if (dataType.typeId === Type.Interval) {
    return formatInterval(value, dataType.unit);
  }
  if (typeof value === "string") {
    return quoteStrings ? JSON.stringify(value) : value;
  }
  return String(value);
}

export function formatDateDecimalText(
  value: unknown,
  dataType: DataType,
): string {
  if (dataType.typeId === Type.Date) {
    return timestampToText(value, TimeUnit.MILLISECOND).slice(0, 10);
  }
  if (dataType.typeId === Type.Decimal) {
    return decimalToText(value, dataType.scale);
  }
  throw new Error("Expected an Arrow date or decimal type.");
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

function decimalToJson(value: unknown, scale: number): string {
  const text = decimalToText(value, scale);
  const number = Number(text);
  return Number.isFinite(number) && String(number) === text
    ? text
    : JSON.stringify(text);
}

function fitToken(token: string, limit: number): string {
  if (token.length <= limit) return token;
  if (limit <= 1) return "…";
  return `${codePointSafePrefix(token, limit - 1)}…`;
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

function valueIsNull(
  input: Extract<TypedValue, { dataType: DataType }>,
): boolean {
  return input.kind === "arrow"
    ? arrowValueIsNull(input)
    : input.kind === "value"
      ? input.value === null || input.value === undefined
      : false;
}

function scalarMaterializedValue(
  input: Extract<TypedValue, { dataType: DataType }>,
): unknown {
  return input.kind === "arrow" ? arrowScalarValue(input) : input.value;
}

function mapEntryAt(
  value: unknown,
  index: number,
): readonly [unknown, unknown] | undefined {
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

function timeUnitLabel(unit: number): string {
  if (unit === TimeUnit.SECOND) return "s";
  if (unit === TimeUnit.MILLISECOND) return "ms";
  if (unit === TimeUnit.MICROSECOND) return "us";
  return "ns";
}

function intervalUnitLabel(unit: number): string {
  if (unit === IntervalUnit.YEAR_MONTH) return "year_month";
  if (unit === IntervalUnit.DAY_TIME) return "day_time";
  return "month_day_nano";
}

function formatTime(value: unknown, unit: number): string {
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value)) &&
    typeof value !== "bigint"
  ) {
    return String(value);
  }
  const units = typeof value === "bigint" ? value : BigInt(value);
  const unitsPerSecond =
    unit === TimeUnit.SECOND
      ? 1n
      : unit === TimeUnit.MILLISECOND
        ? 1_000n
        : unit === TimeUnit.MICROSECOND
          ? 1_000_000n
          : 1_000_000_000n;
  const unitsPerDay = 86_400n * unitsPerSecond;
  if (units < 0n || units >= unitsPerDay) return String(value);
  const totalSeconds = units / unitsPerSecond;
  const hours = totalSeconds / 3_600n;
  const minutes = (totalSeconds % 3_600n) / 60n;
  const seconds = totalSeconds % 60n;
  const precision =
    unit === TimeUnit.SECOND
      ? 0
      : unit === TimeUnit.MILLISECOND
        ? 3
        : unit === TimeUnit.MICROSECOND
          ? 6
          : 9;
  const fraction = units % unitsPerSecond;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}${
    precision === 0 ? "" : `.${fraction.toString().padStart(precision, "0")}`
  }`;
}

function formatInterval(value: unknown, unit: number): string {
  if (unit === IntervalUnit.YEAR_MONTH) return `${String(value)} mo`;
  const parts =
    value !== null && typeof value === "object" && "length" in value
      ? (value as ArrayLike<unknown>)
      : [];
  if (unit === IntervalUnit.DAY_TIME && parts.length >= 2) {
    return `${String(parts[0])} d ${String(parts[1])} ms`;
  }
  if (unit === IntervalUnit.MONTH_DAY_NANO && parts.length >= 3) {
    return `${String(parts[0])} mo ${String(parts[1])} d ${String(parts[2])} ns`;
  }
  return String(value);
}

function childLabel(name: string): string {
  return name.length === 0 ? '[""]' : name;
}

function boundedChildLabel(name: string): string {
  if (name.length <= 160) return childLabel(name);
  let prefix = name.slice(0, 160);
  if (/[\uD800-\uDBFF]/.test(prefix.at(-1)!)) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}
