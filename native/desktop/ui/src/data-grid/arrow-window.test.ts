import { decimal128, tableFromArrays, tableToIPC } from "@uwdata/flechette";
import { describe, expect, it } from "vitest";

import { decodeArrowWindow, windowDataType, windowValue } from "./arrow-window";
import { formatCellValue } from "./format-cell";

describe("decodeArrowWindow", () => {
  it("keeps decimal128 integers exact and in digit notation across 2^64", () => {
    const twoTo64 = 1n << 64n;
    const values = [twoTo64 - 1n, twoTo64, twoTo64 + 1n, 10n ** 38n - 1n];
    const table = tableFromArrays(
      { wideInteger: values },
      {
        types: { wideInteger: decimal128(38, 0) },
        useDecimalInt: true,
      },
    );
    const bytes = tableToIPC(table, { format: "stream" });
    expect(bytes).not.toBeNull();

    const window = decodeArrowWindow(Uint8Array.from(bytes!).buffer, 0);
    const type = windowDataType(window, 0);
    expect(type).toBeDefined();
    const decoded = values.map((_value, row) => windowValue(window, 0, row));
    const presentations = decoded.map((value) => formatCellValue(value, type!));

    expect(decoded).toEqual(values);
    expect(presentations.map(({ displayData }) => displayData)).toEqual(
      values.map(String),
    );
    expect(presentations.map(({ copyData }) => copyData)).toEqual(
      values.map(String),
    );
    expect(
      presentations.every(({ displayData }) => /^\d+$/.test(displayData)),
    ).toBe(true);
  });
});
