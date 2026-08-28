import {
  binary,
  decimal128,
  field,
  float64,
  int64,
  list,
  map,
  struct,
  timestamp,
  TimeUnit,
  utf8,
} from "@uwdata/flechette";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createValueJsonSerializer } from "./value-json-serializer";
import { invalidJsonValue, typedValue } from "./value-format";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stepUnits(
  serializer: ReturnType<typeof createValueJsonSerializer>,
  units: number,
) {
  let elapsed = 0;
  return serializer.stepUntil(units, () => {
    elapsed += 1;
    return elapsed;
  });
}

describe("incremental value JSON serialization", () => {
  it("matches copy conventions while preserving duplicate map keys", () => {
    const serializer = createValueJsonSerializer(
      typedValue(
        {
          safe: 5n,
          unsafe: 9_007_199_254_740_993n,
          scale_zero: 37n,
          trailing_zero: 120n,
          unsafe_decimal: 9_007_199_254_740_993n,
          small_decimal: 1n,
          nonFinite: Number.NaN,
          positive_infinity: Number.POSITIVE_INFINITY,
          negative_infinity: Number.NEGATIVE_INFINITY,
          timestamp: 9_007_199_254_740_993n,
          binary: new Uint8Array([1, 2, 3]),
          labels: [
            ["language", "English"],
            ["language", "French"],
          ],
        },
        struct({
          safe: int64(),
          unsafe: int64(),
          scale_zero: decimal128(10, 0),
          trailing_zero: decimal128(10, 2),
          unsafe_decimal: decimal128(38, 0),
          small_decimal: decimal128(38, 20),
          nonFinite: float64(),
          positive_infinity: float64(),
          negative_infinity: float64(),
          timestamp: timestamp(TimeUnit.NANOSECOND),
          binary: binary(),
          labels: map(utf8(), utf8()),
        }),
      ),
    );

    let result = stepUnits(serializer, 1);
    while (result.status === "pending") result = stepUnits(serializer, 1);
    expect(result.status).toBe("done");
    if (result.status !== "done") {
      throw new Error("Expected serialization to complete");
    }

    expect(JSON.parse(result.text)).toEqual({
      safe: 5,
      unsafe: "9007199254740993",
      scale_zero: "37",
      trailing_zero: "1.20",
      unsafe_decimal: "9007199254740993",
      small_decimal: "0.00000000000000000001",
      nonFinite: "NaN",
      positive_infinity: "Infinity",
      negative_infinity: "-Infinity",
      timestamp: "9007199254740993",
      binary: "AQID",
      labels: [
        ["language", "English"],
        ["language", "French"],
      ],
    });
  });

  it("yields while escaping a multi-megabyte scalar", () => {
    const serializer = createValueJsonSerializer(
      typedValue(`prefix${"x".repeat(2 * 1024 * 1024)}\nend`, utf8()),
    );

    expect(stepUnits(serializer, 8)).toEqual({ status: "pending" });
    let steps = 1;
    let result = stepUnits(serializer, 1);
    while (result.status === "pending") {
      steps += 1;
      result = stepUnits(serializer, 1);
    }
    expect(result.status).toBe("done");
    if (result.status !== "done") {
      throw new Error("Expected serialization to complete");
    }

    expect(steps).toBeGreaterThan(100);
    expect(JSON.parse(result.text)).toBe(
      `prefix${"x".repeat(2 * 1024 * 1024)}\nend`,
    );
  });

  it("copies malformed logical JSON as a valid JSON string", () => {
    const serializer = createValueJsonSerializer(
      invalidJsonValue('{"oops":]', utf8(), 8),
    );
    let result = stepUnits(serializer, 1);
    while (result.status === "pending") result = stepUnits(serializer, 1);
    expect(result.status).toBe("done");
    if (result.status !== "done") {
      throw new Error("Expected serialization to complete");
    }

    expect(JSON.parse(result.text)).toBe('{"oops":]');
  });

  it("accepts the exact character boundary and stops before joining overflow", () => {
    const accepted = createValueJsonSerializer(
      typedValue("12345678", utf8()),
      10,
    );
    let acceptedResult = stepUnits(accepted, 1);
    while (acceptedResult.status === "pending") {
      acceptedResult = stepUnits(accepted, 1);
    }
    expect(acceptedResult).toEqual({ status: "done", text: '"12345678"' });

    const rejected = createValueJsonSerializer(
      typedValue("123456789", utf8()),
      10,
    );
    expect(stepUnits(rejected, 1)).toEqual({ status: "pending" });
    let rejectedResult = stepUnits(rejected, 1);
    while (rejectedResult.status === "pending") {
      rejectedResult = stepUnits(rejected, 1);
    }
    expect(rejectedResult.status).toBe("limit");
    if (rejectedResult.status === "limit") {
      expect(rejectedResult.error.message).toContain("10-character copy limit");
    }
  });

  it("escapes a multi-megabyte object key in capped scheduler chunks", () => {
    const key = '"\\\n'.repeat(700_000);
    const serializer = createValueJsonSerializer(
      typedValue({ [key]: "value" }, struct([field(key, utf8())])),
    );
    const stringify = vi.spyOn(JSON, "stringify");
    let steps = 0;
    let result = serializer.stepUntil(Infinity, () => 0, 1);
    while (result.status === "pending") {
      const previousUnits = serializer.units;
      result = serializer.stepUntil(Infinity, () => 0, 1);
      expect(serializer.units - previousUnits).toBeLessThanOrEqual(1);
      steps += 1;
    }

    expect(result.status).toBe("done");
    if (result.status !== "done") throw new Error("Expected complete copy");
    expect(Object.keys(JSON.parse(result.text) as object)).toEqual([key]);
    expect(steps).toBeGreaterThan(100);
    expect(
      Math.max(
        ...stringify.mock.calls.map(([value]) =>
          typeof value === "string" ? value.length : 0,
        ),
      ),
    ).toBeLessThanOrEqual(16_384);

    stringify.mockClear();
    const capped = createValueJsonSerializer(
      typedValue({ [key]: "value" }, struct([field(key, utf8())])),
      128,
    );
    let cappedResult = capped.stepUntil(Infinity, () => 0, 1);
    while (cappedResult.status === "pending") {
      cappedResult = capped.stepUntil(Infinity, () => 0, 1);
    }
    expect(cappedResult.status).toBe("limit");
    expect(
      stringify.mock.calls.every(
        ([value]) => typeof value !== "string" || value.length <= 21,
      ),
    ).toBe(true);
  });

  it("bounds work per yield for a node-dense 100k list", () => {
    const serializer = createValueJsonSerializer(
      typedValue(
        Array.from({ length: 100_000 }, (_unused, index) => BigInt(index)),
        list(int64()),
      ),
    );
    let time = 0;
    let yields = 0;
    let maxChecks = 0;
    let result: ReturnType<typeof serializer.stepUntil>;
    do {
      let checks = 0;
      const deadline = time + 8;
      result = serializer.stepUntil(deadline, () => {
        checks += 1;
        time += 0.001;
        return time;
      });
      maxChecks = Math.max(maxChecks, checks);
      yields += 1;
    } while (result.status === "pending");

    expect(result.status).toBe("done");
    expect(yields).toBeLessThan(30);
    expect(maxChecks).toBeLessThanOrEqual(8_001);
  });
});
