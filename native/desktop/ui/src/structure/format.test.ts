import { describe, expect, it } from "vitest";

import {
  bytesForUnit,
  formatCodecs,
  formatColumnType,
  formatCoverage,
  formatEncodings,
  formatFileSize,
  formatRatio,
  formatRowsPerRowGroup,
  formatShare,
  MISSING_FACT,
  unitLabel,
} from "./format";

describe("formatFileSize", () => {
  it.each([
    [999, "999 B"],
    [1_000, "1.0 kB"],
    [999_999, "1.0 MB"],
    [1_300_000, "1.3 MB"],
    [2_500_000_000, "2.5 GB"],
  ])("formats %i bytes as %s", (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });
});

describe("structure facts", () => {
  it("states a ratio as an expansion factor and a missing one as a dash", () => {
    expect(formatRatio(3.04)).toBe("×3.0");
    expect(formatRatio(1.05)).toBe("×1.1");
    expect(formatRatio(null)).toBe(MISSING_FACT);
  });

  it("states coverage as a plain count of chunks", () => {
    expect(formatCoverage(96, 96)).toBe("100% · 96 of 96 chunks");
    expect(formatCoverage(0, 96)).toBe("0% · 0 of 96 chunks");
    expect(formatCoverage(1_500, 12_000)).toBe("13% · 1,500 of 12,000 chunks");
    expect(formatCoverage(1_305, 1_363)).toBe("96% · 1,305 of 1,363 chunks");
    expect(formatCoverage(608, 1_363)).toBe("45% · 608 of 1,363 chunks");
    expect(formatCoverage(1, 1)).toBe("100% · 1 of 1 chunk");
    expect(formatCoverage(0, 0)).toBe("— · 0 of 0 chunks");
  });

  it("names one codec plainly and joins a mixed file's codecs", () => {
    expect(formatCodecs(["zstd"])).toBe("zstd");
    expect(formatCodecs(["snappy", "zstd"])).toBe("snappy + zstd");
    expect(formatCodecs([])).toBe(MISSING_FACT);
  });

  it("rounds the derived rows per row group", () => {
    expect(formatRowsPerRowGroup(1_048_576)).toBe("≈ 1,048,576");
    expect(formatRowsPerRowGroup(12.4)).toBe("≈ 12");
    expect(formatRowsPerRowGroup(null)).toBe(MISSING_FACT);
  });

  it("renders shares, encodings and column types", () => {
    expect(formatShare(0.5)).toBe("50%");
    expect(formatShare(0.8125)).toBe("81.3%");
    expect(formatEncodings(["PLAIN", "RLE"])).toBe("PLAIN, RLE");
    expect(formatEncodings([])).toBe(MISSING_FACT);
    expect(formatColumnType("INT32", "Date")).toBe("INT32 · Date");
    expect(formatColumnType("INT64", null)).toBe("INT64");
  });

  it("follows the active unit when reading a row's bytes", () => {
    const row = { compressedBytes: 100, uncompressedBytes: 400 };

    expect(bytesForUnit(row, "compressed")).toBe(100);
    expect(bytesForUnit(row, "uncompressed")).toBe(400);
    expect(unitLabel("compressed")).toBe("On disk");
    expect(unitLabel("uncompressed")).toBe("Before compression");
  });
});
