import {
  binary,
  decimal128,
  field,
  float64,
  int32,
  int64,
  list,
  map,
  struct,
  TimeUnit,
  timestamp,
  utf8,
} from "@uwdata/flechette";
import { describe, expect, it, vi } from "vitest";

import {
  formatValuePath,
  formatValuePreview,
  formatValuePreviewTokens,
  fullValueText,
  typedValue,
  valueChildAt,
  valueChildCount,
  valueToJson,
} from "./value-format";

describe("recursive value formatting", () => {
  it("uses child Arrow types for decimal, timestamp, and binary values", () => {
    const type = struct([
      field("price", decimal128(9, 2)),
      field("recorded_at", timestamp(TimeUnit.MILLISECOND, "UTC")),
      field("payload", binary()),
    ]);
    const epoch = BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf());
    const input = typedValue(
      {
        price: 1999n,
        recorded_at: epoch,
        payload: new Uint8Array([1, 2, 3]),
      },
      type,
    );

    expect(formatValuePreview(input)).toBe(
      "{price: 19.99, recorded_at: 2026-08-01T06:07:08.009Z, payload: binary · 3 B}",
    );
    expect(JSON.parse(valueToJson(input))).toEqual({
      price: 19.99,
      recorded_at: Number(epoch),
      payload: "AQID",
    });
  });

  it("quotes unsafe integers and represents maps according to their key type", () => {
    const unsafe = 9_007_199_254_740_993n;
    const stringMap = typedValue(
      new Map([
        ["safe", 7n],
        ["unsafe", unsafe],
      ]),
      map(utf8(), int64()),
    );
    const integerMap = typedValue(
      new Map([
        [1, "one"],
        [2, "two"],
      ]),
      map(int32(), utf8()),
    );

    expect(JSON.parse(valueToJson(stringMap))).toEqual({
      safe: 7,
      unsafe: unsafe.toString(),
    });
    expect(JSON.parse(valueToJson(integerMap))).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
  });

  it("quotes decimals whose text or scale cannot survive JSON parsing", () => {
    const wide = 12_345_678_901_234_567_890_123_456_789_012_345_678n;
    expect(JSON.parse(valueToJson(typedValue(wide, decimal128(38, 2))))).toBe(
      "123456789012345678901234567890123456.78",
    );
    expect(JSON.parse(valueToJson(typedValue(120n, decimal128(6, 2))))).toBe(
      "1.20",
    );
    expect(JSON.parse(valueToJson(typedValue(1999n, decimal128(9, 2))))).toBe(
      19.99,
    );
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
  ])("copies non-finite %s as a lossless JSON string", (value, expected) => {
    expect(JSON.parse(valueToJson(typedValue(value, float64())))).toBe(
      expected,
    );
  });

  it("bounds formatter child reads after Arrow value materialization", () => {
    expect(formatValuePreview(typedValue([], list(utf8())))).toBe("[0]");
    // This synthetic value measures only formatter work. Flechette may already
    // have materialized an Arrow child before it reaches this module boundary.
    const huge = ["x".repeat(1_000), "unread"];
    Object.defineProperty(huge, 1, {
      get: () => {
        throw new Error("preview traversed beyond its budget");
      },
    });

    const preview = formatValuePreview(typedValue(huge, list(utf8())), 12);
    expect(preview.startsWith("[2] ")).toBe(true);
    expect(preview.endsWith('…"')).toBe(true);
  });

  it("serializes only a bounded prefix of a multi-megabyte nested string", () => {
    const originalStringify = JSON.stringify;
    const stringify = vi
      .spyOn(JSON, "stringify")
      .mockImplementation((value) => {
        if (typeof value === "string" && value.length > 2) {
          throw new Error("preview serialized beyond its bounded prefix");
        }
        return originalStringify(value);
      });

    try {
      const preview = formatValuePreview(
        typedValue(["\0".repeat(2 * 1024 * 1024)], list(utf8())),
        36,
      );

      expect(preview).toMatch(/^\[1\] "/);
      expect(preview.endsWith('…"')).toBe(true);
      expect(stringify.mock.calls.length).toBeLessThan(36);
    } finally {
      stringify.mockRestore();
    }
  });

  it.each([
    ["abcdef", 6, '"abc…"'],
    ['a"\\\ncontrol', 12, '"a\\"\\\\\\nco…"'],
    ["ab😀tail", 7, '"ab😀…"'],
    ["x", 1, "…"],
    ["x", 2, "…"],
    ["xy", 3, '"…"'],
  ])(
    "keeps string preview valid and escape-aligned within its budget",
    (value, limit, expected) => {
      const preview = formatValuePreview(typedValue(value, utf8()), limit);
      expect(preview).toBe(expected);
      expect(preview.length).toBeLessThanOrEqual(limit);
      if (preview.startsWith('"'))
        expect(() => JSON.parse(preview)).not.toThrow();
    },
  );

  it("distinguishes a null struct from a struct containing null fields", () => {
    const type = struct({ a: utf8() });
    expect(formatValuePreview(typedValue(null, type))).toBe("null");
    expect(formatValuePreview(typedValue({ a: null }, type))).toBe("{a: null}");
    expect(valueChildCount(typedValue(null, type))).toBe(0);
    expect(valueChildCount(typedValue({ a: null }, type))).toBe(1);
    expect(formatValuePreviewTokens(typedValue({ a: null }, type))).toEqual([
      { text: "{", tone: "secondary" },
      { text: "a", tone: "value" },
      { text: ":", tone: "secondary" },
      { text: " ", tone: "value" },
      { text: "null", tone: "null" },
      { text: "}", tone: "secondary" },
    ]);
  });

  it("retains five levels for JSON while previewing only the first", () => {
    const type = struct({
      level2: struct({
        level3: struct({ level4: struct({ level5: list(int64()) }) }),
      }),
    });
    const value = {
      level2: { level3: { level4: { level5: [1n, 2n] } } },
    };
    const input = typedValue(value, type);

    expect(formatValuePreview(input)).toBe("{level2: {…}}");
    expect(JSON.parse(valueToJson(input))).toEqual({
      level2: { level3: { level4: { level5: [1, 2] } } },
    });
  });

  it("provides lazy schema-ordered children and the fixed path grammar", () => {
    const type = struct({
      addr: struct({ "weird name": list(utf8()) }),
    });
    const root = typedValue(
      { addr: { "weird name": ["a", "b", "c", "d"] } },
      type,
    );
    const addr = valueChildAt(root, 0);
    const weird = addr === undefined ? undefined : valueChildAt(addr.value, 0);
    const item = weird === undefined ? undefined : valueChildAt(weird.value, 3);

    expect(addr?.label).toBe("addr");
    expect(item?.label).toBe("[3]");
    expect(formatValuePath(["addr", "weird name", 3])).toBe(
      'addr."weird name"[3]',
    );
  });

  it("preserves null semantics in full scalar text", () => {
    expect(fullValueText(typedValue(null, binary()))).toBe("null");
  });
});
