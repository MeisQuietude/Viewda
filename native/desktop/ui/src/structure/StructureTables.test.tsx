import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GridMeasurementPort } from "../data-grid/ViewdaGrid";
import * as desktop from "../desktop";
import type {
  StructureColumnSummary,
  StructureRowGroupSummary,
} from "../desktop";
import { ColumnTable, RowGroupTable } from "./StructureTables";
import { STRUCTURE_PAGE_LIMIT } from "./table-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The grid renders nothing at jsdom's zero geometry, so tests state a size. */
const measurementPort: GridMeasurementPort = {
  read: (scrollport) => ({
    width: 1_400,
    height: 200,
    scrollTop: scrollport.scrollTop,
    scrollLeft: scrollport.scrollLeft,
    devicePixelRatio: 1,
  }),
  observe: () => () => undefined,
  bounds: () => ({ x: 0, y: 0, width: 100, height: 28 }),
  probeScrollExtent: () => ({ vertical: 1_000_000, horizontal: 1_000_000 }),
};

function rowGroup(
  index: number,
  overrides: Partial<StructureRowGroupSummary> = {},
): StructureRowGroupSummary {
  return {
    index,
    rowCount: 1_000,
    compressedBytes: 500_000,
    uncompressedBytes: 1_500_000,
    compressionRatio: 3,
    chunkCount: 4,
    chunksWithBloomFilter: 1,
    isReadable: true,
    ...overrides,
  };
}

function column(
  index: number,
  overrides: Partial<StructureColumnSummary> = {},
): StructureColumnSummary {
  return {
    index,
    name: `column_${index}`,
    physicalType: "BYTE_ARRAY",
    logicalType: "String",
    compressedBytes: 400_000,
    uncompressedBytes: 1_200_000,
    compressionRatio: 3,
    encodings: ["PLAIN", "RLE_DICTIONARY"],
    share: 0.4,
    cumulativeShare: 0.4,
    ...overrides,
  };
}

function cellTexts(label: string): string[] {
  return within(screen.getByLabelText(label))
    .getAllByRole("gridcell")
    .map((cell) => cell.textContent ?? "");
}

describe("RowGroupTable", () => {
  it("asks for one bounded page and states each group's facts", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureRowGroups")
      .mockResolvedValue({
        offset: 0,
        totalCount: 2,
        rowGroups: [rowGroup(0), rowGroup(1, { rowCount: 240 })],
      });

    render(
      <RowGroupTable
        generation={3}
        unit="compressed"
        rowGroupCount={2}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        3,
        "compressed",
        "index",
        "ascending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
    await waitFor(() =>
      expect(cellTexts("Row groups")).toEqual([
        "0",
        "1,000",
        "500.0 kB",
        "×3.0",
        "1 of 4",
        "1",
        "240",
        "500.0 kB",
        "×3.0",
        "1 of 4",
      ]),
    );
  });

  it("follows the mode's unit for both the request and the bytes shown", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureRowGroups")
      .mockResolvedValue({
        offset: 0,
        totalCount: 1,
        rowGroups: [rowGroup(0)],
      });

    render(
      <RowGroupTable
        generation={1}
        unit="uncompressed"
        rowGroupCount={1}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        1,
        "uncompressed",
        "index",
        "ascending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
    await waitFor(() => expect(cellTexts("Row groups")).toContain("1.5 MB"));
    expect(
      within(screen.getByLabelText("Row groups").parentElement!).getByText(
        "Uncompressed bytes",
      ),
    ).toBeInTheDocument();
  });

  it("sorts through the engine and flips the direction on a repeated header", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureRowGroups")
      .mockResolvedValue({
        offset: 0,
        totalCount: 1,
        rowGroups: [rowGroup(0)],
      });

    render(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Sort Bytes" }));
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        1,
        "compressed",
        "bytes",
        "descending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Bytes sorted descending" }),
    );
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        1,
        "compressed",
        "bytes",
        "ascending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
  });

  it("marks a row group whose footer entry is inconsistent", async () => {
    vi.spyOn(desktop, "getStructureRowGroups").mockResolvedValue({
      offset: 0,
      totalCount: 2,
      rowGroups: [
        rowGroup(0),
        rowGroup(1, {
          isReadable: false,
          rowCount: 0,
          compressedBytes: 0,
          uncompressedBytes: 0,
          compressionRatio: null,
          chunksWithBloomFilter: 0,
        }),
      ],
    });

    render(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={2}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(cellTexts("Row groups")).toEqual([
        "0",
        "1,000",
        "500.0 kB",
        "×3.0",
        "1 of 4",
        "1",
        "—",
        "—",
        "—",
        "—",
      ]),
    );
    const cells = within(screen.getByLabelText("Row groups")).getAllByRole(
      "gridcell",
    );
    expect(cells[5]).toHaveClass("is-faded");
    expect(cells[0]).not.toHaveClass("is-faded");
  });

  it("reports a page the engine refused", async () => {
    vi.spyOn(desktop, "getStructureRowGroups").mockRejectedValue(
      new desktop.StructureCommandError("corruptFooter"),
    );

    render(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={1}
        measurementPort={measurementPort}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Parquet footer is damaged or incomplete.",
    );
  });
});

describe("ColumnTable", () => {
  it("ignores a stale page that resolves after the unit changes", async () => {
    let resolveCompressed:
      ((page: desktop.StructureColumnPage) => void) | undefined;
    let resolveUncompressed:
      ((page: desktop.StructureColumnPage) => void) | undefined;
    vi.spyOn(desktop, "getStructureColumns")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCompressed = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveUncompressed = resolve;
        }),
      );

    const { rerender } = render(
      <ColumnTable
        generation={2}
        unit="compressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(resolveCompressed).toBeDefined());
    rerender(
      <ColumnTable
        generation={2}
        unit="uncompressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(resolveUncompressed).toBeDefined());

    await act(async () => {
      resolveUncompressed?.({
        offset: 0,
        totalCount: 1,
        totalCompressedBytes: 1,
        totalUncompressedBytes: 2,
        columns: [column(0, { name: "new-unit" })],
      });
    });
    expect(await screen.findByText("new-unit")).toBeInTheDocument();
    await act(async () => {
      resolveCompressed?.({
        offset: 0,
        totalCount: 1,
        totalCompressedBytes: 1,
        totalUncompressedBytes: 2,
        columns: [column(0, { name: "stale-unit" })],
      });
    });

    expect(screen.getByText("new-unit")).toBeInTheDocument();
    expect(screen.queryByText("stale-unit")).not.toBeInTheDocument();
  });

  it("ranks by stored bytes and states each column's facts", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureColumns")
      .mockResolvedValue({
        offset: 0,
        totalCount: 2,
        totalCompressedBytes: 1_000_000,
        totalUncompressedBytes: 3_000_000,
        columns: [
          column(0, { cumulativeShare: 0.4 }),
          column(1, {
            compressedBytes: 100_000,
            logicalType: null,
            encodings: [],
            cumulativeShare: 0.5,
          }),
        ],
      });

    render(
      <ColumnTable
        generation={2}
        unit="compressed"
        columnCount={2}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        2,
        "compressed",
        "bytes",
        "descending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
    await waitFor(() =>
      expect(cellTexts("Columns")).toEqual([
        "column_0",
        "BYTE_ARRAY · String",
        "400.0 kB",
        "×3.0",
        "PLAIN, RLE_DICTIONARY",
        "40%",
        "column_1",
        "BYTE_ARRAY",
        "100.0 kB",
        "×3.0",
        "—",
        "50%",
      ]),
    );
  });

  it("keeps the engine's cumulative share when the view is sorted by name", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureColumns")
      .mockResolvedValue({
        offset: 0,
        totalCount: 1,
        totalCompressedBytes: 1_000_000,
        totalUncompressedBytes: 3_000_000,
        columns: [column(0, { name: "zebra", cumulativeShare: 0.93 })],
      });

    render(
      <ColumnTable
        generation={1}
        unit="compressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Sort Column" }));

    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        1,
        "compressed",
        "name",
        "ascending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
    await waitFor(() => expect(cellTexts("Columns")).toContain("93%"));
  });

  it("offers no ordering for facts the engine does not rank", async () => {
    vi.spyOn(desktop, "getStructureColumns").mockResolvedValue({
      offset: 0,
      totalCount: 1,
      totalCompressedBytes: 1_000,
      totalUncompressedBytes: 3_000,
      columns: [column(0)],
    });

    render(
      <ColumnTable
        generation={1}
        unit="compressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(cellTexts("Columns").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Sort Encodings" }));

    expect(
      screen.getByRole("columnheader", { name: "Encodings" }),
    ).toHaveAttribute("aria-sort", "none");
  });
});
