import {
  CompactSelection,
  GridCellKind,
  type DataEditorProps,
  type DataEditorRef,
} from "@glideapps/glide-data-grid";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TimeUnit, timestamp, utf8 } from "@uwdata/flechette";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { DataGrid } from "./DataGrid";
import type { ArrowDataWindow } from "./arrow-window";

const editorMock = vi.hoisted(() => ({
  props: undefined as DataEditorProps | undefined,
  scrollTo: vi.fn(),
  updateCells: vi.fn(),
}));

const decodeArrowWindow = vi.hoisted(() => vi.fn());

vi.mock("@glideapps/glide-data-grid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@glideapps/glide-data-grid")>();
  const React = await import("react");
  const MockDataEditor = React.forwardRef<DataEditorRef, DataEditorProps>(
    (props, ref) => {
      editorMock.props = props;
      React.useImperativeHandle(
        ref,
        () =>
          ({
            scrollTo: editorMock.scrollTo,
            updateCells: editorMock.updateCells,
          }) as unknown as DataEditorRef,
        [],
      );
      return <div data-testid="data-editor" />;
    },
  );
  return { ...actual, DataEditor: MockDataEditor };
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
  editorMock.props = undefined;
  editorMock.scrollTo.mockReset();
  editorMock.updateCells.mockReset();
  decodeArrowWindow.mockImplementation(
    (_bytes: ArrayBuffer, rowOffset: number): ArrowDataWindow => ({
      rowOffset,
      rowCount: 512,
      table: {
        schema: {
          fields: Array.from({ length: 8 }, () => ({ type: utf8() })),
        },
        getChildAt: () => ({ at: (row: number) => `row ${row}` }),
      } as unknown as ArrowDataWindow["table"],
    }),
  );
  vi.spyOn(desktop, "getDataWindow").mockResolvedValue(new ArrayBuffer(0));
  vi.spyOn(desktop, "getFilteredRowCount").mockResolvedValue(37);
  vi.spyOn(desktop, "cancelFilteredRowCount").mockResolvedValue();
  vi.spyOn(desktop, "getColumnStatistics").mockResolvedValue({
    minimum: "1",
    maximum: "9",
    minMaxComputed: true,
    nullShare: 0.125,
    approximateDistinctCount: 42,
  });
  vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataGrid window rendering", () => {
  it("damages the loaded visible cells so canvas loading gaps repaint", async () => {
    render(<DataGrid source={source} />);

    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalledOnce());
    editorMock.updateCells.mockClear();
    const visibleRegionChanged = editorMock.props?.onVisibleRegionChanged;
    expect(visibleRegionChanged).toBeTypeOf("function");
    act(() => {
      visibleRegionChanged?.({ x: 3, y: 1_000, width: 4, height: 5 }, 0, 0, {
        freezeRegions: [{ x: 0, y: 1_000, width: 1, height: 5 }],
      });
    });

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalledOnce());

    const damage = editorMock.updateCells.mock.calls[0]?.[0] as {
      cell: readonly [number, number];
    }[];
    expect(damage).toHaveLength(25);
    expect(damage).toContainEqual({ cell: [0, 1_000] });
    expect(damage).toContainEqual({ cell: [3, 1_000] });
    expect(damage).toContainEqual({ cell: [6, 1_004] });
    expect(damage).not.toContainEqual({ cell: [1, 1_000] });
  });

  it("keeps loaded cells populated without duplicate prefetches", async () => {
    render(<DataGrid source={source} />);

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 512, []);
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalledOnce());

    const nextWindow = deferred<ArrayBuffer>();
    vi.mocked(desktop.getDataWindow).mockImplementationOnce(
      () => nextWindow.promise,
    );
    const visibleRegionChanged = editorMock.props?.onVisibleRegionChanged;
    const getCellContent = editorMock.props?.getCellContent;
    act(() => {
      visibleRegionChanged?.({ x: 0, y: 400, width: 4, height: 5 }, 0, 0, {
        freezeRegions: [],
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      expect.any(Number),
      512,
      [],
    );

    act(() => {
      visibleRegionChanged?.({ x: 0, y: 401, width: 4, height: 5 }, 0, 0, {
        freezeRegions: [],
      });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);
    expect(getCellContent?.([0, 401]).kind).toBe(GridCellKind.Text);

    await act(async () => {
      nextWindow.resolve(new ArrayBuffer(0));
    });
    await waitFor(() =>
      expect(editorMock.updateCells).toHaveBeenCalledTimes(2),
    );
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);
  });

  it("keeps scrolling inside the grid without column snapping or overscroll", () => {
    render(<DataGrid source={source} />);

    expect(editorMock.props).toMatchObject({
      overscrollX: 0,
      overscrollY: 0,
      preventDiagonalScrolling: true,
      smoothScrollX: true,
      smoothScrollY: false,
    });
  });

  it("renders column headers with the UI font", () => {
    render(<DataGrid source={source} />);

    const drawHeader = editorMock.props?.drawHeader;
    const context = {
      font: '12px ui-monospace, "SFMono-Regular", Consolas, monospace',
    } as CanvasRenderingContext2D;
    const drawContent = vi.fn(() => {
      expect(context.font).toContain("Inter");
      expect(context.font).not.toContain("ui-monospace");
    });

    drawHeader?.(
      { ctx: context } as Parameters<NonNullable<typeof drawHeader>>[0],
      drawContent,
    );

    expect(drawContent).toHaveBeenCalledOnce();
  });

  it("always renders the path-free query row", () => {
    render(<DataGrid source={source} />);

    const query = screen.getByLabelText("Query");
    const expression = query.querySelector(".query-expression");
    expect(
      Array.from(expression?.children ?? [], (node) => node.textContent),
    ).toEqual(["SELECT", "*", "FROM", "this", "WHERE⋯", "ORDER BY", "⋯"]);
    expect(within(query).getByText("SELECT", { selector: "span" })).toHaveClass(
      "query-keyword",
    );
    expect(within(query).getByText("this")).toBeInTheDocument();
    expect(within(query).getByRole("button", { name: "⋯" })).toHaveClass(
      "query-empty-slot",
    );
    expect(query).not.toHaveTextContent(source.displayName);
    expect(query).toHaveTextContent("10,000 rows");
  });

  it("clamps the WHERE popup inside a narrow viewport", () => {
    vi.stubGlobal("innerWidth", 600);
    render(<DataGrid source={source} />);
    const wrap = document.querySelector(".query-where-wrap");
    vi.spyOn(wrap as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
      left: 520,
    } as DOMRect);

    fireEvent.click(screen.getByRole("button", { name: "⋯" }));

    expect(
      screen.getByRole("dialog", { name: "WHERE conditions" }),
    ).toHaveStyle({ left: "-504px" });
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
      screen.getByRole("button", { name: "Clear WHERE conditions" }),
    );

    expect(screen.getByLabelText("Query")).toHaveTextContent("[7/8 cols]");
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 42',
    );

    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(
      screen.getByLabelText("Query").querySelector(".query-slot"),
    ).toHaveTextContent("*");
  });

  it("knows an empty source has zero matches without loading or counting", () => {
    render(<DataGrid source={{ ...source, rowCount: 0 }} />);

    addNumberFilter("1");

    expect(
      screen.getByText("No rows match these conditions."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Query")).toHaveTextContent("0 rows");
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
    expect(desktop.getFilteredRowCount).not.toHaveBeenCalled();
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
    expect(screen.getByLabelText("Query")).toHaveTextContent('"column_0" = -7');

    fireEvent.click(screen.getByRole("button", { name: '"column_0" = -7' }));
    fireEvent.click(
      within(
        screen.getByRole("dialog", { name: "WHERE conditions" }),
      ).getByRole("button", { name: /Remove filter/ }),
    );
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = -7',
    );
  });

  it("bounds the grid to observed rows until the exact COUNT resolves", async () => {
    const count = deferred<number>();
    vi.mocked(desktop.getFilteredRowCount).mockReturnValueOnce(count.promise);
    render(<DataGrid source={source} />);

    addNumberFilter("1");

    await waitFor(() =>
      expect(desktop.getFilteredRowCount).toHaveBeenCalledOnce(),
    );
    expect(editorMock.props?.rows).toBe(512);
    expect(screen.getByLabelText("Query")).toHaveTextContent("counting…");

    await act(async () => count.resolve(37));

    await waitFor(() => expect(editorMock.props?.rows).toBe(37));
    expect(screen.getByLabelText("Query")).toHaveTextContent("37 rows");
  });

  it("uses a short first filtered window as the exact non-phantom total", async () => {
    decodeArrowWindow.mockImplementation(
      (_bytes: ArrayBuffer, rowOffset: number): ArrowDataWindow => ({
        rowOffset,
        rowCount: rowOffset === 0 ? 3 : 0,
        table: {
          schema: {
            fields: Array.from({ length: 8 }, () => ({ type: utf8() })),
          },
          getChildAt: () => ({ at: (row: number) => `row ${row}` }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(editorMock.props?.rows).toBe(10_000));

    addNumberFilter("1");

    await waitFor(() => expect(editorMock.props?.rows).toBe(3));
    expect(desktop.getFilteredRowCount).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Query")).toHaveTextContent("3 rows");
  });

  it("cancels the previous COUNT when filters change rapidly", async () => {
    const firstCount = deferred<number>();
    vi.mocked(desktop.getFilteredRowCount)
      .mockReturnValueOnce(firstCount.promise)
      .mockResolvedValueOnce(11);
    render(<DataGrid source={source} />);

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getFilteredRowCount).toHaveBeenCalledWith(7, 1, [
        { columnIndex: 0, operator: "equals", values: ["1"] },
      ]),
    );
    addNumberFilter("2", 1);

    await waitFor(() =>
      expect(desktop.cancelFilteredRowCount).toHaveBeenCalledWith(7, 1),
    );
    await waitFor(() =>
      expect(desktop.getFilteredRowCount).toHaveBeenLastCalledWith(7, 2, [
        { columnIndex: 0, operator: "equals", values: ["1"] },
        { columnIndex: 1, operator: "equals", values: ["2"] },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Query")).toHaveTextContent("11 rows"),
    );

    await act(async () => firstCount.resolve(99));

    expect(screen.getByLabelText("Query")).toHaveTextContent("11 rows");
  });

  it("does not apply a window returned for a stale filter revision", async () => {
    const staleWindow = deferred<ArrayBuffer>();
    const currentWindow = deferred<ArrayBuffer>();
    const initialBytes = new ArrayBuffer(1);
    const staleBytes = new ArrayBuffer(2);
    const currentBytes = new ArrayBuffer(3);
    vi.mocked(desktop.getDataWindow)
      .mockResolvedValueOnce(initialBytes)
      .mockReturnValueOnce(staleWindow.promise)
      .mockReturnValueOnce(currentWindow.promise);
    decodeArrowWindow.mockImplementation(
      (bytes: ArrayBuffer, rowOffset: number): ArrowDataWindow => ({
        rowOffset,
        rowCount: bytes === staleBytes ? 401 : bytes === currentBytes ? 2 : 512,
        table: {
          schema: {
            fields: Array.from({ length: 8 }, () => ({ type: utf8() })),
          },
          getChildAt: () => ({ at: (row: number) => `row ${row}` }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    addNumberFilter("1");
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    addNumberFilter("2", 1);
    await act(async () => staleWindow.resolve(staleBytes));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(3));
    expect(editorMock.props?.rows).not.toBe(401);

    await act(async () => currentWindow.resolve(currentBytes));
    await waitFor(() => expect(editorMock.props?.rows).toBe(2));
  });

  it("interrupts an active COUNT when the grid closes", async () => {
    const count = deferred<number>();
    vi.mocked(desktop.getFilteredRowCount).mockReturnValueOnce(count.promise);
    const { unmount } = render(<DataGrid source={source} />);
    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getFilteredRowCount).toHaveBeenCalledWith(7, 1, [
        { columnIndex: 0, operator: "equals", values: ["1"] },
      ]),
    );

    unmount();

    expect(desktop.cancelFilteredRowCount).toHaveBeenCalledWith(7, 1);
  });

  it("leaves counting state on COUNT failure and retries the same revision", async () => {
    vi.mocked(desktop.getFilteredRowCount).mockRejectedValueOnce(
      new desktop.DataWindowCommandError("queryEngineUnavailable"),
    );
    render(<DataGrid source={source} />);
    addNumberFilter("9");

    const retry = await screen.findByRole("button", { name: "retry" });
    expect(screen.getByLabelText("Query")).not.toHaveTextContent("counting…");

    fireEvent.click(retry);

    await waitFor(() =>
      expect(desktop.getFilteredRowCount).toHaveBeenCalledTimes(2),
    );
    expect(desktop.getFilteredRowCount).toHaveBeenLastCalledWith(7, 1, [
      { columnIndex: 0, operator: "equals", values: ["9"] },
    ]);
  });

  it("retries an unfiltered window without changing the row count or selection", async () => {
    vi.mocked(desktop.getDataWindow)
      .mockRejectedValueOnce(new desktop.DataWindowCommandError("queryFailed"))
      .mockResolvedValueOnce(new ArrayBuffer(0));
    render(<DataGrid source={source} />);
    const alert = await screen.findByRole("alert");
    expect(screen.getByLabelText("Query")).toHaveTextContent("10,000 rows");
    expect(
      within(screen.getByLabelText("Query")).queryByRole("button", {
        name: "retry",
      }),
    ).not.toBeInTheDocument();
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection(4),
    };
    act(() => editorMock.props?.onGridSelectionChange?.(selection));

    fireEvent.click(
      within(alert).getByRole("button", { name: "Retry window" }),
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(editorMock.props?.gridSelection).toEqual(selection),
    );
  });

  it("shows filter limits as guidance without discarding the AST", async () => {
    vi.mocked(desktop.getDataWindow)
      .mockResolvedValueOnce(new ArrayBuffer(0))
      .mockRejectedValueOnce(
        new desktop.DataWindowCommandError("invalidFilter"),
      );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    addNumberFilter("1");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match its column type or exceeds the limits",
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent('"column_0" = 1');
    expect(screen.getByLabelText("Query")).toHaveTextContent(
      "count unavailable",
    );
    expect(
      screen.getByRole("button", { name: "Retry window" }),
    ).toBeInTheDocument();
  });

  it("prefills a timestamp from its Arrow value instead of raw copy data", async () => {
    const raw =
      BigInt(new Date("2026-08-01T06:07:08.009Z").valueOf()) * 1_000n + 456n;
    decodeArrowWindow.mockImplementation(
      (_bytes: ArrayBuffer, rowOffset: number): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        table: {
          schema: {
            fields: [{ type: timestamp(TimeUnit.MICROSECOND, "UTC") }],
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
      editorMock.props?.onCellContextMenu?.([0, 0], {
        preventDefault: vi.fn(),
        bounds: { x: 20, y: 20, width: 120, height: 28 },
      } as never);
    });

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
    expect(editorMock.scrollTo).toHaveBeenCalledWith(0, 0, "horizontal", 16);
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 0, y: 1_000, width: 4, height: 5 },
        0,
        0,
        { freezeRegions: [] },
      );
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

function openColumnMenu(visibleIndex: number) {
  act(() => {
    editorMock.props?.onHeaderMenuClick?.(visibleIndex, {
      x: 20,
      y: 20,
      width: 120,
      height: 32,
    });
  });
}

function addNumberFilter(value: string, visibleIndex = 0) {
  openColumnMenu(visibleIndex);
  fireEvent.click(screen.getByRole("menuitem", { name: "Filter…" }));
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
