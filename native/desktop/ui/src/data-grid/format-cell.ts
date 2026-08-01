import { TimeUnit, Type, type DataType } from "@uwdata/flechette";

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
    const iso = timestampToIso(value, type.unit);
    const raw = typeof value === "bigint" ? value.toString() : String(value);
    return presentation(iso, raw, false, false);
  }

  if (type.typeId === Type.Date) {
    const iso = timestampToIso(value, TimeUnit.MILLISECOND).slice(0, 10);
    return presentation(iso, iso, false, false);
  }

  if (type.typeId === Type.Decimal) {
    const decimal = formatDecimal(value, type.scale);
    return presentation(decimal, decimal, true, false);
  }

  if (isNumber(type)) {
    const raw = typeof value === "bigint" ? value.toString() : String(value);
    return presentation(raw, raw, true, false);
  }

  if (isNested(type)) {
    const raw = stringifyNested(value);
    const preview =
      raw.length <= NESTED_PREVIEW_LIMIT
        ? raw
        : `${raw.slice(0, NESTED_PREVIEW_LIMIT - 1)}…`;
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

function timestampToIso(value: unknown, unit: number): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "bigint") {
    const date = new Date(typeof value === "number" ? value : String(value));
    return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
  }

  const [milliseconds, submillisecond, precision] = timestampParts(value, unit);
  const date = new Date(Number(milliseconds));
  if (Number.isNaN(date.valueOf())) {
    return value.toString();
  }
  const iso = date.toISOString();
  return precision === 0
    ? iso
    : `${iso.slice(0, -1)}${submillisecond.toString().padStart(precision, "0")}Z`;
}

function timestampParts(
  value: bigint,
  unit: number,
): [milliseconds: bigint, submillisecond: bigint, precision: number] {
  if (unit === TimeUnit.SECOND) {
    return [value * 1_000n, 0n, 0];
  }
  if (unit === TimeUnit.MILLISECOND) {
    return [value, 0n, 0];
  }
  const divisor = unit === TimeUnit.MICROSECOND ? 1_000n : 1_000_000n;
  const precision = unit === TimeUnit.MICROSECOND ? 3 : 6;
  let milliseconds = value / divisor;
  let submillisecond = value % divisor;
  if (submillisecond < 0) {
    milliseconds -= 1n;
    submillisecond += divisor;
  }
  return [milliseconds, submillisecond, precision];
}

function formatDecimal(value: unknown, scale: number): string {
  if (typeof value !== "bigint" && typeof value !== "number") {
    return String(value);
  }
  const integer = typeof value === "bigint" ? value : BigInt(value);
  const negative = integer < 0;
  const digits = (negative ? -integer : integer).toString();

  if (scale <= 0) {
    return `${negative ? "-" : ""}${digits}${"0".repeat(-scale)}`;
  }

  const padded = digits.padStart(scale + 1, "0");
  const point = padded.length - scale;
  return `${negative ? "-" : ""}${padded.slice(0, point)}.${padded.slice(point)}`;
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
