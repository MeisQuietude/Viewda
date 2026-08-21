import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { StructureLayoutView } from "./StructureLayout";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("keeps layout payloads bounded and pages the minimap from the keyboard", async () => {
  vi.spyOn(desktop, "getStructureLensTotals").mockResolvedValue({
    codecs: [
      {
        codec: "zstd",
        total: { chunkCount: 1, compressedBytes: 100, uncompressedBytes: 150 },
      },
    ],
    ratioSteps: [
      {
        maxRatio: 1.1,
        total: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      },
      {
        maxRatio: 2,
        total: { chunkCount: 1, compressedBytes: 100, uncompressedBytes: 150 },
      },
      {
        maxRatio: 4,
        total: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      },
      {
        maxRatio: 10,
        total: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      },
      {
        maxRatio: null,
        total: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      },
    ],
    unrated: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    statistics: {
      present: { chunkCount: 1, compressedBytes: 100, uncompressedBytes: 150 },
      absent: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    },
    bloomFilters: {
      present: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      absent: { chunkCount: 1, compressedBytes: 100, uncompressedBytes: 150 },
    },
  });
  const layout = vi
    .spyOn(desktop, "getStructureLayout")
    .mockImplementation(
      async (_generation, _unit, offset, _limit, _segments, focused) => ({
        offset,
        totalCount: 100_000,
        maxCompressedBytes: 1_000,
        maxUncompressedBytes: 2_000,
        overview: [
          {
            rowStart: 0,
            rowEnd: 391,
            compressedBytes: 100,
            uncompressedBytes: 150,
            dominantRatioStepCompressed: 1,
            dominantRatioStepUncompressed: 1,
            dominantCodecCompressed: "zstd",
            dominantCodecUncompressed: "zstd",
            statisticsShareCompressed: 1,
            statisticsShareUncompressed: 1,
            hasBloomFilter: false,
            hasLayoutFacts: true,
            focusedCompressedBytes: focused === 3 ? 100 : 0,
            focusedUncompressedBytes: focused === 3 ? 150 : 0,
          },
        ],
        rows: [
          {
            index: offset,
            compressedBytes: 100,
            uncompressedBytes: 150,
            isReadable: true,
            segments: [
              {
                columnIndex: 3,
                columnName: "payload",
                compressedBytes: 100,
                uncompressedBytes: 150,
                compressionRatio: 1.5,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: true,
                hasBloomFilter: false,
                hasPageIndex: true,
              },
              {
                columnIndex: 4,
                columnName: "tiny",
                compressedBytes: 1,
                uncompressedBytes: 1,
                compressionRatio: 1,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: false,
                hasBloomFilter: false,
                hasPageIndex: false,
              },
            ],
            tail: {
              segmentCount: 2,
              compressedBytes: 5,
              uncompressedBytes: 7,
            },
          },
        ],
      }),
    );

  render(
    <StructureLayoutView
      generation={7}
      unit="compressed"
      rowGroupCount={100_000}
      highlightedColumn={4}
      onHighlightColumn={() => {}}
      selectedRow={null}
      onSelectRow={() => {}}
      onOpenRow={() => {}}
    />,
  );

  await waitFor(() =>
    expect(layout).toHaveBeenCalledWith(7, "compressed", 0, 80, 24, 4),
  );
  expect(
    await screen.findByRole("button", { name: /payload, 100 B/ }),
  ).toHaveStyle({
    background: "#c98b58",
  });
  expect(screen.getByLabelText("Active lens legend")).toHaveTextContent(
    "≤ ×2 · 100 B",
  );
  expect(screen.getByRole("button", { name: /tiny, 1 B/ })).toHaveStyle({
    minWidth: "4px",
  });
  expect(screen.getByTitle("2 collapsed columns")).toHaveTextContent(
    "+ 2 more · 5 B",
  );

  const minimap = screen.getByRole("scrollbar", {
    name: "Row group minimap",
  });
  expect(minimap).toHaveAttribute("aria-valuemax", "99999");
  fireEvent.mouseEnter(screen.getByRole("button", { name: /payload, 100 B/ }));
  await waitFor(() =>
    expect(layout).toHaveBeenLastCalledWith(7, "compressed", 0, 80, 24, 3),
  );
  await waitFor(() =>
    expect(minimap.querySelector("span")).toHaveStyle({
      outline: "2px solid var(--layout-outline)",
    }),
  );

  fireEvent.keyDown(minimap, { key: "PageDown" });
  await waitFor(() =>
    expect(layout).toHaveBeenLastCalledWith(7, "compressed", 1, 80, 24, 3),
  );
});
