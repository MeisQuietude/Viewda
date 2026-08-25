import { Type, type DataType } from "@uwdata/flechette";

import {
  binaryValueBytes,
  valueChildAt,
  valueChildCount,
  valueToJson,
  type TypedValue,
  type ValueChild,
} from "./value-format";
import { arrowMapEntry, arrowUtf8Bytes, arrowValueIsNull } from "./arrow-value";
import { sourceSlice, type JsonSource } from "./json-value";

const STRING_CHUNK_CHARACTERS = 16_384;
// Divisibility by three keeps independently encoded base64 chunks composable.
const BINARY_CHUNK_BYTES = 24 * 1024;
export const VALUE_COPY_CHARACTER_LIMIT = 32 * 1024 * 1024;

export class ValueCopyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`The value exceeds the ${formatCharacterLimit(limit)} limit.`);
    this.name = "ValueCopyLimitError";
  }
}

type Frame =
  | { kind: "value"; value: TypedValue }
  | {
      kind: "container";
      value: TypedValue;
      index: number;
      count: number;
      object: boolean;
    }
  | { kind: "string"; value: JsonSource; offset: number; suffix: string }
  | { kind: "raw"; source: JsonSource; offset: number; end: number }
  | {
      kind: "utf8";
      bytes: Uint8Array;
      offset: number;
      end: number;
      decoder: TextDecoder;
      json: boolean;
    }
  | { kind: "binary"; bytes: Uint8Array; offset: number; json: boolean };

export type ValueJsonSerializationStep =
  | { status: "pending" }
  | { status: "done"; text: string }
  | { status: "limit"; error: ValueCopyLimitError };

/** Serializes bounded chunks so a large Peek copy yields to input and paint. */
export function createValueJsonSerializer(
  input: TypedValue,
  characterLimit = VALUE_COPY_CHARACTER_LIMIT,
): {
  readonly units: number;
  stepUntil(
    deadline: number,
    now?: () => number,
    maxUnits?: number,
  ): ValueJsonSerializationStep;
} {
  return createValueSerializer(input, characterLimit, true);
}

function createValueSerializer(
  input: TypedValue,
  characterLimit: number,
  json: boolean,
): {
  readonly units: number;
  stepUntil(
    deadline: number,
    now?: () => number,
    maxUnits?: number,
  ): ValueJsonSerializationStep;
} {
  const frames: Frame[] = [{ kind: "value", value: input }];
  const output: string[] = [];
  let outputCharacters = 0;
  let totalUnits = 0;
  if (!json) {
    frames.length = 0;
    pushRawRoot(input, frames, output);
  }

  return {
    get units() {
      return totalUnits;
    },
    stepUntil(deadline, now = () => performance.now(), maxUnits = Infinity) {
      let worked = false;
      let units = 0;
      while (
        frames.length > 0 &&
        units < maxUnits &&
        (!worked || now() < deadline)
      ) {
        worked = true;
        units += 1;
        totalUnits += 1;
        const frame = frames.pop()!;
        const outputStart = output.length;
        if (frame.kind === "value") {
          pushValue(frame.value, frames, output);
        } else if (frame.kind === "container") {
          pushContainer(frame, frames, output);
        } else if (frame.kind === "string") {
          if (
            !pushString(
              frame,
              frames,
              output,
              characterLimit - outputCharacters,
            )
          ) {
            frames.length = 0;
            output.length = 0;
            return {
              status: "limit",
              error: new ValueCopyLimitError(characterLimit),
            };
          }
        } else if (frame.kind === "raw") {
          const end = Math.min(
            frame.end,
            frame.offset + STRING_CHUNK_CHARACTERS,
          );
          output.push(sourceSlice(frame.source, frame.offset, end));
          if (end < frame.end) frames.push({ ...frame, offset: end });
        } else if (frame.kind === "utf8") {
          const end = Math.min(
            frame.end,
            frame.offset + STRING_CHUNK_CHARACTERS,
          );
          const complete = end >= frame.end;
          const text = frame.decoder.decode(
            frame.bytes.subarray(frame.offset, end),
            { stream: !complete },
          );
          output.push(frame.json ? JSON.stringify(text).slice(1, -1) : text);
          if (complete) {
            if (frame.json) output.push('"');
          } else {
            frames.push({ ...frame, offset: end });
          }
        } else {
          const end = Math.min(
            frame.bytes.length,
            frame.offset + BINARY_CHUNK_BYTES,
          );
          output.push(
            btoa(
              String.fromCharCode(...frame.bytes.subarray(frame.offset, end)),
            ),
          );
          if (end < frame.bytes.length) frames.push({ ...frame, offset: end });
          else if (frame.json) output.push('"');
        }
        for (let index = outputStart; index < output.length; index += 1) {
          outputCharacters += output[index]!.length;
        }
        // A serialized value must stay bounded before the one unavoidable
        // contiguous string required by Clipboard.writeText is allocated.
        if (outputCharacters > characterLimit) {
          frames.length = 0;
          output.length = 0;
          return {
            status: "limit",
            error: new ValueCopyLimitError(characterLimit),
          };
        }
      }
      if (frames.length > 0) return { status: "pending" };
      // Clipboard.writeText accepts one contiguous string. Keep every expensive
      // leaf conversion cancelable before this unavoidable browser boundary.
      return { status: "done", text: output.join("") };
    },
  };
}

export interface ValueCopyRequest {
  value: TypedValue;
  format: "json" | "raw";
}

export function createValueCopySerializer(
  request: ValueCopyRequest,
  characterLimit = VALUE_COPY_CHARACTER_LIMIT,
): ReturnType<typeof createValueJsonSerializer> {
  return createValueSerializer(
    request.value,
    characterLimit,
    request.format === "json",
  );
}

function pushRawRoot(
  input: TypedValue,
  frames: Frame[],
  output: string[],
): void {
  if (
    (input.kind === "arrow" && arrowValueIsNull(input)) ||
    (input.kind === "value" && input.value == null)
  ) {
    return;
  }
  if (input.kind === "arrow") {
    const utf8 = arrowUtf8Bytes(input);
    if (utf8 !== null) {
      frames.push({
        kind: "utf8",
        bytes: utf8.bytes,
        offset: utf8.start,
        end: utf8.end,
        decoder: new TextDecoder(),
        json: false,
      });
      return;
    }
  }
  if (input.kind === "value" && typeof input.value === "string") {
    frames.push({
      kind: "raw",
      source: input.value,
      offset: 0,
      end: input.value.length,
    });
    return;
  }
  const bytes = binaryValueBytes(input);
  if (bytes !== null) {
    frames.push({ kind: "binary", bytes, offset: 0, json: false });
    return;
  }
  output.push(valueToJson(input));
}

function formatCharacterLimit(limit: number): string {
  return `${limit.toLocaleString("en-US")}-character copy`;
}

function pushValue(input: TypedValue, frames: Frame[], output: string[]): void {
  if (input.kind === "json") {
    const start = input.root ? 0 : input.node.start;
    const end = input.root ? input.source.length : input.node.end;
    frames.push({ kind: "raw", source: input.source, offset: start, end });
    return;
  }
  if (input.kind === "rawJson") {
    frames.push({
      kind: "raw",
      source: input.value,
      offset: 0,
      end: input.value.length,
    });
    return;
  }
  if (input.kind === "jsonText" || input.kind === "invalidJson") {
    output.push('"');
    frames.push({
      kind: "string",
      value: input.value,
      offset: 0,
      suffix: "",
    });
    return;
  }

  const count = valueChildCount(input);
  if (input.kind === "mapEntry" || count > 0 || isEmptyContainer(input)) {
    const object = isStruct(input);
    output.push(object ? "{" : "[");
    frames.push({ kind: "container", value: input, index: 0, count, object });
    return;
  }

  if (input.kind === "arrow") {
    const utf8 = arrowUtf8Bytes(input);
    if (utf8 !== null) {
      output.push('"');
      frames.push({
        kind: "utf8",
        bytes: utf8.bytes,
        offset: utf8.start,
        end: utf8.end,
        decoder: new TextDecoder(),
        json: true,
      });
      return;
    }
  }
  if (input.kind === "value" && typeof input.value === "string") {
    output.push('"');
    frames.push({
      kind: "string",
      value: input.value,
      offset: 0,
      suffix: "",
    });
    return;
  }
  const bytes = binaryValueBytes(input);
  if (bytes !== null) {
    output.push('"');
    frames.push({ kind: "binary", bytes, offset: 0, json: true });
    return;
  }
  output.push(valueToJson(input));
}

function pushContainer(
  frame: Extract<Frame, { kind: "container" }>,
  frames: Frame[],
  output: string[],
): void {
  if (frame.index >= frame.count) {
    output.push(frame.object ? "}" : "]");
    return;
  }
  const child = serializationChildAt(frame.value, frame.index);
  frames.push({ ...frame, index: frame.index + 1 });
  if (child === undefined) {
    output.push(frame.index === 0 ? "null" : ",null");
    return;
  }
  if (frame.index > 0) output.push(",");
  if (frame.object) {
    const key = child.objectKey ?? child.label;
    frames.push({ kind: "value", value: child.value });
    frames.push({ kind: "string", value: key, offset: 0, suffix: ":" });
    output.push('"');
    return;
  }
  frames.push({ kind: "value", value: child.value });
}

function serializationChildAt(
  input: TypedValue,
  index: number,
): ValueChild | undefined {
  if (input.kind === "arrow") {
    const type = unwrapDictionary(input.dataType);
    if (type.typeId !== Type.Map) return valueChildAt(input, index);
    const entry = arrowMapEntry(input, index);
    return entry === undefined
      ? undefined
      : {
          label: `[${index}]`,
          key: false,
          value: { kind: "arrowMapEntry", ...entry },
        };
  }
  if (input.kind !== "value") return valueChildAt(input, index);
  const type = unwrapDictionary(input.dataType);
  if (type.typeId !== Type.Map) return valueChildAt(input, index);
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
  const entry = mapEntryAt(input.value, index);
  if (entry === undefined || keyType === undefined || valueType === undefined) {
    return undefined;
  }
  return {
    label: `[${index}]`,
    key: false,
    value: {
      kind: "mapEntry" as const,
      key: entry[0],
      value: entry[1],
      keyType,
      valueType,
    },
  };
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

function pushString(
  frame: Extract<Frame, { kind: "string" }>,
  frames: Frame[],
  output: string[],
  remainingCharacters: number,
): boolean {
  const closingCharacters = 1 + frame.suffix.length;
  if (remainingCharacters < closingCharacters) return false;
  const bodyBudget = remainingCharacters - closingCharacters;
  if (frame.offset < frame.value.length && bodyBudget <= 0) return false;
  let sourceCharacters = Math.min(
    STRING_CHUNK_CHARACTERS,
    Math.max(1, Math.floor(bodyBudget / 6)),
  );
  if (bodyBudget < 6) {
    const first = sourceSlice(frame.value, frame.offset, frame.offset + 2);
    sourceCharacters = first.codePointAt(0)! > 0xffff ? 2 : 1;
  }
  const end = Math.min(frame.value.length, frame.offset + sourceCharacters);
  const escaped = JSON.stringify(
    sourceSlice(frame.value, frame.offset, end),
  ).slice(1, -1);
  if (escaped.length > bodyBudget) return false;
  output.push(escaped);
  if (end < frame.value.length) frames.push({ ...frame, offset: end });
  else output.push(`"${frame.suffix}`);
  return true;
}

function isStruct(input: TypedValue): boolean {
  return (
    (input.kind === "value" || input.kind === "arrow") &&
    unwrapDictionary(input.dataType).typeId === Type.Struct
  );
}

function isEmptyContainer(input: TypedValue): boolean {
  if (input.kind === "mapEntry" || input.kind === "arrowMapEntry") return true;
  if (
    (input.kind !== "value" && input.kind !== "arrow") ||
    (input.kind === "value" ? input.value == null : arrowValueIsNull(input))
  ) {
    return false;
  }
  const type = unwrapDictionary(input.dataType);
  return (
    type.typeId === Type.Struct ||
    type.typeId === Type.Map ||
    type.typeId === Type.List ||
    type.typeId === Type.LargeList ||
    type.typeId === Type.FixedSizeList ||
    type.typeId === Type.ListView ||
    type.typeId === Type.LargeListView
  );
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
}
