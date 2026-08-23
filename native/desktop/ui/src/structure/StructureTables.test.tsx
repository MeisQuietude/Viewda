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
import { ColumnsSection, RowGroupTable } from "./StructureTables";
import { STRUCTURE_PAGE_LIMIT } from "./table-page";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The grid renders nothing at jsdom's zero geometry, so tests state a size. */
const measurementPort: GridMeasurementPort = {
  read: (scrollport) => ({
    // At a 1,200px window the visible grid body is 1,123px after its scrollbar.
    width: 1_123,
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
    hasLayoutFacts: true,
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
    cumulativeShare: 0.4,
    ...overrides,
  };
}

function cellTexts(label: string): string[] {
  return within(screen.getByLabelText(label))
    .getAllByRole("gridcell")
    .map((cell) => cell.textContent ?? "");
}

function renderedTableWidth(label: string): number {
  return within(screen.getByLabelText(label))
    .getAllByRole("columnheader")
    .reduce(
      (total, header) => total + Number.parseFloat(header.style.width),
      0,
    );
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
    expect(renderedTableWidth("Row groups")).toBe(1_100);
  });

  it("fits the six-digit row gutter in a normal desktop canvas", async () => {
    vi.spyOn(desktop, "getStructureRowGroups").mockImplementation(
      () => new Promise(() => undefined),
    );

    render(
      <RowGroupTable
        generation={3}
        unit="compressed"
        rowGroupCount={100_000}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("columnheader", { name: "Row numbers" }),
      ).toHaveStyle({ width: "71px" }),
    );
    expect(renderedTableWidth("Row groups")).toBe(1_123);
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
        "Before compression bytes",
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

  it("returns to file order and highlights a row selected in the layout", async () => {
    const targetRow = 1_000;
    const fetchPage = vi
      .spyOn(desktop, "getStructureRowGroups")
      .mockImplementation(
        async (_generation, _unit, _sort, _direction, offset, limit) => ({
          offset,
          totalCount: 2_000,
          rowGroups: Array.from(
            { length: Math.min(limit, 2_000 - offset) },
            (_, index) => rowGroup(offset + index),
          ),
        }),
      );
    const view = render(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={2_000}
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

    view.rerender(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={2_000}
        requestedRow={{ row: targetRow, request: 1 }}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(
        fetchPage.mock.calls.some(
          ([, , sort, direction, offset, limit]) =>
            sort === "index" &&
            direction === "ascending" &&
            offset <= targetRow &&
            offset + limit > targetRow,
        ),
      ).toBe(true),
    );
    expect(screen.getByRole("rowheader", { name: "1001" })).toHaveAttribute(
      "aria-selected",
      "true",
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
          hasLayoutFacts: false,
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

  it("keeps footer-recorded facts visible when only data pages are unavailable", async () => {
    vi.spyOn(desktop, "getStructureRowGroups").mockResolvedValue({
      offset: 0,
      totalCount: 1,
      rowGroups: [rowGroup(0, { isReadable: false, hasLayoutFacts: true })],
    });

    render(
      <RowGroupTable
        generation={1}
        unit="compressed"
        rowGroupCount={1}
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
      ]),
    );
    const cells = within(screen.getByLabelText("Row groups")).getAllByRole(
      "gridcell",
    );
    expect(cells.every((cell) => cell.classList.contains("is-faded"))).toBe(
      true,
    );
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

describe("ColumnsSection", () => {
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
      <ColumnsSection
        generation={2}
        unit="compressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(resolveCompressed).toBeDefined());
    rerender(
      <ColumnsSection
        generation={2}
        unit="uncompressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(resolveUncompressed).toBeDefined());
    expect(
      screen.getByText(
        "Compare columns by before compression bytes. Cumulative is the share accounted for by this column and all larger columns.",
      ),
    ).toBeInTheDocument();

    await act(async () => {
      resolveUncompressed?.({
        offset: 0,
        totalCount: 1,
        columns: [column(0, { name: "new-unit" })],
      });
    });
    expect(await screen.findByText("new-unit")).toBeInTheDocument();
    await act(async () => {
      resolveCompressed?.({
        offset: 0,
        totalCount: 1,
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
        columns: [
          column(0, {
            name: "orders.customer.id",
            cumulativeShare: 0.4,
          }),
          column(1, {
            compressedBytes: 100_000,
            logicalType: null,
            encodings: [],
            cumulativeShare: 0.5,
          }),
        ],
      });

    render(
      <ColumnsSection
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
        "orders.customer.id",
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
    expect(renderedTableWidth("Columns")).toBe(1_100);
  });

  it("keeps column identity and type but hides incomplete aggregates", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureColumns")
      .mockResolvedValue({
        offset: 0,
        totalCount: 1,
        columns: [column(0, { name: "orders.customer.id" })],
      });

    render(
      <ColumnsSection
        generation={2}
        unit="compressed"
        columnCount={1}
        chunkAggregatesComplete={false}
        measurementPort={measurementPort}
      />,
    );

    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        2,
        "compressed",
        "name",
        "ascending",
        0,
        STRUCTURE_PAGE_LIMIT,
      ),
    );
    expect(
      screen.getByText(
        "Chunk aggregates are unavailable because some footer metadata cannot be read.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(cellTexts("Columns")).toEqual([
        "orders.customer.id",
        "BYTE_ARRAY · String",
        "—",
        "—",
        "—",
        "—",
      ]),
    );
    expect(
      screen.getByRole("button", { name: "Column sorted ascending" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort Bytes" })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Bytes" }),
    ).not.toHaveAttribute("aria-sort");
    expect(screen.queryByRole("button", { name: "Filter Column" })).toBeNull();
  });

  it("distinguishes bounded physical paths with stable column numbers", async () => {
    vi.spyOn(desktop, "getStructureColumns").mockResolvedValue({
      offset: 0,
      totalCount: 2,
      columns: [
        column(0, { name: "nested.repeated.path…" }),
        column(1, { name: "nested.repeated.path…" }),
      ],
    });

    render(
      <ColumnsSection
        generation={2}
        unit="compressed"
        columnCount={2}
        columnPathsTruncated
        measurementPort={measurementPort}
      />,
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Some physical column paths are shortened. Stable column numbers distinguish the original leaves.",
    );
    await waitFor(() =>
      expect(cellTexts("Columns")).toEqual(
        expect.arrayContaining([
          "#1 · nested.repeated.path…",
          "#2 · nested.repeated.path…",
        ]),
      ),
    );
  });

  it("keeps the engine's cumulative share when the view is sorted by name", async () => {
    const fetchPage = vi
      .spyOn(desktop, "getStructureColumns")
      .mockResolvedValue({
        offset: 0,
        totalCount: 1,
        columns: [column(0, { name: "zebra", cumulativeShare: 0.93 })],
      });

    render(
      <ColumnsSection
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

  it("passes a one-row grid's tiny scroll remainder to the Structure page", async () => {
    vi.spyOn(desktop, "getStructureColumns").mockResolvedValue({
      offset: 0,
      totalCount: 1,
      columns: [column(0)],
    });
    const tinyGridMeasurement: GridMeasurementPort = {
      ...measurementPort,
      read: (scrollport) => ({
        ...measurementPort.read(scrollport),
        height: 26,
      }),
    };
    const { container } = render(
      <div data-testid="structure-scroll-owner">
        <ColumnsSection
          generation={1}
          unit="compressed"
          columnCount={1}
          measurementPort={tinyGridMeasurement}
        />
      </div>,
    );
    await waitFor(() => expect(screen.getByLabelText("Columns")).toBeVisible());
    const outer = screen.getByTestId("structure-scroll-owner");
    outer.style.overflowY = "auto";
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    outer.scrollTop = 338;
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const first = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 300,
    });

    act(() => scrollport.dispatchEvent(first));

    expect(first.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(2);
    expect(outer.scrollTop).toBe(636);

    const second = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 300,
    });
    act(() => scrollport.dispatchEvent(second));

    expect(second.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(2);
    expect(outer.scrollTop).toBe(936);
  });

  it("offers no ordering for facts the engine does not rank", async () => {
    vi.spyOn(desktop, "getStructureColumns").mockResolvedValue({
      offset: 0,
      totalCount: 1,
      columns: [column(0)],
    });

    render(
      <ColumnsSection
        generation={1}
        unit="compressed"
        columnCount={1}
        measurementPort={measurementPort}
      />,
    );
    await waitFor(() => expect(cellTexts("Columns").length).toBeGreaterThan(0));

    expect(
      screen.getByRole("button", { name: "Sort Column" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Bytes sorted descending" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sort Type" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sort Encodings" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Sort Cumulative" }),
    ).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Encodings" }),
    ).not.toHaveAttribute("aria-sort");
    expect(screen.queryByRole("button", { name: /Filter / })).toBeNull();
  });
});
