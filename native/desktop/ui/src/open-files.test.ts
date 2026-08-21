import { describe, expect, it } from "vitest";

import type { OpenedSourceEntry, SourceSummary } from "./desktop";
import {
  activeOpenFile,
  distinguishingTail,
  mergeOpenFiles,
  type OpenFile,
} from "./open-files";

function summary(generation: number, displayName: string): SourceSummary {
  return {
    generation,
    displayName,
    sizeBytes: 1_024,
    rowCount: 10,
    rowGroupCount: 1,
    columnCount: 0,
    schema: [],
    schemaNodeCount: 0,
    schemaIsTruncated: false,
    stringsTruncated: false,
  };
}

function entry(
  generation: number,
  path: string,
  active = false,
): OpenedSourceEntry {
  const name = path.split("/").at(-1) ?? path;
  return {
    generation,
    name,
    directory: "~/data",
    path,
    active,
  };
}

function file(generation: number, path: string, active = false): OpenFile {
  const listed = entry(generation, path, active);
  return {
    ...listed,
    summary: summary(generation, listed.name),
    mode: "data",
    busy: false,
    dataTargetRow: null,
  };
}

describe("open files", () => {
  it("keeps the view mode of a file across native listings", () => {
    const first = {
      ...file(1, "/data/first.parquet"),
      mode: "structure" as const,
      dataTargetRow: { row: 42, request: 3 },
    };
    const summaries = new Map([
      [1, first.summary],
      [2, summary(2, "second.parquet")],
    ]);

    const merged = mergeOpenFiles(
      [entry(2, "/data/second.parquet", true), entry(1, "/data/first.parquet")],
      summaries,
      [first],
    );

    expect(merged.map((open) => [open.generation, open.mode])).toEqual([
      [2, "data"],
      [1, "structure"],
    ]);
    expect(activeOpenFile(merged)?.generation).toBe(2);
    expect(merged.find((open) => open.generation === 1)?.dataTargetRow).toEqual(
      { row: 42, request: 3 },
    );
  });

  it("keeps state identity when a native listing changes nothing", () => {
    const previous = [file(1, "/data/first.parquet", true)];
    const merged = mergeOpenFiles(
      [entry(1, "/data/first.parquet", true)],
      new Map([[1, previous[0]!.summary]]),
      previous,
    );

    expect(merged).toBe(previous);
  });

  it("leaves out a file whose summary never reached the window", () => {
    const merged = mergeOpenFiles(
      [
        entry(1, "/data/first.parquet", true),
        entry(9, "/data/restored.parquet"),
      ],
      new Map([[1, summary(1, "first.parquet")]]),
      [],
    );

    expect(merged.map((open) => open.generation)).toEqual([1]);
  });

  it("names the shortest tail that tells equally named files apart", () => {
    const files = [
      file(1, "/data/2026/07/part-0.parquet", true),
      file(2, "/data/2026/08/part-0.parquet"),
      file(3, "/data/2026/07/trips.parquet"),
    ];

    expect(distinguishingTail(files[0]!, files)).toBe("07");
    expect(distinguishingTail(files[2]!, files)).toBeNull();
  });

  it("grows the tail until it is unambiguous", () => {
    const files = [
      file(1, "/east/2026/07/part-0.parquet", true),
      file(2, "/west/2026/07/part-0.parquet"),
    ];

    expect(distinguishingTail(files[0]!, files)).toBe("east/2026/07");
  });

  it("falls back to the shortened directory when no tail is unique", () => {
    const files = [
      file(1, "/data/part-0.parquet", true),
      file(2, "/archive/data/part-0.parquet"),
    ];

    expect(distinguishingTail(files[0]!, files)).toBe("~/data");
  });
});
