import { TimeUnit, Type, type DataType } from "@uwdata/flechette";

import type { DataFilter, SchemaField, SortColumn } from "../desktop";

export type ColumnFilterKind =
  "boolean" | "number" | "text" | "temporal" | "nullOnly";

export type TemporalFormat =
  | {
      valueKind: "date";
      hint: string;
    }
  | {
      valueKind: "time" | "timestamp";
      hint: string;
      prefillFractionDigits: number;
      timezone: "local" | "UTC" | null;
    };

const TEMPORAL_TYPE_PATTERN =
  /^(Time|Timestamp) \((milliseconds|microseconds|nanoseconds), (local|UTC)\)$/;

export function columnFilterKind(field: SchemaField): ColumnFilterKind {
  if (field.physicalType === "GROUP") {
    return "nullOnly";
  }
  if (
    field.logicalType?.startsWith("Date") ||
    field.logicalType?.startsWith("Time") ||
    field.logicalType?.startsWith("Timestamp") ||
    field.physicalType === "INT96"
  ) {
    return "temporal";
  }
  if (
    field.logicalType?.startsWith("String") ||
    field.logicalType?.startsWith("Enum") ||
    field.logicalType?.startsWith("JSON") ||
    field.logicalType?.startsWith("UUID")
  ) {
    return "text";
  }
  if (
    field.logicalType?.startsWith("Decimal") ||
    field.logicalType === "Float16"
  ) {
    return "number";
  }
  if (field.physicalType === "BOOLEAN") {
    return "boolean";
  }
  if (["INT32", "INT64", "FLOAT", "DOUBLE"].includes(field.physicalType)) {
    return "number";
  }
  return "nullOnly";
}

export function temporalFormatForField(
  field: SchemaField,
): TemporalFormat | null {
  if (field.logicalType === "Date") {
    return {
      valueKind: "date",
      hint: "YYYY-MM-DD",
    };
  }

  const match = field.logicalType?.match(TEMPORAL_TYPE_PATTERN);
  if (match !== undefined && match !== null) {
    const valueKind = match[1] === "Time" ? "time" : "timestamp";
    const unit = match[2]!;
    const timezone = match[3] as "local" | "UTC";
    const prefillFractionDigits =
      unit === "milliseconds" ? 3 : unit === "microseconds" ? 6 : 9;
    const inputPrefix =
      valueKind === "time" ? "HH:mm:ss" : "YYYY-MM-DDTHH:mm:ss";
    const timezoneRule =
      timezone === "local"
        ? "timezone suffix: not allowed"
        : valueKind === "timestamp"
          ? "timezone: required, Z or ±HH:mm"
          : "offset: optional, ±HH:mm";
    return {
      valueKind,
      hint: `${inputPrefix}; fraction: optional, 1–9 digits; ${timezoneRule}; column: ${unit}, ${timezone}`,
      prefillFractionDigits,
      timezone,
    };
  }

  return field.physicalType === "INT96"
    ? {
        valueKind: "timestamp",
        hint: "YYYY-MM-DDTHH:mm:ss; fraction: optional, 1–9 digits; timezone suffix: not allowed; column: INT96",
        prefillFractionDigits: 9,
        timezone: null,
      }
    : null;
}

/** Returns the canonical editor value for an Arrow cell. */
export function filterInputFromCell(
  value: unknown,
  dataType: DataType,
  field: SchemaField,
): string {
  const type = unwrapDictionary(dataType);
  if (type.typeId === Type.Timestamp) {
    const format = temporalFormatForField(field);
    const iso =
      format?.valueKind === "timestamp"
        ? limitFractionDigits(
            timestampToText(value, type.unit),
            format.prefillFractionDigits,
          )
        : timestampToText(value, type.unit);
    const timezone =
      format?.valueKind === "timestamp"
        ? format.timezone
        : type.timezone === null
          ? "local"
          : "UTC";
    return timezone === "UTC" ? iso : iso.replace(/Z$/, "");
  }
  if (type.typeId === Type.Date) {
    return timestampToText(value, TimeUnit.MILLISECOND).slice(0, 10);
  }
  if (type.typeId === Type.Time) {
    const text = timeToText(value, type.unit);
    const format = temporalFormatForField(field);
    if (format?.valueKind !== "time") {
      return text;
    }
    const limited = limitFractionDigits(text, format.prefillFractionDigits);
    return format.timezone === "UTC" ? `${limited}+00:00` : limited;
  }
  if (type.typeId === Type.Decimal) {
    return decimalToText(value, type.scale);
  }
  return String(value);
}

function limitFractionDigits(value: string, maximum: number): string {
  const match = /^(.*)\.(\d+)(Z?)$/.exec(value);
  return match === null
    ? value
    : `${match[1]}.${match[2]!.slice(0, maximum)}${match[3]}`;
}

export function formatWhereClause(
  filters: readonly DataFilter[],
  schema: readonly SchemaField[],
): string {
  return filters
    .map((filter) => {
      const field = schema[filter.columnIndex];
      return field === undefined ? "" : formatFilterCondition(filter, field);
    })
    .filter((condition) => condition.length > 0)
    .join(" AND ");
}

export function formatOrderByClause(
  sort: readonly SortColumn[],
  schema: readonly SchemaField[],
): string {
  return sort
    .map((column) => {
      const field = schema[column.sourceIndex];
      if (field === undefined) {
        return "";
      }
      const direction = column.direction === "ascending" ? "ASC" : "DESC";
      return `${quoteIdentifier(field.name)} ${direction}`;
    })
    .filter((condition) => condition.length > 0)
    .join(", ");
}

export function formatFilterCondition(
  filter: DataFilter,
  field: SchemaField,
): string {
  const identifier = quoteIdentifier(field.name);
  const literal = (value: string | undefined) =>
    formatFilterLiteral(value ?? "", field, identifier);
  switch (filter.operator) {
    case "equals":
      return `${identifier} = ${literal(filter.values[0])}`;
    case "notEquals":
      return `${identifier} <> ${literal(filter.values[0])}`;
    case "greaterThan":
      return `${identifier} > ${literal(filter.values[0])}`;
    case "greaterThanOrEqual":
      return `${identifier} >= ${literal(filter.values[0])}`;
    case "lessThan":
      return `${identifier} < ${literal(filter.values[0])}`;
    case "lessThanOrEqual":
      return `${identifier} <= ${literal(filter.values[0])}`;
    case "oneOf":
      return `${identifier} IN (${filter.values.map(literal).join(", ")})`;
    case "range":
      return `${identifier} BETWEEN ${literal(filter.values[0])} AND ${literal(filter.values[1])}`;
    case "textContains":
      return formatTextCondition("contains", filter, identifier);
    case "notContains":
      return `NOT ${formatTextCondition("contains", filter, identifier)}`;
    case "startsWith":
      return formatTextCondition("starts_with", filter, identifier);
    case "endsWith":
      return formatTextCondition("ends_with", filter, identifier);
    case "isNull":
      return `${identifier} IS NULL`;
    case "isNotNull":
      return `${identifier} IS NOT NULL`;
  }
}

function formatTextCondition(
  functionName: string,
  filter: DataFilter,
  identifier: string,
): string {
  const value = quoteString(filter.values[0] ?? "");
  return filter.matchCase === true
    ? `${functionName}(CAST(${identifier} AS VARCHAR), ${value})`
    : `${functionName}(lower(CAST(${identifier} AS VARCHAR)), lower(${value}))`;
}

function formatFilterLiteral(
  value: string,
  field: SchemaField,
  identifier: string,
): string {
  const logicalType = field.logicalType;
  if (logicalType?.startsWith("Date")) {
    return `DATE ${quoteString(value)}`;
  }
  if (logicalType?.startsWith("Timestamp") || field.physicalType === "INT96") {
    return `TIMESTAMP ${quoteString(value)}`;
  }
  if (logicalType?.startsWith("Time")) {
    return `TIME ${quoteString(value)}`;
  }
  if (logicalType?.startsWith("Decimal")) {
    return `cast_to_type(${quoteString(value)}, ${identifier})`;
  }
  const kind = columnFilterKind(field);
  if (kind === "boolean") {
    return value.toUpperCase();
  }
  if (kind === "number") {
    return value;
  }
  return quoteString(value);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function timestampToText(value: unknown, unit: number): string {
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

export function decimalToText(value: unknown, scale: number): string {
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

function timeToText(value: unknown, unit: number): string {
  if (
    (typeof value !== "bigint" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isInteger(value))
  ) {
    return String(value);
  }

  const raw = typeof value === "bigint" ? value : BigInt(value);
  const unitsPerSecond =
    unit === TimeUnit.SECOND
      ? 1n
      : unit === TimeUnit.MILLISECOND
        ? 1_000n
        : unit === TimeUnit.MICROSECOND
          ? 1_000_000n
          : 1_000_000_000n;
  const unitsPerDay = 86_400n * unitsPerSecond;
  if (raw < 0 || raw >= unitsPerDay) {
    return raw.toString();
  }

  const wholeSeconds = raw / unitsPerSecond;
  const fraction = raw % unitsPerSecond;
  const hours = wholeSeconds / 3_600n;
  const minutes = (wholeSeconds % 3_600n) / 60n;
  const seconds = wholeSeconds % 60n;
  const fractionWidth =
    unit === TimeUnit.SECOND
      ? 0
      : unit === TimeUnit.MILLISECOND
        ? 3
        : unit === TimeUnit.MICROSECOND
          ? 6
          : 9;
  const suffix =
    fractionWidth === 0
      ? ""
      : `.${fraction.toString().padStart(fractionWidth, "0")}`;
  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${seconds.toString().padStart(2, "0")}${suffix}`;
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
}
