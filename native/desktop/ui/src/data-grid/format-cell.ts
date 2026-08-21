import { Type, type DataType } from "@uwdata/flechette";

import {
  formatCellDisplay,
  formatValuePreview,
  isNumericType,
  typedValue,
  valueToJson,
} from "./value-format";

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
  const input = typedValue(value, type);
  const displayData = formatCellDisplay(input);
  const nested = isNested(type);
  const copyData = includeRawCopy
    ? nested
      ? valueToJson(input)
      : scalarCopyData(value, type, input)
    : "";
  return presentation(displayData, copyData, isNumericType(type), false);
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
  input: ReturnType<typeof typedValue>,
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
    return formatValuePreview(input);
  }
  if (dataType.typeId === Type.Timestamp || isNumericType(dataType)) {
    return typeof value === "bigint" ? value.toString() : String(value);
  }
  return String(value);
}
