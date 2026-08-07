import {
  binary,
  int64,
  list,
  struct,
  TimeUnit,
  timestamp,
  utf8,
} from "@uwdata/flechette";
import { describe, expect, it } from "vitest";

import { formatCellValue, usesMonospaceCells } from "./format-cell";

describe("formatCellValue", () => {
  it("renders null as a muted label but copies an empty raw field", () => {
    expect(formatCellValue(null, utf8())).toEqual({
      displayData: "null",
      copyData: "",
      align: "left",
      faded: true,
    });
  });

  it("renders binary as a size label and copies the complete bytes as base64", () => {
    expect(formatCellValue(new Uint8Array([1, 2, 3]), binary())).toEqual({
      displayData: "binary · 3 B",
      copyData: "AQID",
      align: "left",
      faded: false,
    });
  });

  it("copies binary values larger than one conversion chunk without corruption", () => {
    const bytes = new Uint8Array(65_543);
    bytes.forEach((_value, index) => {
      bytes[index] = index % 251;
    });

    const encoded = formatCellValue(bytes, binary()).copyData;
    const decoded = Uint8Array.from(atob(encoded), (byte) =>
      byte.charCodeAt(0),
    );

    expect(decoded).toEqual(bytes);
  });

  it("renders timestamps in ISO form and copies the raw Arrow integer", () => {
    const raw = BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf());
    expect(
      formatCellValue(raw, timestamp(TimeUnit.MILLISECOND, "UTC")),
    ).toMatchObject({
      displayData: "2026-08-01T06:07:08.009Z",
      copyData: raw.toString(),
    });
  });

  it("preserves microsecond precision in timestamp display", () => {
    const raw =
      BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf()) * 1_000n + 456n;
    expect(
      formatCellValue(raw, timestamp(TimeUnit.MICROSECOND, "UTC")),
    ).toMatchObject({
      displayData: "2026-08-01T06:07:08.009456Z",
      copyData: raw.toString(),
    });
  });

  it("renders nested values as compact JSON and copies the full JSON", () => {
    const type = struct({ tags: list(int64()) });
    const value = { tags: [1n, 2n] };

    expect(formatCellValue(value, type)).toEqual({
      displayData: '{"tags":["1","2"]}',
      copyData: '{"tags":["1","2"]}',
      align: "left",
      faded: false,
    });
    expect(usesMonospaceCells(type)).toBe(true);
  });

  it("preserves emoji sequences in display and copy text", () => {
    const value = "emoji 🦆 · family 👨‍👩‍👧‍👦";

    expect(formatCellValue(value, utf8())).toEqual({
      displayData: value,
      copyData: value,
      align: "left",
      faded: false,
    });
  });

  it("right-aligns integers and marks their columns as monospace", () => {
    expect(formatCellValue(42n, int64())).toMatchObject({
      displayData: "42",
      copyData: "42",
      align: "right",
    });
    expect(usesMonospaceCells(int64())).toBe(true);
  });
});
