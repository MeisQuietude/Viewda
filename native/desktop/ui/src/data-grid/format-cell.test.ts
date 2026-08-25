import {
  binary,
  binaryView,
  bool,
  dateDay,
  dateMillisecond,
  decimal128,
  dictionary,
  duration,
  fixedSizeBinary,
  float32,
  int64,
  IntervalUnit,
  interval,
  largeBinary,
  largeUtf8,
  list,
  map,
  nullType,
  struct,
  timeMicrosecond,
  timeMillisecond,
  timeNanosecond,
  timeSecond,
  TimeUnit,
  timestamp,
  utf8,
  utf8View,
  type DataType,
} from "@uwdata/flechette";
import { describe, expect, it, vi } from "vitest";

import {
  formatCellValue,
  formatTypedScalarCopyData,
  usesMonospaceCells,
} from "./format-cell";
import { typedValue } from "./value-format";
import * as valueFormat from "./value-format";

describe("formatCellValue", () => {
  it("formats scalar copy data without traversing the display path", () => {
    let reads = 0;
    const value = {
      toString() {
        reads += 1;
        return "raw";
      },
    };

    expect(formatTypedScalarCopyData(typedValue(value, utf8()))).toBe("raw");
    expect(reads).toBe(1);
  });

  it("copies dates and decimals without invoking preview formatting", () => {
    const preview = vi.spyOn(valueFormat, "formatValuePreview");

    expect(formatTypedScalarCopyData(typedValue(1999n, decimal128(9, 2)))).toBe(
      "19.99",
    );
    expect(formatTypedScalarCopyData(typedValue(0, dateDay()))).toBe(
      "1970-01-01",
    );
    expect(
      formatTypedScalarCopyData(typedValue(86_400_000, dateMillisecond())),
    ).toBe("1970-01-02");
    expect(preview).not.toHaveBeenCalled();
  });

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

  it.each([
    [timeSecond(), 3_661, "01:01:01"],
    [timeMillisecond(), 3_661_123, "01:01:01.123"],
    [timeMicrosecond(), 3_661_123_456n, "01:01:01.123456"],
    [timeNanosecond(), 3_661_123_456_789n, "01:01:01.123456789"],
  ] as const)(
    "formats %s as a clock while copying its lossless Arrow count",
    (type, value, expected) => {
      expect(formatCellValue(value, type)).toMatchObject({
        displayData: expected,
        copyData: String(value),
      });
    },
  );

  it.each([-1, 86_400])(
    "leaves out-of-range Arrow time count %s unmodified",
    (value) => {
      expect(formatCellValue(value, timeSecond())).toMatchObject({
        displayData: String(value),
        copyData: String(value),
      });
    },
  );

  it.each([
    [interval(IntervalUnit.YEAR_MONTH), 14, "14 mo"],
    [interval(IntervalUnit.DAY_TIME), new Int32Array([1, 2]), "1 d 2 ms"],
    [
      interval(IntervalUnit.MONTH_DAY_NANO),
      new Float64Array([1, 1, 1_000_000_000]),
      "1 mo 1 d 1000000000 ns",
    ],
  ] as const)(
    "formats %s with explicit interval units",
    (type, value, expected) => {
      expect(formatCellValue(value, type).displayData).toBe(expected);
    },
  );

  it("renders nested values with the preview grammar and copies full JSON", () => {
    const type = struct({ tags: list(int64()) });
    const value = { tags: [1n, 2n] };

    expect(formatCellValue(value, type)).toMatchObject({
      displayData: "{tags: […]}",
      copyData: '{"tags":[1,2]}',
      align: "left",
      faded: false,
    });
    expect(usesMonospaceCells(type)).toBe(true);
  });

  it("adds bounded semantic segments only to nested grid previews", () => {
    const nested = formatCellValue(
      { null: null, text: "null" },
      struct({ null: utf8(), text: utf8() }),
      false,
    );
    const scalar = formatCellValue("null", utf8(), false);

    expect(nested.segments?.map(({ text }) => text).join("")).toBe(
      nested.displayData,
    );
    expect(nested.displayData.length).toBeLessThanOrEqual(120);
    expect(nested.segments).toContainEqual({ text: "null", tone: "key" });
    expect(nested.segments).toContainEqual({ text: "null", tone: "null" });
    expect(nested.segments).toContainEqual({ text: '"null"', tone: "string" });
    expect(scalar).not.toHaveProperty("segments");
  });

  it("stops formatting nested display values after the visible preview", () => {
    const type = list(utf8());
    const value = ["x".repeat(1_000), "unread"];
    Object.defineProperty(value, 1, {
      get: () => {
        throw new Error("the preview traversed beyond its character budget");
      },
    });

    const presentation = formatCellValue(value, type, false);

    expect(presentation.displayData).toHaveLength(120);
    expect(presentation.displayData.endsWith('…"')).toBe(true);
    expect(presentation.copyData).toBe("");
  });

  it("collapses nesting below the first preview level", () => {
    let value: unknown = 1;
    let type: DataType = int64();
    for (let depth = 0; depth < 40; depth += 1) {
      value = [value];
      type = list(type);
    }

    const full = formatCellValue(value, type);
    const displayOnly = formatCellValue(value, type, false);

    expect(displayOnly.displayData).toBe("[1] […]");
    expect(full.displayData).toBe("[1] […]");
    expect(displayOnly.copyData).toBe("");
  });

  it("uses count-first map previews without serializing copy data on scroll", () => {
    const value = [
      ["count", "7"],
      ["bytes", "three"],
    ];
    const type = map(utf8(), utf8());

    expect(formatCellValue(value, type, false).displayData).toBe(
      '{2} "count" → "7", "bytes" → "three"',
    );
    expect(formatCellValue(value, type, false).copyData).toBe("");
  });

  it("keeps large nested copy data complete when its display is truncated", () => {
    const value = Array.from({ length: 200 }, (_, index) => `value-${index}`);
    const presentation = formatCellValue(value, list(utf8()));

    expect(presentation.displayData.endsWith('…"')).toBe(true);
    expect(presentation.copyData).toBe(JSON.stringify(value));
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

  it.each([
    ["null", null, nullType(), "null", ""],
    ["int", 42n, int64(), "42", "42"],
    ["float", 1.5, float32(), "1.5", "1.5"],
    ["binary", new Uint8Array([1, 2]), binary(), "binary · 2 B", "AQI="],
    [
      "large binary",
      new Uint8Array([1, 2]),
      largeBinary(),
      "binary · 2 B",
      "AQI=",
    ],
    [
      "fixed binary",
      new Uint8Array([1, 2]),
      fixedSizeBinary(2),
      "binary · 2 B",
      "AQI=",
    ],
    [
      "binary view",
      new Uint8Array([1, 2]),
      binaryView(),
      "binary · 2 B",
      "AQI=",
    ],
    ["utf8", "duck", utf8(), "duck", "duck"],
    ["large utf8", "duck", largeUtf8(), "duck", "duck"],
    ["utf8 view", "duck", utf8View(), "duck", "duck"],
    ["boolean", true, bool(), "true", "true"],
    ["decimal", 1999n, decimal128(9, 2), "19.99", "19.99"],
    ["date day", 0, dateDay(), "1970-01-01", "1970-01-01"],
    [
      "date millisecond",
      86_400_000,
      dateMillisecond(),
      "1970-01-02",
      "1970-01-02",
    ],
    ["time", 1_234n, timeMicrosecond(), "00:00:00.001234", "1234"],
    [
      "timestamp",
      1_000n,
      timestamp(TimeUnit.MILLISECOND, "UTC"),
      "1970-01-01T00:00:01.000Z",
      "1000",
    ],
    [
      "interval",
      new Int32Array([1, 2]),
      interval(IntervalUnit.DAY_TIME),
      "1 d 2 ms",
      "1,2",
    ],
    ["duration", 42n, duration(TimeUnit.SECOND), "42", "42"],
    ["dictionary", "duck", dictionary(utf8()), "duck", "duck"],
  ] as const)(
    "preserves top-level %s formatting",
    (_name, value, type, displayData, copyData) => {
      expect(formatCellValue(value, type)).toMatchObject({
        displayData,
        copyData,
      });
    },
  );
});
