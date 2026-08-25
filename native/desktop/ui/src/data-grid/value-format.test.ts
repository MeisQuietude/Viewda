import {
  binary,
  bool,
  decimal128,
  field,
  float64,
  int32,
  int64,
  interval,
  IntervalUnit,
  list,
  map,
  struct,
  timeNanosecond,
  TimeUnit,
  timestamp,
  utf8,
} from "@uwdata/flechette";
import { describe, expect, it, vi } from "vitest";

import {
  formatValuePreview,
  formatValuePreviewTokens,
  formatBinaryHexRow,
  fullValueText,
  typedValue,
  valueChildAt,
  valueChildCount,
  valueToJson,
  valueTypeLabel,
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

  it("quotes unsafe integers and keeps maps as ordered entry pairs", () => {
    const unsafe = 9_007_199_254_740_993n;
    const stringMap = typedValue(
      [
        ["safe", 7n],
        ["unsafe", unsafe],
      ],
      map(utf8(), int64()),
    );
    const integerMap = typedValue(
      [
        [1, "one"],
        [2, "two"],
      ],
      map(int32(), utf8()),
    );

    expect(JSON.parse(valueToJson(stringMap))).toEqual([
      ["safe", 7],
      ["unsafe", unsafe.toString()],
    ]);
    expect(JSON.parse(valueToJson(integerMap))).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
  });

  it("preserves duplicate string map keys when copied", () => {
    const input = typedValue(
      [
        ["language", "English"],
        ["language", "French"],
      ],
      map(utf8(), utf8()),
    );

    expect(JSON.parse(valueToJson(input))).toEqual([
      ["language", "English"],
      ["language", "French"],
    ]);
  });

  it("keeps a huge map key searchable without rendering it in full", () => {
    const key = `${"x".repeat(2 * 1024 * 1024)}needle`;
    const child = valueChildAt(typedValue([[key, 1]], map(utf8(), int32())), 0);

    expect(child?.label).toHaveLength(161);
    expect(child?.label).toMatch(/^x+…$/);
    expect(child?.labelSearch).toEqual({ kind: "plain", text: key });
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
      { text: "a", tone: "key" },
      { text: ": ", tone: "secondary" },
      { text: "null", tone: "null" },
      { text: "}", tone: "secondary" },
    ]);
  });

  it("derives preview tones from typed values instead of reparsing text", () => {
    const input = typedValue(
      { null: "punctuation: null", flag: true },
      struct({ null: utf8(), flag: bool() }),
    );
    const tokens = formatValuePreviewTokens(input);

    expect(tokens.map(({ text }) => text).join("")).toBe(
      '{null: "punctuation: null", flag: true}',
    );
    expect(tokens).toContainEqual({ text: "null", tone: "key" });
    expect(tokens).toContainEqual({
      text: '"punctuation: null"',
      tone: "string",
    });
    expect(tokens).toContainEqual({ text: "true", tone: "boolean" });
    expect(tokens.filter(({ tone }) => tone === "null")).toHaveLength(0);
  });

  it("escapes only a bounded field-name prefix for a grid preview", () => {
    const name = `${"x".repeat(2 * 1024 * 1024)}🙂tail`;
    const stringify = vi.spyOn(JSON, "stringify");
    const tokens = formatValuePreviewTokens(
      typedValue({ [name]: "value" }, struct([field(name, utf8())])),
    );
    const text = tokens.map((token) => token.text).join("");

    expect(text.length).toBeLessThanOrEqual(120);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(stringify.mock.calls.some(([value]) => value === name)).toBe(false);
  });

  it("omits an over-budget map token without broken quotes or emoji", () => {
    const text = formatValuePreview(
      typedValue([["🙂🙂🙂", "🙂🙂🙂"]], map(utf8(), utf8())),
      12,
    );

    expect(text.length).toBeLessThanOrEqual(12);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(text.match(/"/g) ?? []).toHaveLength(
      Math.floor((text.match(/"/g) ?? []).length / 2) * 2,
    );
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

  it("provides lazy schema-ordered children", () => {
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
  });

  it("gives an empty struct field an explicit label", () => {
    const root = typedValue({ "": 1n }, struct({ "": int64() }));
    const child = valueChildAt(root, 0);

    expect(child?.label).toBe('[""]');
  });

  it("keeps a nested Arrow Time count lossless in JSON", () => {
    const raw = 27_296_123_456_789n;
    const input = typedValue(
      { starts_at: raw },
      struct({ starts_at: timeNanosecond() }),
    );

    expect(JSON.parse(valueToJson(input))).toEqual({ starts_at: Number(raw) });
  });

  it("formats binary detail in compact eight-byte rows", () => {
    const bytes = Uint8Array.from({ length: 16 }, (_value, index) => index);

    expect(formatBinaryHexRow(bytes, 1)).toBe(
      "00000008  08 09 0a 0b 0c 0d 0e 0f  ........",
    );
    expect(formatBinaryHexRow(bytes, 1)).toHaveLength(43);
  });

  it("preserves null semantics in full scalar text", () => {
    expect(fullValueText(typedValue(null, binary()))).toBe("null");
  });

  it.each([
    [IntervalUnit.YEAR_MONTH, "interval[year_month]"],
    [IntervalUnit.DAY_TIME, "interval[day_time]"],
    [IntervalUnit.MONTH_DAY_NANO, "interval[month_day_nano]"],
  ])("labels Arrow interval unit %s", (unit, expected) => {
    expect(valueTypeLabel(typedValue(null, interval(unit)))).toBe(expected);
  });
});
