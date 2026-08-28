import type {
  FieldPath,
  JsonFieldTarget,
  JsonPath,
  JsonPathSegment,
} from "../desktop";
import { formatFieldPath, formatFieldPathSegment } from "./field-path";

const SIMPLE_FIELD_CHARACTER = /[A-Za-z0-9_]/;
const MAX_PATH_SEGMENTS = 64;
export const JSON_PATH_BYTE_LIMIT = 4_096;
const MAX_ARRAY_INDEX = 4_294_967_295;

export type JsonPathParseResult =
  { path: JsonPath; error: null } | { path: null; error: string };

/**
 * Parses the JSON path grammar shown by Peek and the filter/sort editors.
 * Object keys use dot-separated identifiers or doubled-quote strings; array
 * indices use brackets. Examples: items[0].price and "unit.price"[2].value.
 */
export function parseJsonPath(input: string): JsonPathParseResult {
  const text = input.trim();
  if (text.length === 0) {
    return invalid("Enter a path such as items[0].price.");
  }

  const path: JsonPath = [];
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] === "[") {
      const close = text.indexOf("]", offset + 1);
      if (close < 0) {
        return invalid("Close the array index with ].");
      }
      const digits = text.slice(offset + 1, close);
      if (!/^(0|[1-9][0-9]*)$/.test(digits)) {
        return invalid("Array indices use non-negative integers such as [0].");
      }
      const index = Number(digits);
      if (!Number.isSafeInteger(index) || index > MAX_ARRAY_INDEX) {
        return invalid("The array index is too large.");
      }
      path.push({ index });
      offset = close + 1;
      continue;
    }

    if (path.length > 0) {
      if (text[offset] !== ".") {
        return invalid("Separate object keys with a dot.");
      }
      offset += 1;
      if (offset === text.length) {
        return invalid("Enter an object key after the final dot.");
      }
    }

    if (text[offset] === '"') {
      const parsed = parseQuotedField(text, offset);
      if (typeof parsed === "string") return invalid(parsed);
      path.push({ field: parsed.field });
      offset = parsed.offset;
      continue;
    }

    const start = offset;
    while (offset < text.length && SIMPLE_FIELD_CHARACTER.test(text[offset]!)) {
      offset += 1;
    }
    if (start === offset) {
      return invalid(
        'Quote object keys containing spaces or punctuation, for example "unit.price".',
      );
    }
    path.push({ field: text.slice(start, offset) });
  }

  if (!jsonPathIsValid(path)) {
    return invalid("The JSON path is too long.");
  }
  return { path, error: null };
}

export function formatJsonPath(path: readonly JsonPathSegment[]): string {
  let output = "";
  for (const segment of path) {
    if ("index" in segment) {
      output += `[${segment.index}]`;
    } else {
      const field = formatFieldPathSegment(segment.field);
      output += output.length === 0 ? field : `.${field}`;
    }
  }
  return output;
}

export function formatJsonFieldTarget(
  fieldPath: FieldPath,
  jsonPath: readonly JsonPathSegment[],
): string {
  const column = formatFieldPath(fieldPath);
  const nested = formatJsonPath(jsonPath);
  return jsonPath[0] !== undefined && "index" in jsonPath[0]
    ? `${column}${nested}`
    : `${column}.${nested}`;
}

export function jsonPathKey(path: readonly JsonPathSegment[]): string {
  return JSON.stringify(path);
}

export function sameJsonPath(
  left: readonly JsonPathSegment[],
  right: readonly JsonPathSegment[],
): boolean {
  return jsonPathKey(left) === jsonPathKey(right);
}

export function sameJsonTarget(
  left: JsonFieldTarget | undefined,
  right: JsonFieldTarget | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.valueType === right.valueType &&
      sameJsonPath(left.path, right.path))
  );
}

export function jsonPathIsValid(path: readonly JsonPathSegment[]): boolean {
  if (path.length === 0 || path.length > MAX_PATH_SEGMENTS) return false;
  let bytes = 0;
  for (const segment of path) {
    if ("index" in segment) {
      if (
        !Number.isSafeInteger(segment.index) ||
        segment.index < 0 ||
        segment.index > MAX_ARRAY_INDEX
      ) {
        return false;
      }
      bytes += String(segment.index).length;
    } else {
      bytes += new TextEncoder().encode(segment.field).byteLength;
    }
    if (bytes > JSON_PATH_BYTE_LIMIT) return false;
  }
  return true;
}

function parseQuotedField(
  text: string,
  start: number,
): { field: string; offset: number } | string {
  let field = "";
  let offset = start + 1;
  while (offset < text.length) {
    if (text[offset] !== '"') {
      field += text[offset];
      offset += 1;
      continue;
    }
    if (text[offset + 1] === '"') {
      field += '"';
      offset += 2;
      continue;
    }
    return { field, offset: offset + 1 };
  }
  return "Close the quoted object key with a double quote.";
}

function invalid(error: string): JsonPathParseResult {
  return { path: null, error };
}
