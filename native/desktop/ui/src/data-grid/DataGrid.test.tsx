import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { int32, TimeUnit, timestamp, utf8 } from "@uwdata/flechette";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { DataGrid } from "./DataGrid";
import type { ArrowDataWindow } from "./arrow-window";
import { CompactSelection, type GridSelection } from "./grid-model";
import type {
  GridViewport,
  ViewdaGridHandle,
  ViewdaGridProps,
} from "./ViewdaGrid";

const gridMock = vi.hoisted(() => ({
  props: undefined as ViewdaGridProps | undefined,
  mountCount: 0,
  focus: vi.fn(),
  scrollToRow: vi.fn(),
  scrollToColumn: vi.fn(),
  revisionChanged: vi.fn(),
  reportViewportOnColumnChange: false,
}));

const decodeArrowWindow = vi.hoisted(() => vi.fn());
const clipboardWrite = vi.fn();

vi.mock("./ViewdaGrid", async () => {
  const React = await import("react");
  const MockViewdaGrid = React.forwardRef<ViewdaGridHandle, ViewdaGridProps>(
    (props, ref) => {
      React.useEffect(() => {
        gridMock.mountCount += 1;
      }, []);
      gridMock.props = props;
      const initialRevision = React.useRef(props.contentRevision);
      React.useEffect(() => {
        if (props.contentRevision !== initialRevision.current) {
          gridMock.revisionChanged(props.contentRevision);
          initialRevision.current = props.contentRevision;
        }
      }, [props.contentRevision]);
      const previousColumns = React.useRef(props.columns);
      React.useEffect(() => {
        if (
          gridMock.reportViewportOnColumnChange &&
          previousColumns.current !== props.columns
        ) {
          props.onViewportChange({
            rowStart: 0,
            rowCount: 3,
            columnIndices: [0, 1],
            mountedRowStart: 0,
            mountedRowCount: 3,
            mountedColumnIndices: [0, 1],
          });
        }
        previousColumns.current = props.columns;
      }, [props.columns, props.onViewportChange]);
      React.useImperativeHandle(
        ref,
        () => ({
          focus: gridMock.focus,
          scrollToRow: gridMock.scrollToRow,
          scrollToColumn: gridMock.scrollToColumn,
        }),
        [],
      );
      return <div data-testid="viewda-grid" tabIndex={0} />;
    },
  );
  return { ViewdaGrid: MockViewdaGrid };
});

vi.mock("./arrow-window", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./arrow-window")>();
  return { ...actual, decodeArrowWindow };
});

const source: desktop.SourceSummary = {
  generation: 7,
  displayName: "large.parquet",
  sizeBytes: 1_000_000_000,
  rowCount: 10_000,
  rowGroupCount: 1,
  schema: Array.from({ length: 8 }, (_, index) => ({
    name: `column_${index}`,
    physicalType: "INT32",
    logicalType: null,
    children: [],
  })),
};

beforeEach(() => {
  document.documentElement.style.setProperty(
    "--font-ui",
    'Inter, sans-serif, "Noto Emoji"',
  );
  document.documentElement.style.setProperty(
    "--font-mono",
    'ui-monospace, monospace, "Noto Emoji"',
  );
  gridMock.props = undefined;
  gridMock.mountCount = 0;
  gridMock.focus.mockReset();
  gridMock.scrollToRow.mockReset();
  gridMock.scrollToColumn.mockReset();
  gridMock.revisionChanged.mockReset();
  gridMock.reportViewportOnColumnChange = false;
  decodeArrowWindow.mockImplementation(
    (
      _bytes: ArrayBuffer,
      rowOffset: number,
      sourceIndices: readonly number[],
    ): ArrowDataWindow => {
      const sourceColumnOffsets = new Map(
        sourceIndices.map((sourceIndex, offset) => [sourceIndex, offset]),
      );
      return {
        rowOffset,
        rowCount: 512,
        sourceIndices,
        sourceColumnOffsets,
        table: {
          schema: {
            fields: Array.from({ length: sourceIndices.length }, () => ({
              type: utf8(),
            })),
          },
          getChildAt: () => ({ at: (row: number) => `row ${row}` }),
        } as unknown as ArrowDataWindow["table"],
      };
    },
  );
  vi.spyOn(desktop, "getDataWindow").mockResolvedValue(new ArrayBuffer(0));
  vi.spyOn(desktop, "prepareDataView").mockImplementation(
    async (_generation, revision, filters) => ({
      revision,
      rowCount: filters.length === 0 ? source.rowCount : 37,
    }),
  );
  vi.spyOn(desktop, "getDataViewStatus").mockResolvedValue({
    revision: 0,
    rowCount: source.rowCount,
  });
  vi.spyOn(desktop, "cancelDataView").mockResolvedValue();
  vi.spyOn(desktop, "getTextValueSuggestions").mockResolvedValue({
    values: [],
    isPartial: false,
  });
  vi.spyOn(desktop, "cancelTextValueSuggestions").mockResolvedValue();
  vi.spyOn(desktop, "getColumnStatistics").mockResolvedValue({
    minimum: "1",
    maximum: "9",
    minMaxComputed: true,
    nullShare: 0.125,
    approximateDistinctCount: 42,
  });
  vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
  vi.spyOn(desktop, "getDataExportStatus").mockResolvedValue(null);
  vi.spyOn(desktop, "startDataExport").mockResolvedValue(null);
  vi.spyOn(desktop, "cancelDataExport").mockResolvedValue(true);
  vi.spyOn(desktop, "dismissDataExport").mockResolvedValue(true);
  vi.spyOn(desktop, "revealDataExport").mockResolvedValue();
  clipboardWrite.mockReset();
  clipboardWrite.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty("--font-ui");
  document.documentElement.style.removeProperty("--font-mono");
  Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataGrid window rendering", () => {
  it("increments content revision when a viewport window loads", async () => {
    render(<DataGrid source={source} />);

    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
    gridMock.revisionChanged.mockClear();
    const visibleRegionChanged = gridMock.props?.onViewportChange;
    expect(visibleRegionChanged).toBeTypeOf("function");
    act(() => {
      visibleRegionChanged?.({
        rowStart: 1_000,
        rowCount: 5,
        columnIndices: [0, 3, 4, 5, 6],
        mountedRowStart: 997,
        mountedRowCount: 11,
        mountedColumnIndices: [0, 2, 3, 4, 5, 6, 7],
      });
    });

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );

    expect(gridMock.revisionChanged.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it("loads the bundled emoji font and repaints the visible cells", async () => {
    const emojiFont = deferred<void>();
    const load = vi.fn(() => emojiFont.promise);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        *[Symbol.iterator]() {
          yield { family: '"Noto Emoji"', load };
        },
      },
    });
    render(<DataGrid source={source} />);

    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
    expect(load).toHaveBeenCalledOnce();
    gridMock.revisionChanged.mockClear();
    await act(async () => {
      emojiFont.resolve();
    });
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
  });

  it("loads bounded mounted columns without churning inside their viewport", async () => {
    const wideSource = {
      ...source,
      schema: Array.from({ length: 20 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 1, 2, 3, 4, 5, 6, 7],
      ),
    );

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 5,
        columnIndices: [0, 10, 11, 12],
        mountedColumnIndices: [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      });
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      ),
    );

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 5,
        columnIndices: [0, 12, 13, 14],
        mountedColumnIndices: [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
      });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 5,
        columnIndices: [0, 16, 17],
        mountedColumnIndices: [0, 12, 13, 14, 15, 16, 17, 18, 19],
      });
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 12, 13, 14, 15, 16, 17, 18, 19],
      ),
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("loads only viewport and frozen columns from a prepared view", async () => {
    const wideSource = {
      ...source,
      schema: Array.from({ length: 20 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        expect.any(Number),
        37,
        [0, 1, 2, 3, 4, 5, 6, 7],
      ),
    );

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 5,
        columnIndices: [0, 10, 11, 12, 13],
      });
    });

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        0,
        37,
        [0, 10, 11, 12, 13],
      ),
    );
  });

  it("loads only selected columns when copying from a direct view", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 2 },
          range: { x: 2, y: 0, width: 2, height: 1 },
          rangeStack: [],
        },
      });
    });
    act(() => {
      gridMock.props?.onCopy(
        new Event("copy", { cancelable: true }) as ClipboardEvent,
      );
    });

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 512, [2, 3]),
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("copies the Cartesian union of stacked rectangles", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 5, column: 2 },
          range: { x: 2, y: 5, width: 3, height: 2 },
          rangeStack: [{ x: 0, y: 1, width: 2, height: 2 }],
        },
      });
    });
    copyFromGrid();

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenCalledWith(
      7,
      0,
      0,
      512,
      [0, 1, 2, 3, 4],
    );
    const copied = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(copied.split("\n")).toEqual([
      "row 1\trow 1\trow 1\trow 1\trow 1",
      "row 2\trow 2\trow 2\trow 2\trow 2",
      "row 5\trow 5\trow 5\trow 5\trow 5",
      "row 6\trow 6\trow 6\trow 6\trow 6",
    ]);
  });

  it("loads only selected columns when copying from a prepared view", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        expect.any(Number),
        37,
        expect.any(Array),
      ),
    );
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 2 },
          range: { x: 2, y: 0, width: 2, height: 1 },
          rangeStack: [],
        },
      });
    });
    act(() => {
      gridMock.props?.onCopy(
        new Event("copy", { cancelable: true }) as ClipboardEvent,
      );
    });

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 1, 0, 37, [2, 3]),
    );
  });

  it("keeps an unloaded copy alive while a column is resized", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    const copyWindow = deferred<ArrayBuffer>();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(copyWindow.promise);

    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 1_000, column: 2 },
          range: { x: 2, y: 1_000, width: 2, height: 1 },
          rangeStack: [],
        },
      });
    });
    copyFromGrid();
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => {
      gridMock.props?.onColumnResize(0, 220);
    });
    copyWindow.resolve(new ArrayBuffer(0));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
  });

  it("keeps loaded cells populated without duplicate prefetches", async () => {
    render(<DataGrid source={source} />);

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      0,
      512,
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );

    const nextWindow = deferred<ArrayBuffer>();
    vi.mocked(desktop.getDataWindow).mockImplementationOnce(
      () => nextWindow.promise,
    );
    const visibleRegionChanged = gridMock.props?.onViewportChange;
    const getCellContent = gridMock.props?.getCellContent;
    act(() => {
      visibleRegionChanged?.({
        rowStart: 400,
        rowCount: 5,
        columnIndices: [0, 1, 2, 3],
        mountedRowStart: 397,
        mountedRowCount: 11,
        mountedColumnIndices: [0, 1, 2, 3, 4],
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      expect.any(Number),
      512,
      expect.any(Array),
    );

    act(() => {
      visibleRegionChanged?.({
        rowStart: 401,
        rowCount: 5,
        columnIndices: [0, 1, 2, 3],
        mountedRowStart: 398,
        mountedRowCount: 11,
        mountedColumnIndices: [0, 1, 2, 3, 4],
      });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);
    expect(getCellContent?.({ column: 0, row: 401 }).kind).toBe("text");

    await act(async () => {
      nextWindow.resolve(new ArrayBuffer(0));
    });
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledTimes(2),
    );
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);
  });

  it("passes renderer-neutral column presentation", () => {
    render(<DataGrid source={source} />);

    expect(gridMock.props?.columns[0]).toMatchObject({
      id: "0",
      title: "column_0",
      monospace: false,
      pinned: false,
      pending: false,
      sort: { direction: "neutral" },
    });
  });

  it("clears a horizontal extent error when the projection becomes safe", () => {
    render(<DataGrid source={source} />);
    const onHorizontalExtentChange = gridMock.props?.onHorizontalExtentChange;
    expect(onHorizontalExtentChange).toBeTypeOf("function");

    act(() => onHorizontalExtentChange?.(true, 1_200, 1_000));
    expect(
      screen.getByText(
        "The projected columns are 200 pixels wider than this webview can scroll.",
      ),
    ).toBeInTheDocument();
    expect(gridMock.props?.onHorizontalExtentChange).toBe(
      onHorizontalExtentChange,
    );

    act(() => onHorizontalExtentChange?.(false, 800, 1_000));
    expect(screen.queryByText(/wider than this webview can scroll/)).toBeNull();
  });

  it("always renders the path-free query row", () => {
    render(<DataGrid source={source} />);

    const query = screen.getByLabelText("Query");
    const expression = query.querySelector(".query-expression");
    expect(
      Array.from(expression?.children ?? [], (node) => node.textContent),
    ).toEqual(["SELECT", "*", "FROM", "this", "WHERE⋯", "ORDER BY⋯"]);
    expect(within(query).getByText("SELECT", { selector: "span" })).toHaveClass(
      "query-keyword",
    );
    expect(within(query).getByText("this")).toBeInTheDocument();
    expect(within(query).getAllByRole("button", { name: "⋯" })).toHaveLength(2);
    expect(query).not.toHaveTextContent(source.displayName);
    expect(query).toHaveTextContent("10,000 rows");
    expect(
      within(query).getByRole("button", { name: "Fit column widths" }),
    ).toHaveAttribute("title", "Fit column widths");
  });

  it("fits every visible column, including pinned columns, in one request on every press", async () => {
    const context = {
      font: "",
      measureText: vi.fn(() => ({ width: 20 })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      gridMock.props?.onColumnResize(7, 240);
    });
    openColumnMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    openColumnMenu(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    const fitButton = screen.getByRole("button", {
      name: "Fit column widths",
    });
    fireEvent.click(fitButton);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    fireEvent.click(fitButton);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));

    expect(desktop.getDataWindow).toHaveBeenNthCalledWith(
      1,
      7,
      0,
      0,
      64,
      [0, 1, 2, 3, 4, 5, 6],
    );
    expect(desktop.getDataWindow).toHaveBeenNthCalledWith(
      2,
      7,
      0,
      0,
      64,
      [0, 1, 2, 3, 4, 5, 6],
    );
    expect(gridMock.props?.columns[0]?.id).toBe("2");

    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    const restored = gridMock.props?.columns.find(
      (column) => column.id === "7",
    );
    expect(
      restored !== undefined && "width" in restored ? restored.width : 0,
    ).toBe(240);
  });

  it("measures batch fit with the rendered header and cell fonts", async () => {
    const fittingSource: desktop.SourceSummary = {
      ...source,
      rowCount: 2,
      schema: [
        { ...source.schema[0]!, name: "number" },
        { ...source.schema[1]!, name: "label" },
      ],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        sourceIndices: readonly number[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 2,
        sourceIndices,
        sourceColumnOffsets: new Map(
          sourceIndices.map((sourceIndex, offset) => [sourceIndex, offset]),
        ),
        table: {
          schema: {
            fields: sourceIndices.map((sourceIndex) => ({
              type: sourceIndex === 0 ? int32() : utf8(),
            })),
          },
          getChildAt: (columnOffset: number) => ({
            at: () =>
              sourceIndices[columnOffset] === 0 ? 123_456 : "wide label",
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    const measuredFonts: string[] = [];
    const context = {
      font: "",
      measureText: vi.fn(() => {
        measuredFonts.push(context.font);
        return {
          width: context.font.startsWith("600")
            ? 30
            : context.font.includes("ui-monospace")
              ? 240
              : 180,
        };
      }),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    render(<DataGrid source={fittingSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Fit column widths" }));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 2, [0, 1]);
    await waitFor(() => {
      expect(
        gridMock.props?.columns.map((column) =>
          "width" in column ? column.width : 0,
        ),
      ).toEqual([260, 200]);
    });
    expect(measuredFonts).toContain('600 12px Inter, sans-serif, "Noto Emoji"');
    expect(measuredFonts).toContain(
      '12px ui-monospace, monospace, "Noto Emoji"',
    );
    expect(measuredFonts).toContain('12px Inter, sans-serif, "Noto Emoji"');
  });

  it("fits zero-row columns to capped header widths", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision, filters) => ({
        revision,
        rowCount: filters.length === 0 ? source.rowCount : 0,
      }),
    );
    const context = {
      font: "",
      measureText: vi.fn((title: string) => ({
        width: title === "column_0" ? 600 : title === "column_1" ? 150 : 20,
      })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    render(<DataGrid source={source} />);

    addNumberFilter("42");
    await waitFor(() =>
      expect(
        screen.getByText("No rows match these conditions."),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit column widths" }));
    expect(context.font).toContain("Inter");
    expect(context.measureText).toHaveBeenCalledTimes(source.schema.length);

    fireEvent.click(
      screen.getByRole("button", { name: "Clear WHERE and ORDER BY" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("viewda-grid")).toBeVisible(),
    );

    const widths = gridMock.props?.columns.map((column) =>
      "width" in column ? column.width : 0,
    );
    expect(widths?.slice(0, 3)).toEqual([500, 194, 112]);
  });

  it("clamps the WHERE popup inside a narrow viewport", () => {
    vi.stubGlobal("innerWidth", 600);
    vi.stubGlobal("innerHeight", 400);
    render(<DataGrid source={source} />);
    const wrap = document.querySelector(".query-where-wrap");
    vi.spyOn(wrap as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
      left: 520,
      bottom: 80,
    } as DOMRect);

    fireEvent.click(
      within(wrap as HTMLDivElement).getByRole("button", { name: "⋯" }),
    );

    const popup = screen.getByRole("dialog", { name: "WHERE conditions" });
    expect(popup).toHaveStyle({ left: "16px", top: "88px" });
    expect(wrap).not.toContainElement(popup);
    expect(popup.parentElement).toBe(document.querySelector(".data-grid-view"));

    fireEvent.pointerDown(popup);
    expect(popup).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(
      screen.queryByRole("dialog", { name: "WHERE conditions" }),
    ).toBeNull();
  });

  it("updates SELECT from hidden-column state and clearing WHERE keeps it", async () => {
    render(<DataGrid source={source} />);

    openColumnMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7/8 cols]");

    addNumberFilter("42");
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent(
        '"column_0" = 42',
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Clear WHERE and ORDER BY" }),
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Query")).not.toHaveTextContent(
        '"column_0" = 42',
      ),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7/8 cols]");

    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("*");
  });

  it("keeps the SELECT picker and grid column menu on one visibility state", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    openColumnMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    const picker = openSelectPicker();
    const lastColumn = within(picker).getByRole("checkbox", {
      name: "Show column_7",
    });
    expect(lastColumn).not.toBeChecked();
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7/8 cols]");
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 1, 2, 3, 4, 5, 6],
      ),
    );

    fireEvent.click(lastColumn);
    expect(lastColumn).toBeChecked();
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("*");
    expect(gridMock.props?.columns).toHaveLength(8);
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("keeps the header menu through visible overscan and closes it after unmount", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openColumnMenu(7);
    expect(
      screen.getByRole("menu", { name: "column_7 column" }),
    ).toBeInTheDocument();

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [0, 1, 2, 3],
        mountedColumnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
      });
    });

    expect(
      screen.getByRole("menu", { name: "column_7 column" }),
    ).toBeInTheDocument();

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [0, 1, 2, 3],
        mountedColumnIndices: [0, 1, 2, 3],
      });
    });

    expect(screen.queryByRole("menu", { name: "column_7 column" })).toBeNull();
  });

  it("tracks a header filter by source column across projection reorder", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openFilterEditor(2);
    openColumnMenu(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [0],
        mountedColumnIndices: [0],
      });
    });
    expect(
      screen.getByRole("form", { name: "Filter column_2" }),
    ).toBeInTheDocument();

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [1, 2, 3],
        mountedColumnIndices: [1, 2, 3],
      });
    });
    expect(screen.queryByRole("form", { name: "Filter column_2" })).toBeNull();
  });

  it("closes the grid context menu after its cell unmounts", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openGridMenu();

    act(() => {
      reportViewport({
        rowStart: 100,
        rowCount: 3,
        columnIndices: [0, 1, 2, 3],
        mountedRowStart: 98,
        mountedRowCount: 7,
      });
    });

    expect(screen.queryByRole("menu", { name: "Data export" })).toBeNull();
  });

  it("closes a cell filter after its anchor row unmounts", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openGridMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter by this value…" }),
    );

    act(() => {
      reportViewport({
        rowStart: 100,
        rowCount: 3,
        columnIndices: [0, 1, 2, 3],
        mountedRowStart: 98,
        mountedRowCount: 7,
      });
    });

    expect(screen.queryByRole("form", { name: "Filter column_0" })).toBeNull();
  });

  it("keeps a query filter editor open when the grid viewport changes", async () => {
    render(<DataGrid source={source} />);
    addNumberFilter("1");
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent(
        '"column_0" = 1',
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: '"column_0" = 1' }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "WHERE conditions" }),
      ).getByRole("button", { name: "Edit" }),
    );

    act(() => {
      reportViewport({
        rowStart: 100,
        rowCount: 3,
        columnIndices: [4, 5, 6, 7],
      });
    });

    expect(
      screen.getByRole("form", { name: "Filter column_0" }),
    ).toBeInTheDocument();
  });

  it("closes the header menu when its column is hidden", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openColumnMenu(7);
    const picker = openSelectPicker();

    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Show column_7" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "column_7 column" }),
      ).toBeNull(),
    );
  });

  it("keeps row selection while hide and show clear column-relative selection", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selectedRows = CompactSelection.fromSingleSelection([2, 5]);
    const selection: GridSelection = {
      current: {
        cell: { column: 1, row: 2 },
        range: { x: 1, y: 2, width: 2, height: 3 },
        rangeStack: [{ x: 4, y: 6, width: 2, height: 2 }],
      },
      columns: CompactSelection.fromSingleSelection([1, 3]),
      rows: selectedRows,
    };
    act(() => gridMock.props?.onSelectionChange?.(selection));

    openColumnMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));

    expect(gridMock.props?.selection?.current).toBeUndefined();
    expect(gridMock.props?.selection?.columns.length).toBe(0);
    expect(gridMock.props?.selection?.rows).toBe(selectedRows);

    const picker = openSelectPicker();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Show column_7" }),
    );

    expect(gridMock.props?.selection?.current).toBeUndefined();
    expect(gridMock.props?.selection?.columns.length).toBe(0);
    expect(gridMock.props?.selection?.rows).toBe(selectedRows);
  });

  it("pins and unpins without reloading the window or clearing row selection", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(4),
    };
    act(() => gridMock.props?.onSelectionChange?.(selection));
    vi.mocked(desktop.getDataWindow).mockClear();

    openColumnMenu(2);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    expect(
      gridMock.props?.columns.filter((column) => column.pinned).length,
    ).toBe(1);
    expect(gridMock.props?.columns[0]?.title).toBe("column_2");
    expect(gridMock.props?.selection).toEqual(selection);
    expect(desktop.getDataWindow).not.toHaveBeenCalled();

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin column" }));

    expect(
      gridMock.props?.columns.filter((column) => column.pinned).length,
    ).toBe(0);
    expect(gridMock.props?.columns[0]?.title).toBe("column_0");
    expect(gridMock.props?.selection).toEqual(selection);
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
  });

  it("clears column and range selection when pinning changes visible order", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selectedRows = CompactSelection.fromSingleSelection(4);
    const selection: GridSelection = {
      current: {
        cell: { column: 1, row: 2 },
        range: { x: 1, y: 2, width: 2, height: 3 },
        rangeStack: [{ x: 4, y: 6, width: 2, height: 2 }],
      },
      columns: CompactSelection.fromSingleSelection([1, 3]),
      rows: selectedRows,
    };
    act(() => gridMock.props?.onSelectionChange?.(selection));
    vi.mocked(desktop.getDataWindow).mockClear();

    openColumnMenu(3);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    expect(gridMock.props?.columns[0]?.title).toBe("column_3");
    expect(gridMock.props?.selection?.current).toBeUndefined();
    expect(gridMock.props?.selection?.columns.length).toBe(0);
    expect(gridMock.props?.selection?.rows).toBe(selectedRows);
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
  });

  it("keeps column and range selection when pinning preserves visible order", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection: GridSelection = {
      current: {
        cell: { column: 1, row: 2 },
        range: { x: 1, y: 2, width: 2, height: 3 },
        rangeStack: [],
      },
      columns: CompactSelection.fromSingleSelection(1),
      rows: CompactSelection.empty(),
    };
    act(() => gridMock.props?.onSelectionChange?.(selection));
    vi.mocked(desktop.getDataWindow).mockClear();

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    expect(
      gridMock.props?.columns.filter((column) => column.pinned).length,
    ).toBe(1);
    expect(gridMock.props?.columns[0]?.title).toBe("column_0");
    expect(gridMock.props?.selection).toEqual(selection);
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
  });

  it("pins and unpins columns from SELECT picker icon buttons", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    const picker = openSelectPicker();

    const pin = within(picker).getByRole("button", { name: "Pin column_3" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(pin);

    const unpin = within(picker).getByRole("button", {
      name: "Unpin column_3",
    });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    expect(
      gridMock.props?.columns.filter((column) => column.pinned).length,
    ).toBe(1);
    expect(gridMock.props?.columns[0]?.title).toBe("column_3");
    expect(desktop.getDataWindow).not.toHaveBeenCalled();

    fireEvent.click(unpin);

    expect(
      within(picker).getByRole("button", { name: "Pin column_3" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      gridMock.props?.columns.filter((column) => column.pinned).length,
    ).toBe(0);
    expect(gridMock.props?.columns[0]?.title).toBe("column_0");
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
  });

  it("hides and shows every column from the SELECT picker", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selectedRows = CompactSelection.fromSingleSelection([2, 5]);
    act(() =>
      gridMock.props?.onSelectionChange?.({
        columns: CompactSelection.empty(),
        rows: selectedRows,
      }),
    );
    vi.mocked(desktop.getDataWindow).mockClear();
    const picker = openSelectPicker();

    fireEvent.click(within(picker).getByRole("button", { name: "Hide all" }));

    expect(screen.getByLabelText("Query")).toHaveTextContent("[0/8 cols]");
    expect(screen.getByText("No columns selected.")).toBeInTheDocument();
    expect(
      within(picker).getByRole("button", { name: "Hide all" }),
    ).toBeDisabled();
    expect(
      within(picker).getByRole("button", { name: "Show all" }),
    ).toBeEnabled();
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
    expect(desktop.prepareDataView).not.toHaveBeenCalled();

    fireEvent.click(within(picker).getByRole("button", { name: "Show all" }));

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        0,
        512,
        [0, 1, 2, 3, 4, 5, 6, 7],
      ),
    );
    expect(screen.queryByText("No columns selected.")).not.toBeInTheDocument();
    expect(gridMock.props?.columns).toHaveLength(8);
    expect(gridMock.props?.selection?.rows).toBe(selectedRows);
  });

  it("virtualizes and searches ten thousand SELECT columns", () => {
    const wideSource = {
      ...source,
      schema: Array.from({ length: 10_000 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);

    const picker = openSelectPicker();
    expect(within(picker).getAllByRole("checkbox").length).toBeLessThan(20);
    fireEvent.change(within(picker).getByRole("searchbox"), {
      target: { value: "column_9999" },
    });

    const lastColumn = within(picker).getByRole("checkbox", {
      name: "Show column_9999",
    });
    expect(lastColumn).toBeInTheDocument();
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(1);

    fireEvent.click(lastColumn);
    const selectButton = screen
      .getByLabelText("Query")
      .querySelector<HTMLButtonElement>(".query-select");
    expect(selectButton).toHaveAttribute(
      "title",
      "9,999 of 10,000 columns visible",
    );
    expect(selectButton?.title.length).toBeLessThan(100);
  });

  it("shrinks a short SELECT list and exposes complete list semantics", () => {
    render(
      <DataGrid source={{ ...source, schema: source.schema.slice(0, 3) }} />,
    );

    const picker = openSelectPicker();
    const list = within(picker).getByRole("list", { name: "Columns" });
    expect(list).toHaveStyle({ maxHeight: "288px" });
    expect(list.style.height).toBe("");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(picker).getByRole("status")).toHaveTextContent(
      "3 of 3 visible",
    );
  });

  it("moves through SELECT columns with arrows and toggles with Space", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const picker = openSelectPicker();
    const search = within(picker).getByRole("searchbox");

    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    const first = within(picker).getByRole("checkbox", {
      name: "Show column_0",
    });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = within(picker).getByRole("checkbox", {
      name: "Show column_1",
    });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: " " });

    expect(second).not.toBeChecked();
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 2, 3, 4, 5, 6, 7],
      ),
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("reloads only windows when a filter and sort column becomes hidden", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    addNumberFilter("1");
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(37));
    act(() => {
      gridMock.props?.onSort(0, false);
    });
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 0, operator: "equals", values: ["1"] }],
        [{ sourceIndex: 0, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        2,
        0,
        37,
        expect.any(Array),
      ),
    );
    vi.mocked(desktop.prepareDataView).mockClear();
    vi.mocked(desktop.getDataWindow).mockClear();

    const picker = openSelectPicker();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Show column_0" }),
    );

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        2,
        0,
        37,
        [1, 2, 3, 4, 5, 6, 7],
      ),
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("does not prepare an empty source when ORDER BY changes", () => {
    render(<DataGrid source={{ ...source, rowCount: 0 }} />);

    const orderWrap = document.querySelector(".query-order-wrap");
    fireEvent.click(
      within(orderWrap as HTMLDivElement).getByRole("button", { name: "⋯" }),
    );
    const popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: "0" },
    });
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));

    expect(screen.getByText("This file has no rows.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: '"column_0" ASC' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Query")).toHaveTextContent("0 rows");
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("focuses the ORDER BY popup and does not prepare an unchanged view", () => {
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getAllByRole("button", { name: "⋯" })[1]!);
    const popup = screen.getByRole("dialog", { name: "ORDER BY columns" });

    expect(within(popup).getByLabelText("Add column")).toHaveFocus();
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: "ORDER BY columns" }),
    ).not.toBeInTheDocument();
  });

  it("applies the selected preparation memory to a new view", async () => {
    render(
      <DataGrid source={source} viewSettings={{ memoryLimit: "mb1536" }} />,
    );

    addNumberFilter("42");

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [{ columnIndex: 0, operator: "equals", values: ["42"] }],
        [],
        { memoryLimit: "mb1536" },
      ),
    );
  });

  it("resizes live within the width limits", () => {
    render(<DataGrid source={source} />);

    act(() => {
      gridMock.props?.onColumnResize(0, 80);
    });
    const resized = gridMock.props?.columns[0];
    expect(
      resized !== undefined && "width" in resized ? resized.width : 0,
    ).toBe(112);
  });

  it("auto-fits one column with its rendered font", async () => {
    const fittingSource: desktop.SourceSummary = {
      ...source,
      rowCount: 2,
      schema: [{ ...source.schema[0]!, name: "number" }],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        sourceIndices: readonly number[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 2,
        sourceIndices,
        sourceColumnOffsets: new Map([[0, 0]]),
        table: {
          schema: { fields: [{ type: int32() }] },
          getChildAt: () => ({ at: () => 123_456 }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    const context = {
      font: "",
      measureText: vi.fn(() => ({
        width: context.font.startsWith("600") ? 30 : 240,
      })),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context,
    );
    render(<DataGrid source={fittingSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      gridMock.props?.onColumnAutoFit(0);
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 2, [0]),
    );
    expect(
      gridMock.props?.columns[0] !== undefined &&
        "width" in gridMock.props.columns[0]
        ? gridMock.props.columns[0].width
        : 0,
    ).toBe(260);
    expect(context.font).toContain("ui-monospace");
  });

  it("maps renderer sort intents to source columns", async () => {
    render(<DataGrid source={source} />);

    act(() => {
      gridMock.props?.onSort(2, false);
    });

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [],
        [{ sourceIndex: 2, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() => {
      expect(gridMock.props?.columns[2]?.title).toBe("column_2");
      expect(gridMock.props?.columns[2]?.sort.direction).toBe("ascending");
    });

    act(() => {
      gridMock.props?.onSort(3, true);
    });
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [],
        [
          { sourceIndex: 2, direction: "ascending" },
          { sourceIndex: 3, direction: "ascending" },
        ],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() => {
      expect(gridMock.props?.columns[2]?.title).toBe("column_2");
      expect(gridMock.props?.columns[3]?.title).toBe("column_3");
      expect(gridMock.props?.columns[2]?.sort).toEqual({
        direction: "ascending",
        priority: 1,
      });
      expect(gridMock.props?.columns[3]?.sort).toEqual({
        direction: "ascending",
        priority: 2,
      });
    });

    act(() => {
      gridMock.props?.onSelectionChange?.({
        columns: desktopSelection(2),
        rows: desktopSelection(),
      });
    });
    expect(gridMock.props?.selection?.columns.hasIndex(2)).toBe(true);
  });

  it("renders canonical ORDER BY and edits direction and priority in its popup", async () => {
    const quotedSource: desktop.SourceSummary = {
      ...source,
      schema: [
        { ...source.schema[0]!, name: 'quoted"name' },
        { ...source.schema[1]!, name: "second" },
      ],
    };
    render(<DataGrid source={quotedSource} />);

    fireEvent.click(screen.getAllByRole("button", { name: "⋯" })[1]!);
    let popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: "0" },
    });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: "1" },
    });
    fireEvent.change(within(popup).getByLabelText("Direction for second"), {
      target: { value: "descending" },
    });
    fireEvent.click(
      within(popup).getByRole("button", { name: "Move second earlier" }),
    );
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: '"second" DESC, "quoted""name" ASC',
        }),
      ).toBeInTheDocument(),
    );
    expect(desktop.prepareDataView).toHaveBeenCalledWith(
      7,
      1,
      [],
      [
        { sourceIndex: 1, direction: "descending" },
        { sourceIndex: 0, direction: "ascending" },
      ],
      { memoryLimit: "mb384" },
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: '"second" DESC, "quoted""name" ASC',
      }),
    );
    popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.click(
      within(popup).getByRole("button", { name: "Remove sort second" }),
    );
    expect(
      within(popup).queryByRole("button", { name: "Remove sort second" }),
    ).not.toBeInTheDocument();
  });

  it("edits the pending ORDER BY instead of replacing it from the active view", async () => {
    const first = deferred<desktop.DataViewStatus>();
    const second = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getAllByRole("button", { name: "⋯" })[1]!);
    let popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: "0" },
    });
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [{ sourceIndex: 0, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "⋯" })[1]!);
    popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    expect(
      within(popup).getByRole("button", { name: "Remove sort column_0" }),
    ).toBeInTheDocument();
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: "1" },
    });
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [],
        [
          { sourceIndex: 0, direction: "ascending" },
          { sourceIndex: 1, direction: "ascending" },
        ],
        { memoryLimit: "mb384" },
      ),
    );
    expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1);

    await act(async () => second.resolve({ revision: 2, rowCount: 19 }));
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(19));
    await act(async () => first.resolve({ revision: 1, rowCount: 99 }));
    expect(gridMock.props?.rowCount).toBe(19);
  });

  it("keeps sorting while a filter changes and clears both clauses together", async () => {
    render(<DataGrid source={source} />);
    act(() => {
      gridMock.props?.onSort(2, false);
    });
    await waitFor(() =>
      expect(gridMock.props?.columns[2]?.sort.direction).toBe("ascending"),
    );

    addNumberFilter("4");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 0, operator: "equals", values: ["4"] }],
        [{ sourceIndex: 2, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: '"column_0" = 4' }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: '"column_2" ASC' }),
      ).toBeInTheDocument();
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Clear WHERE and ORDER BY" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(7, 3, [], [], {
        memoryLimit: "mb384",
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByLabelText("Query")).getAllByRole("button", {
          name: "⋯",
        }),
      ).toHaveLength(2),
    );
    expect(gridMock.props?.columns[2]?.title).toBe("column_2");
    expect(gridMock.props?.columns[2]?.sort.direction).toBe("neutral");
  });

  it("edits and removes conditions through the full WHERE popup", async () => {
    render(<DataGrid source={source} />);
    addNumberFilter("-3");

    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent(
        '"column_0" = -3',
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: '"column_0" = -3' }));
    const popup = screen.getByRole("dialog", { name: "WHERE conditions" });
    expect(within(popup).getByText('"column_0" = -3')).toBeInTheDocument();

    fireEvent.click(within(popup).getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("form", { name: "Filter column_0" });
    const value = within(editor).getByRole("textbox", { name: "Value" });
    fireEvent.change(value, { target: { value: "-7" } });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Save condition" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent(
        '"column_0" = -7',
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: '"column_0" = -7' }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "WHERE conditions" }),
      ).getByRole("button", { name: /Remove filter/ }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).not.toHaveTextContent(
        '"column_0" = -7',
      ),
    );
  });

  it("prepares a new view when only text case matching changes", async () => {
    const textSource: desktop.SourceSummary = {
      ...source,
      schema: [
        {
          name: "label",
          physicalType: "BYTE_ARRAY",
          logicalType: "String",
          children: [],
        },
      ],
    };
    render(<DataGrid source={textSource} />);

    openFilterEditor(0);
    let editor = screen.getByRole("form", { name: "Filter label" });
    fireEvent.change(within(editor).getByLabelText("Condition"), {
      target: { value: "textContains" },
    });
    fireEvent.change(within(editor).getByLabelText("Value"), {
      target: { value: "Alpha" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [{ columnIndex: 0, operator: "textContains", values: ["Alpha"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /contains/ }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "WHERE conditions" }),
      ).getByRole("button", { name: "Edit" }),
    );
    editor = screen.getByRole("form", { name: "Filter label" });
    fireEvent.click(within(editor).getByRole("button", { name: "Match case" }));
    fireEvent.click(
      within(editor).getByRole("button", { name: "Save condition" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [
          {
            columnIndex: 0,
            operator: "textContains",
            values: ["Alpha"],
            matchCase: true,
          },
        ],
        [],
        { memoryLimit: "mb384" },
      ),
    );
  });

  it("keeps the current grid live until the prepared view and its count are ready", async () => {
    const preparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    addNumberFilter("1");

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [{ columnIndex: 0, operator: "equals", values: ["1"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.rowCount).toBe(10_000);
    expect(screen.getByLabelText("Query")).toHaveTextContent("preparing view…");
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 1',
    );

    await act(async () => preparation.resolve({ revision: 1, rowCount: 37 }));

    await waitFor(() => expect(gridMock.props?.rowCount).toBe(37));
    expect(screen.getByLabelText("Query")).toHaveTextContent('"column_0" = 1');
    expect(screen.getByLabelText("Query")).toHaveTextContent("37 rows");
  });

  it("loads the current viewport after preparation completes during scrolling", async () => {
    const preparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    addNumberFilter("1");

    act(() => {
      reportViewport({
        rowStart: 1_000,
        rowCount: 5,
        columnIndices: [0, 1, 2, 3],
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));

    await act(async () =>
      preparation.resolve({ revision: 1, rowCount: 5_000 }),
    );

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        expect.any(Number),
        512,
        [0, 1, 2, 3],
      ),
    );
    expect(
      vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[2],
    ).toBeGreaterThan(0);
  });

  it("drains a promoted view request reported by the grid effect", async () => {
    vi.mocked(desktop.prepareDataView).mockResolvedValueOnce({
      revision: 1,
      rowCount: 3,
    });
    render(<DataGrid source={{ ...source, rowCount: 3 }} />);
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    vi.mocked(desktop.getDataWindow).mockClear();
    gridMock.reportViewportOnColumnChange = true;

    act(() => {
      gridMock.props?.onSort(0, false);
    });

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 1, 0, 3, [0, 1]),
    );
    await waitFor(() =>
      expect(gridMock.props?.getCellContent({ column: 1, row: 0 }).kind).toBe(
        "text",
      ),
    );
  });

  it("clamps and reloads a deep sorted viewport after a cell filter shrinks the view", async () => {
    const filteredSource: desktop.SourceSummary = {
      ...source,
      rowCount: 3_514_000,
      schema: source.schema.map((field, index) =>
        index === 0
          ? {
              ...field,
              name: "boolean_value",
              physicalType: "BOOLEAN",
            }
          : index === 1
            ? { ...field, name: "int16_value" }
            : field,
      ),
    };
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision, filters) => ({
        revision,
        rowCount: filters.length === 0 ? filteredSource.rowCount : 270_308,
      }),
    );
    render(<DataGrid source={filteredSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => {
      gridMock.props?.onSort(1, false);
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        expect.any(Number),
        512,
        expect.any(Array),
      ),
    );

    act(() => {
      reportViewport({
        rowStart: 2_063_949,
        rowCount: 40,
        columnIndices: [0, 1, 2, 3],
      });
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        2_063_885,
        512,
        [0, 1, 2, 3],
      ),
    );

    act(() => {
      gridMock.props?.onCellContextMenu?.(
        { column: 0, row: 2_063_949 },
        { x: 20, y: 20, width: 120, height: 28 },
      );
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter by this value…" }),
    );
    const filterEditor = screen.getByRole("form", {
      name: "Filter boolean_value",
    });
    fireEvent.change(within(filterEditor).getByLabelText("Condition"), {
      target: { value: "isNull" },
    });
    fireEvent.click(
      within(filterEditor).getByRole("button", { name: "Add condition" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 0, operator: "isNull", values: [] }],
        [{ sourceIndex: 1, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(270_308));
    expect(gridMock.mountCount).toBe(1);
    expect(gridMock.scrollToRow).toHaveBeenCalledWith(270_268);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        2,
        269_796,
        512,
        [0, 1, 2, 3],
      ),
    );
    await waitFor(() =>
      expect(
        gridMock.props?.getCellContent({ column: 0, row: 270_268 }).kind,
      ).toBe("text"),
    );
  });

  it("cancels stale preparation and ignores its late completion", async () => {
    const first = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ revision: 2, rowCount: 11 });
    render(<DataGrid source={source} />);

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(1),
    );
    addNumberFilter("2", 1);

    await waitFor(() =>
      expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 1, operator: "equals", values: ["2"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent("11 rows"),
    );

    await act(async () => first.resolve({ revision: 1, rowCount: 99 }));

    expect(screen.getByLabelText("Query")).toHaveTextContent("11 rows");
    expect(screen.getByLabelText("Query")).not.toHaveTextContent("99 rows");
  });

  it("does not apply a window returned for a stale view revision", async () => {
    const staleWindow = deferred<ArrayBuffer>();
    const currentWindow = deferred<ArrayBuffer>();
    vi.mocked(desktop.getDataWindow)
      .mockResolvedValueOnce(new ArrayBuffer(1))
      .mockReturnValueOnce(staleWindow.promise)
      .mockReturnValueOnce(currentWindow.promise);
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    addNumberFilter("1");
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    addNumberFilter("2", 1);
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent(
        '"column_1" = 2',
      ),
    );
    gridMock.revisionChanged.mockReset();
    await act(async () => staleWindow.resolve(new ArrayBuffer(2)));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(3));
    expect(gridMock.revisionChanged).not.toHaveBeenCalled();

    await act(async () => currentWindow.resolve(new ArrayBuffer(3)));
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
  });

  it("coalesces vertical movement behind an unresolved horizontal window", async () => {
    const horizontalWindow = deferred<ArrayBuffer>();
    const latestWindow = deferred<ArrayBuffer>();
    const wideSource = {
      ...source,
      schema: Array.from({ length: 40 }, (_, index) => ({
        name: `column_${index}`,
        physicalType: "INT32",
        logicalType: null,
        children: [],
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow)
      .mockReturnValueOnce(horizontalWindow.promise)
      .mockReturnValueOnce(latestWindow.promise);
    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [20, 21],
      });
      reportViewport({
        rowStart: 1_000,
        rowCount: 3,
        columnIndices: [20, 21],
      });
      reportViewport({
        rowStart: 2_000,
        rowCount: 3,
        columnIndices: [20, 21],
      });
    });

    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      0,
      expect.any(Number),
      [20, 21],
    );
    gridMock.revisionChanged.mockReset();

    await act(async () => horizontalWindow.resolve(new ArrayBuffer(1)));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      expect.any(Number),
      expect.any(Number),
      [20, 21],
    );
    expect(
      vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[2],
    ).toBeGreaterThan(1_000);
    expect(gridMock.revisionChanged).not.toHaveBeenCalled();

    await act(async () => latestWindow.resolve(new ArrayBuffer(2)));
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
  });

  it("interrupts active preparation when the grid closes", async () => {
    const preparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    const { unmount } = render(<DataGrid source={source} />);
    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(1),
    );

    unmount();

    expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1);
  });

  it("cancels visible preparation and resynchronizes the active view", async () => {
    const preparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    render(<DataGrid source={source} />);
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    addNumberFilter("1");

    vi.mocked(desktop.getDataWindow).mockClear();

    fireEvent.click(await screen.findByRole("button", { name: "cancel" }));

    await waitFor(() =>
      expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1),
    );
    await waitFor(() =>
      expect(desktop.getDataViewStatus).toHaveBeenCalledWith(7),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).not.toHaveTextContent(
        "preparing view…",
      ),
    );
    expect(gridMock.props?.rowCount).toBe(10_000);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        expect.any(Number),
        expect.any(Number),
        expect.any(Array),
      ),
    );
  });

  it("keeps the completed grid live when replacement preparation fails", async () => {
    vi.mocked(desktop.prepareDataView).mockRejectedValueOnce(
      new desktop.DataWindowCommandError("queryEngineUnavailable"),
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    vi.mocked(desktop.getDataWindow).mockClear();
    addNumberFilter("9");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not be loaded");
    expect(gridMock.props?.rowCount).toBe(10_000);
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 9',
    );
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      "preparing view…",
    );
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        expect.any(Number),
        expect.any(Number),
        expect.any(Array),
      ),
    );
    fireEvent.click(
      within(alert).getByRole("button", { name: "Dismiss view error" }),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    {
      code: "memoryExhausted" as const,
      expectedMessage: "There is not enough memory to prepare this view.",
      failure: "memory",
    },
    {
      code: "temporaryStorageExhausted" as const,
      expectedMessage:
        "There is not enough temporary disk space to prepare this view.",
      failure: "temporary storage",
    },
  ])(
    "reveals, copies and dismisses path-free $failure diagnostics",
    async ({ code, expectedMessage, failure }) => {
      vi.mocked(desktop.prepareDataView).mockRejectedValueOnce(
        new desktop.DataWindowCommandError(code, {
          operation: "preparation",
          applicationVersion: "0.1.0-alpha.2",
          operatingSystem: "macos",
          architecture: "aarch64",
          queryEngineVersion: "v1.5.5",
          message: "Out of Memory Error: failed to allocate 32.0 MiB",
          memoryLimit: "366.2 MiB",
          maxTemporaryDirectorySize: "45.0 GiB",
          threads: 10,
          rowCount: 3_514_000,
          sourceSizeBytes: 1_000_000_000,
          rowGroupCount: 29,
          columnCount: 43,
          filterCount: 0,
          sortColumns: [
            {
              physicalType: "INT32",
              logicalType: "UInt16",
              direction: "ascending",
            },
          ],
        }),
      );
      render(<DataGrid source={source} />);
      await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());

      addNumberFilter("9");

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(expectedMessage);
      fireEvent.click(within(alert).getByText("Show details"));
      expect(alert).toHaveTextContent("Platform: macos aarch64");
      expect(alert).toHaveTextContent("Sort: INT32 · UInt16 ASCENDING");
      expect(alert).not.toHaveTextContent("large.parquet");

      fireEvent.click(
        within(alert).getByRole("button", { name: "Copy diagnostics" }),
      );
      await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
      expect(clipboardWrite.mock.calls[0]?.[0]).toContain(
        "DuckDB message: Out of Memory Error",
      );
      expect(clipboardWrite.mock.calls[0]?.[0]).toContain(
        `Failure: ${failure}`,
      );
      expect(await within(alert).findByText("Copied")).toBeInTheDocument();

      fireEvent.click(
        within(alert).getByRole("button", { name: "Dismiss view error" }),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("retries an unfiltered window without changing the row count or selection", async () => {
    vi.mocked(desktop.getDataWindow)
      .mockRejectedValueOnce(new desktop.DataWindowCommandError("queryFailed"))
      .mockResolvedValueOnce(new ArrayBuffer(0));
    render(<DataGrid source={source} />);
    const alert = await screen.findByRole("alert");
    expect(screen.getByLabelText("Query")).toHaveTextContent("10,000 rows");
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(4),
    };
    act(() => gridMock.props?.onSelectionChange?.(selection));

    fireEvent.click(
      within(alert).getByRole("button", { name: "Retry window" }),
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(gridMock.props?.selection).toEqual(selection));
  });

  it("shows diagnostics for a prepared-window resource failure and keeps retry", async () => {
    vi.mocked(desktop.getDataWindow)
      .mockRejectedValueOnce(
        new desktop.DataWindowCommandError("memoryExhausted", {
          operation: "window",
          applicationVersion: "0.1.0-alpha.2",
          operatingSystem: "macos",
          architecture: "aarch64",
          queryEngineVersion: "v1.5.5",
          message: "Out of Memory Error: failed to allocate 32.0 MiB",
          memoryLimit: "12.0 GiB",
          maxTemporaryDirectorySize: "45.0 GiB",
          threads: 10,
          rowCount: 3_514_000,
          sourceSizeBytes: 1_000_000_000,
          rowGroupCount: 29,
          columnCount: 43,
          filterCount: 0,
          sortColumns: [
            {
              physicalType: "INT32",
              logicalType: "Int16",
              direction: "ascending",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new ArrayBuffer(0));
    render(<DataGrid source={source} />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "There is not enough memory to load this window.",
    );
    fireEvent.click(within(alert).getByText("Show details"));
    expect(alert).toHaveTextContent("Operation: window");
    expect(alert).toHaveTextContent("Memory limit: 12.0 GiB");

    fireEvent.click(
      within(alert).getByRole("button", { name: "Retry window" }),
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
  });

  it("dismisses a window error without retrying the request", async () => {
    vi.mocked(desktop.getDataWindow).mockRejectedValueOnce(
      new desktop.DataWindowCommandError("queryFailed"),
    );
    render(<DataGrid source={source} />);
    const alert = await screen.findByRole("alert");

    fireEvent.click(
      within(alert).getByRole("button", { name: "Dismiss window error" }),
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    expect(gridMock.props?.rowCount).toBe(source.rowCount);
  });

  it("keeps the grid live when cancelled A completes after failed B", async () => {
    const first = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView)
      .mockReturnValueOnce(first.promise)
      .mockRejectedValueOnce(
        new desktop.DataWindowCommandError("queryEngineUnavailable"),
      );
    render(<DataGrid source={source} />);

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(1),
    );
    addNumberFilter("2", 1);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be loaded",
    );

    await act(async () => first.resolve({ revision: 1, rowCount: 99 }));

    expect(gridMock.props?.rowCount).toBe(10_000);
    expect(screen.getByLabelText("Query")).toHaveTextContent("10,000 rows");
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 1',
    );
  });

  it("does not let a delayed status for revision N-1 clear revision N", async () => {
    const staleStatus = deferred<desktop.DataViewStatus>();
    const currentPreparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView)
      .mockRejectedValueOnce(
        new desktop.DataWindowCommandError("queryEngineUnavailable"),
      )
      .mockReturnValueOnce(currentPreparation.promise);
    vi.mocked(desktop.getDataViewStatus).mockReturnValueOnce(
      staleStatus.promise,
    );
    render(<DataGrid source={source} />);

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getDataViewStatus).toHaveBeenCalledWith(7),
    );
    addNumberFilter("2", 1);
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 1, operator: "equals", values: ["2"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );

    await act(async () =>
      staleStatus.resolve({ revision: 0, rowCount: source.rowCount }),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent("preparing view…");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () =>
      currentPreparation.resolve({ revision: 2, rowCount: 23 }),
    );
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(23));
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        2,
        expect.any(Number),
        expect.any(Number),
        expect.any(Array),
      ),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent('"column_1" = 2');
  });

  it("resynchronizes and retries a window after the native view changes", async () => {
    vi.mocked(desktop.getDataWindow)
      .mockResolvedValueOnce(new ArrayBuffer(0))
      .mockRejectedValueOnce(new desktop.DataWindowCommandError("viewChanged"))
      .mockResolvedValueOnce(new ArrayBuffer(0));
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => {
      reportViewport({
        rowStart: 1_000,
        rowCount: 5,
        columnIndices: [0, 1, 2, 3],
      });
    });

    await waitFor(() =>
      expect(desktop.getDataViewStatus).toHaveBeenCalledWith(7),
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows filter limits while keeping displayed and executed views equal", async () => {
    vi.mocked(desktop.prepareDataView).mockRejectedValueOnce(
      new desktop.DataWindowCommandError("invalidFilter"),
    );
    render(<DataGrid source={source} />);

    addNumberFilter("1");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match its column type or exceeds the limits",
    );
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 1',
    );
    expect(
      screen.queryByRole("button", { name: "Retry window" }),
    ).not.toBeInTheDocument();
  });

  it("prefills a timestamp from its Arrow value instead of raw copy data", async () => {
    const raw =
      BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf()) * 1_000n + 456n;
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        sourceIndices: readonly number[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        sourceIndices,
        sourceColumnOffsets: new Map(
          sourceIndices.map((sourceIndex, offset) => [sourceIndex, offset]),
        ),
        table: {
          schema: {
            fields: sourceIndices.map(() => ({
              type: timestamp(TimeUnit.MICROSECOND, "UTC"),
            })),
          },
          getChildAt: () => ({ at: () => raw }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(
      <DataGrid
        source={{
          ...source,
          rowCount: 1,
          schema: [
            {
              name: "recorded_at",
              physicalType: "INT64",
              logicalType: "Timestamp (microseconds, UTC)",
              children: [],
            },
          ],
        }}
      />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => {
      gridMock.props?.onCellContextMenu?.(
        { column: 0, row: 0 },
        { x: 20, y: 20, width: 120, height: 28 },
      );
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter by this value…" }),
    );

    expect(
      within(
        screen.getByRole("form", { name: "Filter recorded_at" }),
      ).getByRole("textbox", { name: "Value" }),
    ).toHaveValue("2026-08-01T06:07:08.009456Z");
    expect(screen.queryByDisplayValue(raw.toString())).not.toBeInTheDocument();
  });

  it("opens the nested schema without scanning until a column is selected", async () => {
    const nestedSource: desktop.SourceSummary = {
      ...source,
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "address",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                {
                  name: "city",
                  physicalType: "BYTE_ARRAY",
                  logicalType: "String",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
    render(<DataGrid source={nestedSource} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    expect(within(sidebar).getByText("profile")).toBeInTheDocument();
    expect(within(sidebar).getByText("address")).toBeInTheDocument();
    expect(within(sidebar).getByText("city")).toBeInTheDocument();
    expect(within(sidebar).getByText("BYTE_ARRAY · String")).toHaveClass(
      "schema-type",
    );
    expect(within(sidebar).getByText("BYTE_ARRAY · String")).toHaveAttribute(
      "title",
      "BYTE_ARRAY · String",
    );
    expect(
      within(sidebar).queryByRole("heading", { name: "Schema" }),
    ).not.toBeInTheDocument();
    expect(within(sidebar).getByText("1 column")).toBeInTheDocument();
    expect(desktop.getColumnStatistics).not.toHaveBeenCalled();

    fireEvent.click(within(sidebar).getByRole("button", { name: /profile/ }));
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 0, true),
    );
    expect(await within(sidebar).findByText("12.5%")).toBeInTheDocument();
    expect(within(sidebar).getByText("≈ 42")).toBeInTheDocument();
    expect(gridMock.scrollToColumn).toHaveBeenCalledWith(0, 16);
  });

  it("keeps duplicate sibling names as distinct schema nodes", () => {
    const duplicateSource: desktop.SourceSummary = {
      ...source,
      schema: [
        {
          name: "duplicate",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "duplicate",
              physicalType: "INT32",
              logicalType: null,
              children: [],
            },
            {
              name: "duplicate",
              physicalType: "INT32",
              logicalType: null,
              children: [],
            },
          ],
        },
        {
          name: "duplicate",
          physicalType: "GROUP",
          logicalType: null,
          children: [],
        },
      ],
    };
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(<DataGrid source={duplicateSource} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));

    expect(screen.getAllByText("duplicate")).toHaveLength(4);
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
  });

  it.each(["String", null] as const)(
    "defers BYTE_ARRAY min and max with logical type %s",
    async (logicalType) => {
      const byteArraySource: desktop.SourceSummary = {
        ...source,
        schema: [
          {
            name: "label",
            physicalType: "BYTE_ARRAY",
            logicalType,
            children: [],
          },
        ],
      };
      vi.mocked(desktop.getColumnStatistics)
        .mockResolvedValueOnce({
          minimum: null,
          maximum: null,
          minMaxComputed: false,
          nullShare: 0.01,
          approximateDistinctCount: 31_300_000,
        })
        .mockResolvedValueOnce({
          minimum: "001",
          maximum: "zzz",
          minMaxComputed: true,
          nullShare: 0.01,
          approximateDistinctCount: 31_300_000,
        });
      render(<DataGrid source={byteArraySource} />);

      fireEvent.click(screen.getByRole("button", { name: "Schema" }));
      const sidebar = screen.getByRole("complementary", {
        name: "Schema sidebar",
      });
      fireEvent.click(within(sidebar).getByRole("button", { name: /label/ }));

      await waitFor(() =>
        expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 0, false),
      );
      expect(await within(sidebar).findByText("≈ 31.3M")).toBeInTheDocument();
      expect(within(sidebar).getByText("1%")).toBeInTheDocument();
      expect(within(sidebar).queryByText("Minimum")).not.toBeInTheDocument();
      expect(within(sidebar).queryByText("Maximum")).not.toBeInTheDocument();

      fireEvent.click(
        within(sidebar).getByRole("button", { name: "Compute min/max" }),
      );
      await waitFor(() =>
        expect(desktop.getColumnStatistics).toHaveBeenLastCalledWith(
          7,
          0,
          true,
        ),
      );
      expect(await within(sidebar).findByText("Minimum")).toBeInTheDocument();
      expect(within(sidebar).getByText("001")).toBeInTheDocument();
      expect(within(sidebar).getByText("zzz")).toBeInTheDocument();
      expect(
        within(sidebar).queryByRole("button", { name: "Compute min/max" }),
      ).not.toBeInTheDocument();
    },
  );

  it("computes numeric min and max immediately", async () => {
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_0/ }));

    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 0, true),
    );
    expect(await within(sidebar).findByText("Minimum")).toBeInTheDocument();
    expect(within(sidebar).getByText("1")).toBeInTheDocument();
    expect(within(sidebar).getByText("9")).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "Compute min/max" }),
    ).not.toBeInTheDocument();
  });

  it("lets the backend replace an active statistics scan", async () => {
    const firstStatistics = deferred<desktop.ColumnStatistics>();
    vi.mocked(desktop.getColumnStatistics)
      .mockReturnValueOnce(firstStatistics.promise)
      .mockResolvedValueOnce({
        minimum: "2",
        maximum: "8",
        minMaxComputed: true,
        nullShare: 0,
        approximateDistinctCount: 4,
      });
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_2/ }));
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 2, true),
    );
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_4/ }));
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 4, true),
    );

    expect(desktop.cancelColumnStatistics).not.toHaveBeenCalled();
    expect(await within(sidebar).findByText("≈ 4")).toBeInTheDocument();
  });

  it.each([
    ["unsupported", "Statistics are unavailable for this column."],
    [
      "resourceExhausted",
      "There is not enough memory to compute these statistics.",
    ],
    ["queryFailed", "Column statistics could not be computed."],
  ] as const)("shows a truthful %s statistics error", async (code, message) => {
    vi.mocked(desktop.getColumnStatistics).mockRejectedValueOnce(
      new desktop.ColumnStatisticsCommandError(code),
    );
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_1/ }));

    expect(await within(sidebar).findByText(message)).toHaveClass(
      "statistics-error",
    );
    expect(
      within(sidebar).queryByText(
        "The open Parquet file is damaged or incomplete.",
      ),
    ).not.toBeInTheDocument();
  });

  it("cancels a lazy scan while row windows continue loading", async () => {
    const statistics = deferred<desktop.ColumnStatistics>();
    vi.mocked(desktop.getColumnStatistics).mockReturnValue(statistics.promise);
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_3/ }));
    expect(
      await within(sidebar).findByRole("progressbar", {
        name: "Computing column statistics",
      }),
    ).not.toHaveAttribute("value");
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(7, 3, true),
    );

    act(() => {
      reportViewport({
        rowStart: 1_000,
        rowCount: 5,
        columnIndices: [0, 1, 2, 3],
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    vi.mocked(desktop.cancelColumnStatistics).mockClear();
    fireEvent.click(within(sidebar).getByRole("button", { name: "Cancel" }));
    expect(
      within(sidebar).getByText("Statistics cancelled."),
    ).toBeInTheDocument();
    expect(desktop.cancelColumnStatistics).toHaveBeenCalledWith(7);
  });

  it("keeps sidebar selection and statistics across shortcut toggles", async () => {
    render(<DataGrid source={source} />);

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_2/ }));
    expect(await within(sidebar).findByText("12.5%")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(sidebar).not.toBeVisible();
    fireEvent.keyDown(window, { key: "B", ctrlKey: true });
    expect(sidebar).toBeVisible();
    expect(within(sidebar).getByText("12.5%")).toBeInTheDocument();
    expect(
      within(sidebar).getByRole("button", { name: /column_2/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("DataGrid export", () => {
  it("exports the active filtered and sorted view revision", async () => {
    render(<DataGrid source={source} />);
    addNumberFilter("4");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [{ columnIndex: 0, operator: "equals", values: ["4"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(37));
    act(() => {
      gridMock.props?.onSort(1, false);
    });
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [{ columnIndex: 0, operator: "equals", values: ["4"] }],
        [{ sourceIndex: 1, direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    await waitFor(() =>
      expect(gridMock.props?.columns[1]?.sort.direction).toBe("ascending"),
    );

    openGridMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export current view \(37 rows\)/ }),
    );

    await waitFor(() =>
      expect(desktop.startDataExport).toHaveBeenCalledWith(7, 2, "view", {
        columnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
        rowRanges: [],
        output: { format: "csv", options: {} },
      }),
    );
  });

  it("exports multi-rectangle union rows by union columns in grid order", async () => {
    render(<DataGrid source={source} />);
    act(() => {
      gridMock.props?.onSelectionChange?.({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { column: 2, row: 5 },
          range: { x: 2, y: 5, width: 3, height: 2 },
          rangeStack: [{ x: 0, y: 1, width: 2, height: 2 }],
        },
      });
    });

    openGridMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export selection \(4 × 5\)/ }),
    );

    await waitFor(() =>
      expect(desktop.startDataExport).toHaveBeenCalledWith(
        7,
        0,
        "selection",
        expect.objectContaining({
          columnIndices: [0, 1, 2, 3, 4],
          rowRanges: [
            { start: 1, end: 3 },
            { start: 5, end: 7 },
          ],
        }),
      ),
    );
  });

  it("keeps large row selections while clipboard copying stays capped", async () => {
    render(<DataGrid source={{ ...source, rowCount: 100_000 }} />);
    act(() => {
      gridMock.props?.onSelectionChange?.({
        columns: CompactSelection.empty(),
        rows: CompactSelection.fromSingleSelection([0, 50_000]),
      });
    });

    expect(gridMock.props?.selection?.rows.length).toBe(50_000);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    vi.mocked(desktop.getDataWindow).mockClear();
    copyFromGrid();

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    const copied = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(copied.split("\n")).toHaveLength(10_000);
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(20);
    expect(
      screen.getByText(/limited to the first 10,000 rows/),
    ).toHaveAttribute("role", "status");

    openGridMenu();
    expect(
      screen.getByRole("menuitem", {
        name: /Export selection \(50,000 × 8\)/,
      }),
    ).toBeInTheDocument();
  });

  it("does not offer a window retry when capped clipboard copying fails", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<DataGrid source={{ ...source, rowCount: 100_000 }} />);
    act(() => {
      gridMock.props?.onSelectionChange?.({
        columns: CompactSelection.empty(),
        rows: CompactSelection.fromSingleSelection([0, 50_000]),
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    copyFromGrid();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The selection could not be copied.");
    expect(
      within(alert).queryByRole("button", { name: "Retry window" }),
    ).not.toBeInTheDocument();
  });

  it("uses the shortcut for selection and falls back to the current view", async () => {
    render(<DataGrid source={source} />);

    fireEvent.keyDown(window, { key: "e", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(desktop.startDataExport).toHaveBeenLastCalledWith(
        7,
        0,
        "view",
        expect.any(Object),
      ),
    );
    act(() => {
      gridMock.props?.onSelectionChange?.({
        columns: CompactSelection.empty(),
        rows: CompactSelection.fromSingleSelection([2, 5]),
      });
    });

    fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
    await waitFor(() =>
      expect(desktop.startDataExport).toHaveBeenLastCalledWith(
        7,
        0,
        "selection",
        expect.objectContaining({ rowRanges: [{ start: 2, end: 5 }] }),
      ),
    );
  });

  it("shows measured progress, blocks parallel exports, and cancels the job", async () => {
    vi.mocked(desktop.getDataExportStatus).mockResolvedValue({
      state: "running",
      id: 12,
      fileName: "large-view.csv",
      bytesWritten: 12_400,
    });
    render(<DataGrid source={source} />);

    expect(await screen.findByText(/12\.4 KB written/)).toBeInTheDocument();
    openGridMenu();
    const exportItem = screen.getByRole("menuitem", {
      name: /Exporting large-view\.csv \(12\.4 KB\)/,
    });
    expect(exportItem).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(desktop.cancelDataExport).toHaveBeenCalledWith(12),
    );
  });

  it("auto-dismisses a completed pill even when native dismissal fails", async () => {
    vi.useFakeTimers();
    vi.mocked(desktop.getDataExportStatus).mockResolvedValue({
      state: "completed",
      id: 9,
      fileName: "large-view.csv",
      bytesWritten: 2_500_000,
    });
    vi.mocked(desktop.dismissDataExport).mockRejectedValue(
      new Error("invoke failed"),
    );

    try {
      render(<DataGrid source={source} />);
      await act(async () => Promise.resolve());
      expect(
        screen.getByRole("button", { name: "Reveal in folder" }),
      ).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });

      expect(desktop.dismissDataExport).toHaveBeenCalledWith(9);
      expect(
        screen.queryByRole("button", { name: "Reveal in folder" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

function openColumnMenu(visibleIndex: number) {
  act(() => {
    gridMock.props?.onHeaderContextMenu(visibleIndex, {
      x: 20,
      y: 20,
      width: 120,
      height: 32,
    });
  });
}

function reportViewport(
  viewport: Pick<GridViewport, "rowStart" | "rowCount" | "columnIndices"> &
    Partial<
      Pick<
        GridViewport,
        "mountedRowStart" | "mountedRowCount" | "mountedColumnIndices"
      >
    >,
) {
  gridMock.props?.onViewportChange({
    ...viewport,
    mountedRowStart: viewport.mountedRowStart ?? viewport.rowStart,
    mountedRowCount: viewport.mountedRowCount ?? viewport.rowCount,
    mountedColumnIndices:
      viewport.mountedColumnIndices ?? viewport.columnIndices,
  });
}

function openSelectPicker() {
  const button = screen
    .getByLabelText("Query")
    .querySelector<HTMLButtonElement>(".query-select");
  if (button === null) {
    throw new Error("SELECT picker button is missing");
  }
  fireEvent.click(button);
  return screen.getByRole("dialog", { name: "SELECT columns" });
}

function openGridMenu() {
  act(() => {
    gridMock.props?.onCellContextMenu?.(
      { column: 0, row: 0 },
      { x: 20, y: 20, width: 120, height: 28 },
    );
  });
}

function addNumberFilter(value: string, visibleIndex = 0) {
  openFilterEditor(visibleIndex);
  const editor = screen.getByRole("form", {
    name: `Filter column_${visibleIndex}`,
  });
  fireEvent.change(within(editor).getByRole("textbox", { name: "Value" }), {
    target: { value },
  });
  fireEvent.click(
    within(editor).getByRole("button", { name: "Add condition" }),
  );
}

function openFilterEditor(visibleIndex: number) {
  act(() => {
    gridMock.props?.onFilter(visibleIndex, {
      x: 20,
      y: 20,
      width: 120,
      height: 32,
    });
  });
}

function copyFromGrid() {
  act(() => {
    gridMock.props?.onCopy(
      new Event("copy", { cancelable: true }) as ClipboardEvent,
    );
  });
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function desktopSelection(index?: number): CompactSelection {
  return index === undefined
    ? CompactSelection.empty()
    : CompactSelection.fromSingleSelection(index);
}
