import { Type, type DataType } from "@uwdata/flechette";

import {
  formatCellDisplay,
  formatDateDecimalText,
  formatValuePreviewTokens,
  isNumericType,
  materializedScalarValue,
  typedValue,
  valueToJson,
  type TypedValue,
  type PreviewToken,
} from "./value-format";
import { arrowValueIsNull } from "./arrow-value";

export interface CellPresentation {
  displayData: string;
  copyData: string;
  align: "left" | "right";
  faded: boolean;
  segments?: readonly PreviewToken[];
}

export function formatCellValue(
  value: unknown,
  dataType: DataType,
  includeRawCopy = true,
): CellPresentation {
  return formatTypedCellValue(typedValue(value, dataType), includeRawCopy);
}

export function formatTypedCellValue(
  input: TypedValue,
  includeRawCopy: boolean,
): CellPresentation {
  if (input.kind !== "value" && input.kind !== "arrow") {
    throw new Error("A grid cell requires an Arrow-typed value.");
  }
  const value = input.kind === "value" ? input.value : undefined;
  const dataType = input.dataType;
  const type = unwrapDictionary(dataType);

  if (
    (input.kind === "value" && value === null) ||
    (input.kind === "arrow" && arrowValueIsNull(input))
  ) {
    return presentation("null", "", false, true);
  }
  const nested = isNested(type);
  const segments = nested ? formatValuePreviewTokens(input) : undefined;
  const displayData =
    segments === undefined
      ? formatCellDisplay(input)
      : segments.map(({ text }) => text).join("");
  const copyData = includeRawCopy
    ? nested
      ? valueToJson(input)
      : formatTypedScalarCopyData(input)
    : "";
  return presentation(
    displayData,
    copyData,
    isNumericType(type),
    false,
    segments,
  );
}

/** Formats scalar clipboard data without constructing the grid display preview. */
export function formatTypedScalarCopyData(input: TypedValue): string {
  if (input.kind !== "value" && input.kind !== "arrow") {
    throw new Error("A grid cell requires an Arrow-typed value.");
  }
  if (
    (input.kind === "value" && input.value === null) ||
    (input.kind === "arrow" && arrowValueIsNull(input))
  ) {
    return "";
  }
  const type = unwrapDictionary(input.dataType);
  if (isNested(type)) {
    throw new Error(
      "Nested grid cells require incremental copy serialization.",
    );
  }
  return scalarCopyData(
    input.kind === "arrow" ? materializedScalarValue(input) : input.value,
    type,
    input,
  );
}

export function usesMonospaceCells(dataType: DataType): boolean {
  const type = unwrapDictionary(dataType);
  return isNumericType(type) || isNested(type);
}

function presentation(
  displayData: string,
  copyData: string,
  alignRight: boolean,
  faded: boolean,
  segments?: readonly PreviewToken[],
): CellPresentation {
  return {
    displayData,
    copyData,
    align: alignRight ? "right" : "left",
    faded,
    ...(segments === undefined ? {} : { segments }),
  };
}

function unwrapDictionary(dataType: DataType): DataType {
  return dataType.typeId === Type.Dictionary
    ? unwrapDictionary(dataType.dictionary)
    : dataType;
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

function scalarCopyData(
  value: unknown,
  dataType: DataType,
  input: TypedValue,
): string {
  if (
    dataType.typeId === Type.Binary ||
    dataType.typeId === Type.LargeBinary ||
    dataType.typeId === Type.FixedSizeBinary ||
    dataType.typeId === Type.BinaryView
  ) {
    return JSON.parse(valueToJson(input)) as string;
  }
  if (dataType.typeId === Type.Date || dataType.typeId === Type.Decimal) {
    return formatDateDecimalText(value, dataType);
  }
  if (dataType.typeId === Type.Timestamp || isNumericType(dataType)) {
    return typeof value === "bigint" ? value.toString() : String(value);
  }
  return String(value);
}
