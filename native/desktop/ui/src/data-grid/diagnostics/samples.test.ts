import { describe, expect, it } from "vitest";

import { NumericSamples, percentile } from "./samples";

describe("numeric diagnostic samples", () => {
  it("reports an empty distribution without nullable values", () => {
    const samples = new NumericSamples();

    expect(samples.report()).toEqual({
      count: 0,
      sampleCount: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
    });
  });

  it("uses the nearest-rank percentile", () => {
    const sorted = [10, 20, 30, 40];

    expect(percentile(sorted, 0.5)).toBe(20);
    expect(percentile(sorted, 0.95)).toBe(40);
    expect(percentile(sorted, 0.99)).toBe(40);
  });

  it("retains the latest 2,048 values while preserving session totals", () => {
    const samples = new NumericSamples();
    samples.add(10_000);
    for (let value = 1; value <= 2_048; value += 1) samples.add(value);

    expect(samples.percentile(0)).toBe(1);
    expect(samples.report()).toEqual({
      count: 2_049,
      sampleCount: 2_048,
      p50: 1_024,
      p95: 1_946,
      p99: 2_028,
      max: 10_000,
    });
  });

  it("clears both the retained window and session totals", () => {
    const samples = new NumericSamples();
    samples.add(10_000);
    samples.add(20);

    samples.clear();
    samples.add(7);

    expect(samples.report()).toEqual({
      count: 1,
      sampleCount: 1,
      p50: 7,
      p95: 7,
      p99: 7,
      max: 7,
    });
  });
});
