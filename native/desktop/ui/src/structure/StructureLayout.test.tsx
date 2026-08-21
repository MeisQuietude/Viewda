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

function colorChannels(color: string): [number, number, number] {
  const hex = color.match(/^#([0-9a-f]{6})$/i)?.[1];
  if (hex !== undefined) {
    return [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    ) as [number, number, number];
  }
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (channels?.length !== 3) {
    throw new Error(`Unsupported color: ${color}`);
  }
  return channels as [number, number, number];
}

function relativeLuminance(color: string): number {
  const channelLuminance = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const [red, green, blue] = colorChannels(color);
  return (
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue)
  );
}

function contrastRatio(left: string, right: string): number {
  const light = Math.max(relativeLuminance(left), relativeLuminance(right));
  const dark = Math.min(relativeLuminance(left), relativeLuminance(right));
  return (light + 0.05) / (dark + 0.05);
}

function expectAccessiblePalette(legend: HTMLElement, count: number) {
  const colors = Array.from(
    legend.querySelectorAll<HTMLElement>("i:not(.is-dot)"),
    (swatch) => swatch.style.backgroundColor,
  );
  expect(new Set(colors).size).toBe(count);
  for (const color of colors) {
    expect(contrastRatio(color, "#141617")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(color, "#ffffff")).toBeGreaterThanOrEqual(4.5);
  }
}

it("keeps layout payloads bounded and pages the minimap from the keyboard", async () => {
  vi.spyOn(desktop, "getStructureChunk").mockResolvedValue({
    columnIndex: 3,
    columnName: "payload",
    physicalType: "BYTE_ARRAY",
    codec: "zstd",
    encodings: ["PLAIN"],
    valueCount: 10,
    compressedBytes: 100,
    uncompressedBytes: 150,
    compressionRatio: 1.5,
    dataPageOffset: 4,
    dictionaryPageOffset: null,
    bloomFilterBytes: 8,
    hasBloomFilter: true,
    columnHasBloomFilter: true,
    hasPageIndex: false,
    hasOffsetIndex: false,
    statistics: null,
  });
  vi.spyOn(desktop, "getStructureLensTotals").mockResolvedValue({
    codecs: [
      "zstd",
      "snappy",
      "gzip",
      "brotli",
      "lz4",
      "lz4_raw",
      "lzo",
      "uncompressed",
    ].map((codec) => ({
      codec,
      total: { chunkCount: 1, compressedBytes: 100, uncompressedBytes: 150 },
    })),
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
        columns: [
          { columnIndex: 3, columnName: "payload" },
          { columnIndex: 4, columnName: "tiny" },
        ],
        remainingColumnCount: 2,
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
            focusedCompressedBytes: focused === null ? 0 : 100,
            focusedUncompressedBytes: focused === null ? 0 : 150,
          },
        ],
        rows: [
          {
            index: offset,
            compressedBytes: 100,
            uncompressedBytes: 150,
            isReadable: true,
            hasLayoutFacts: true,
            segments: [
              {
                columnIndex: 3,
                columnName: "payload",
                compressedBytes: 100,
                uncompressedBytes: 150,
                compressionRatio: 1.5,
                share: 100 / 106,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: true,
                hasBloomFilter: true,
                hasPageIndex: true,
              },
              {
                columnIndex: 4,
                columnName: "tiny",
                compressedBytes: 1,
                uncompressedBytes: 1,
                compressionRatio: 1,
                share: 1 / 106,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: false,
                hasBloomFilter: false,
                hasPageIndex: false,
              },
            ],
            tail: {
              columnCount: 2,
              compressedBytes: 5,
              uncompressedBytes: 7,
              share: 5 / 106,
              hasBloomFilter: false,
            },
          },
          {
            index: offset + 1,
            compressedBytes: 100,
            uncompressedBytes: 170,
            isReadable: true,
            hasLayoutFacts: true,
            segments: [
              {
                columnIndex: 3,
                columnName: "payload",
                compressedBytes: 2,
                uncompressedBytes: 4,
                compressionRatio: 2,
                share: 0.02,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: true,
                hasBloomFilter: false,
                hasPageIndex: true,
              },
              {
                columnIndex: 4,
                columnName: "tiny",
                compressedBytes: 90,
                uncompressedBytes: 150,
                compressionRatio: 5 / 3,
                share: 0.9,
                codec: "zstd",
                encodings: ["PLAIN"],
                hasStatistics: false,
                hasBloomFilter: false,
                hasPageIndex: false,
              },
            ],
            tail: {
              columnCount: 2,
              compressedBytes: 8,
              uncompressedBytes: 16,
              share: 0.08,
              hasBloomFilter: true,
            },
          },
        ],
      }),
    );
  const onHighlightColumn = vi.fn();

  render(
    <StructureLayoutView
      generation={7}
      unit="compressed"
      onUnit={() => {}}
      rowGroupCount={100_000}
      highlightedColumn={4}
      onHighlightColumn={onHighlightColumn}
      selectedRow={null}
      onSelectRow={() => {}}
      onOpenRow={() => {}}
    />,
  );

  await waitFor(() =>
    expect(layout).toHaveBeenCalledWith(7, "compressed", 0, 80, 12, 4),
  );
  expect(
    await screen.findByRole("button", { name: /payload, on disk 100 B/ }),
  ).toHaveStyle({
    background: "#6d7573",
  });
  const guide = screen.getByLabelText("Layout scale and legend");
  expect(guide).toHaveTextContent(
    "Equal cells keep each column at the same position in every row group.",
  );
  expect(
    guide.compareDocumentPosition(
      screen.getByRole("scrollbar", { name: "Row group minimap" }),
    ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
  expect(screen.getByLabelText("Active lens legend")).toHaveTextContent(
    "≤ ×2 · 100 B",
  );
  expectAccessiblePalette(screen.getByLabelText("Active lens legend"), 6);
  const tracks = document.querySelectorAll<HTMLElement>(".layout-row-track");
  expect(tracks).toHaveLength(2);
  expect(tracks[0]?.style.gridTemplateColumns).toBe(
    "repeat(3, minmax(0, 1fr))",
  );
  expect(tracks[1]?.style.gridTemplateColumns).toBe(
    tracks[0]?.style.gridTemplateColumns,
  );
  expect(
    Array.from(tracks[0]?.querySelectorAll("button") ?? [], (cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(["payload", "tiny"]);
  expect(
    Array.from(tracks[1]?.querySelectorAll("button") ?? [], (cell) =>
      cell.textContent?.trim(),
    ),
  ).toEqual(["payload", "tiny"]);
  expect(screen.getAllByText("Remaining 2 columns")).toHaveLength(3);
  expect(screen.getByTitle(/On disk: 5 B · 4.7% of row group/)).toBeVisible();
  const remaining = screen.getByLabelText(
    /Remaining 2 columns On disk: 5 B · 4.7% of row group/,
  );
  expect(remaining).not.toHaveAttribute("role");
  expect(remaining).toHaveAttribute("tabindex", "0");
  remaining.focus();
  expect(remaining).toHaveFocus();
  expect(
    screen.getByLabelText("2 columns outside the named slots"),
  ).toHaveAttribute("tabindex", "0");

  const minimap = screen.getByRole("scrollbar", {
    name: "Row group minimap",
  });
  minimap.focus();
  expect(minimap).toHaveFocus();
  expect(minimap).toHaveAttribute("aria-orientation", "horizontal");
  expect(minimap).toHaveAttribute("aria-valuemax", "99998");
  expect(screen.getByRole("status")).toHaveTextContent("Selected column: tiny");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(onHighlightColumn).toHaveBeenCalledWith(null);
  const callsBeforeHover = layout.mock.calls.length;
  const ratioCell = screen.getByRole("button", {
    name: /payload, on disk 100 B, Compression ×1.5, Bloom filter present/,
  });
  fireEvent.mouseEnter(ratioCell);
  expect(layout).toHaveBeenCalledTimes(callsBeforeHover);
  expect(
    document.querySelectorAll(".layout-segment.is-highlighted"),
  ).toHaveLength(2);
  expect(minimap.querySelector("span")).toHaveStyle({
    outline: "2px solid var(--layout-outline)",
  });
  expect(ratioCell).toHaveAccessibleName(/Bloom filter present/);
  ratioCell.focus();
  fireEvent.click(ratioCell);
  expect(
    await screen.findByRole("complementary", {
      name: "Column chunk details",
    }),
  ).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Close chunk details" }));
  expect(ratioCell).toHaveFocus();

  fireEvent.click(screen.getByRole("button", { name: "Codec" }));
  expect(guide).not.toHaveTextContent("Color shows");
  expect(screen.getByLabelText("Active lens legend")).toHaveTextContent(
    "zstd · 100 B",
  );
  expectAccessiblePalette(screen.getByLabelText("Active lens legend"), 8);
  const codecCell = screen.getByRole("button", {
    name: /payload, on disk 100 B, Codec zstd, Bloom filter present/,
  });
  expect(codecCell).toHaveStyle({ background: "#537b91" });

  fireEvent.click(screen.getByRole("button", { name: "Statistics" }));
  expect(guide).not.toHaveTextContent("Color shows");
  expect(screen.getByLabelText("Active lens legend")).toHaveTextContent(
    "Statistics present · 100 B",
  );
  const statisticsCell = screen.getByRole("button", {
    name: /payload, on disk 100 B, Statistics present, Bloom filter present/,
  });
  expect(statisticsCell).toHaveStyle({ background: "#526b5a" });

  const axis = screen.getByLabelText("Column axis");
  fireEvent.click(
    Array.from(axis.querySelectorAll("button")).find(
      (button) => button.textContent === "payload",
    )!,
  );
  expect(onHighlightColumn).toHaveBeenCalledWith(3);

  fireEvent.keyDown(minimap, { key: "PageDown" });
  await waitFor(() =>
    expect(layout).toHaveBeenLastCalledWith(7, "compressed", 2, 80, 12, 4),
  );
});

it("renders corrupt layout facts as unavailable instead of zero bytes", async () => {
  vi.spyOn(desktop, "getStructureLensTotals").mockResolvedValue({
    codecs: [],
    ratioSteps: [],
    unrated: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    statistics: {
      present: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      absent: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    },
    bloomFilters: {
      present: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
      absent: { chunkCount: 0, compressedBytes: 0, uncompressedBytes: 0 },
    },
  });
  vi.spyOn(desktop, "getStructureLayout").mockResolvedValue({
    columns: [{ columnIndex: 0, columnName: "id" }],
    remainingColumnCount: 0,
    overview: [],
    rows: [
      {
        index: 0,
        compressedBytes: 0,
        uncompressedBytes: 0,
        isReadable: false,
        hasLayoutFacts: false,
        segments: [],
        tail: null,
      },
    ],
  });

  render(
    <StructureLayoutView
      generation={7}
      unit="compressed"
      onUnit={() => {}}
      rowGroupCount={1}
      highlightedColumn={null}
      onHighlightColumn={() => {}}
      selectedRow={null}
      onSelectRow={() => {}}
      onOpenRow={() => {}}
    />,
  );

  expect(await screen.findByText("Footer facts unavailable")).toBeVisible();
  expect(document.querySelector(".layout-row-bytes")).toHaveTextContent("—");
  expect(screen.queryByText("0 B")).not.toBeInTheDocument();
});
