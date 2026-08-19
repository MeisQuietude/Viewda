import { TimeUnit, Type, type DataType } from "@uwdata/flechette";

import { decimalToText, timestampToText } from "./filter-query";

const NESTED_PREVIEW_LIMIT = 120;
// Every full chunk is divisible by three, so independently encoded base64
// chunks concatenate without padding in the middle of the value.
const BASE64_INPUT_CHUNK_BYTES = 24 * 1024;

export interface CellPresentation {
  displayData: string;
  copyData: string;
  align: "left" | "right";
  faded: boolean;
}

export function formatCellValue(
  value: unknown,
  dataType: DataType,
  includeRawCopy = true,
): CellPresentation {
  const type = unwrapDictionary(dataType);

  if (value === null) {
    return presentation("null", "", false, true);
  }

  if (isBinary(type)) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array();
    return presentation(
      `binary · ${formatByteSize(bytes.byteLength)}`,
      includeRawCopy ? bytesToBase64(bytes) : "",
      false,
      false,
    );
  }

  if (type.typeId === Type.Timestamp) {
    // M1 renders timezone-less Arrow timestamps as UTC for deterministic ISO output.
    // Copying remains lossless because copyData keeps the raw Arrow integer.
    const iso = timestampToText(value, type.unit);
    const raw = typeof value === "bigint" ? value.toString() : String(value);
    return presentation(iso, raw, false, false);
  }

  if (type.typeId === Type.Date) {
    const iso = timestampToText(value, TimeUnit.MILLISECOND).slice(0, 10);
    return presentation(iso, iso, false, false);
  }

  if (type.typeId === Type.Decimal) {
    const decimal = decimalToText(value, type.scale);
    return presentation(decimal, decimal, true, false);
  }

  if (isNumber(type)) {
    const raw = typeof value === "bigint" ? value.toString() : String(value);
    return presentation(raw, raw, true, false);
  }

  if (isNested(type)) {
    // Normal rendering needs only the bounded preview. Avoid walking the rest of
    // a large nested value on the main thread; copy/export explicitly opts into
    // the complete, lossless representation below.
    const raw = includeRawCopy ? stringifyNested(value) : "";
    const preview = includeRawCopy
      ? truncateNestedPreview(raw)
      : stringifyNestedPreview(value);
    return presentation(preview, raw, false, false);
  }

  const raw = String(value);
  return presentation(raw, raw, false, false);
}

export function usesMonospaceCells(dataType: DataType): boolean {
  const type = unwrapDictionary(dataType);
  return isNumber(type) || isNested(type);
}

function presentation(
  displayData: string,
  copyData: string,
  alignRight: boolean,
  faded: boolean,
): CellPresentation {
  return {
    displayData,
    copyData,
    align: alignRight ? "right" : "left",
    faded,
  };
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
}

function isNumber(dataType: DataType): boolean {
  return (
    dataType.typeId === Type.Int ||
    dataType.typeId === Type.Float ||
    dataType.typeId === Type.Decimal
  );
}

function isBinary(dataType: DataType): boolean {
  return (
    dataType.typeId === Type.Binary ||
    dataType.typeId === Type.LargeBinary ||
    dataType.typeId === Type.FixedSizeBinary ||
    dataType.typeId === Type.BinaryView
  );
}

function isNested(dataType: DataType): boolean {
  return (
    dataType.typeId === Type.List ||
    dataType.typeId === Type.LargeList ||
    dataType.typeId === Type.FixedSizeList ||
    dataType.typeId === Type.ListView ||
    dataType.typeId === Type.LargeListView ||
    dataType.typeId === Type.Struct ||
    dataType.typeId === Type.Map
  );
}

function stringifyNested(value: unknown): string {
  return (
    JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === "bigint") {
        return nestedValue.toString();
      }
      if (nestedValue instanceof Map) {
        return Array.from(nestedValue.entries());
      }
      if (nestedValue instanceof Uint8Array) {
        return `binary · ${formatByteSize(nestedValue.byteLength)}`;
      }
      return nestedValue;
    }) ?? "null"
  );
}

function truncateNestedPreview(raw: string): string {
  return raw.length <= NESTED_PREVIEW_LIMIT
    ? raw
    : `${raw.slice(0, NESTED_PREVIEW_LIMIT - 1)}…`;
}

function stringifyNestedPreview(value: unknown): string {
  let output = "";
  let truncated = false;

  const append = (text: string) => {
    const remaining = NESTED_PREVIEW_LIMIT - 1 - output.length;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (text.length > remaining) {
      output += text.slice(0, remaining);
      truncated = true;
      return false;
    }
    output += text;
    return true;
  };

  const write = (nestedValue: unknown): boolean => {
    if (typeof nestedValue === "bigint") {
      return append(JSON.stringify(nestedValue.toString()));
    }
    if (nestedValue instanceof Uint8Array) {
      return append(
        JSON.stringify(`binary · ${formatByteSize(nestedValue.byteLength)}`),
      );
    }
    if (typeof nestedValue === "string") {
      return append(JSON.stringify(nestedValue.slice(0, NESTED_PREVIEW_LIMIT)));
    }
    if (nestedValue === null || typeof nestedValue !== "object") {
      const encoded = JSON.stringify(nestedValue);
      return append(encoded ?? "null");
    }

    const objectLike =
      !Array.isArray(nestedValue) && !(nestedValue instanceof Map);
    if (!append(objectLike ? "{" : "[")) return false;
    let first = true;
    const keys: Iterable<unknown> = objectLike
      ? ownEnumerableKeys(nestedValue)
      : nestedValue instanceof Map
        ? nestedValue.keys()
        : nestedValue.keys();
    for (const key of keys) {
      const item =
        nestedValue instanceof Map
          ? nestedValue.get(key)
          : (nestedValue as Record<PropertyKey, unknown>)[key as PropertyKey];
      if (!first && !append(",")) return false;
      first = false;
      if (objectLike) {
        if (
          !append(
            `${JSON.stringify(String(key).slice(0, NESTED_PREVIEW_LIMIT))}:`,
          )
        ) {
          return false;
        }
        if (!write(item)) return false;
      } else if (nestedValue instanceof Map) {
        if (!append("[")) return false;
        if (!write(key) || !append(",") || !write(item)) {
          return false;
        }
        if (!append("]")) return false;
      } else if (!write(item)) {
        return false;
      }
    }
    return append(objectLike ? "}" : "]");
  };

  write(value);
  return truncated ? `${output}…` : output;
}

function* ownEnumerableKeys(value: object): Iterable<string> {
  // Object.keys allocates every field name before the preview writer can stop.
  // A lazy iterator keeps work proportional to the bounded visible prefix.
  for (const key in value) {
    if (Object.hasOwn(value, key)) yield key;
  }
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

function formatByteSize(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1_000).toFixed(1)} kB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
