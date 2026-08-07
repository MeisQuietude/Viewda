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
import { THEME_CHANGED_EVENT } from "../theme";
import { DataGrid } from "./DataGrid";
import type { ArrowDataWindow } from "./arrow-window";

const editorMock = vi.hoisted(() => ({
  props: undefined as DataEditorProps | undefined,
  mountCount: 0,
  scrollTo: vi.fn(),
  updateCells: vi.fn(),
}));

const decodeArrowWindow = vi.hoisted(() => vi.fn());
const clipboardWrite = vi.fn();

vi.mock("@glideapps/glide-data-grid", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@glideapps/glide-data-grid")>();
  const React = await import("react");
  const MockDataEditor = React.forwardRef<DataEditorRef, DataEditorProps>(
    (props, ref) => {
      React.useEffect(() => {
        editorMock.mountCount += 1;
      }, []);
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
  editorMock.mountCount = 0;
  editorMock.scrollTo.mockReset();
  editorMock.updateCells.mockReset();
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
  vi.spyOn(desktop, "getColumnStatistics").mockResolvedValue({
    minimum: "1",
    maximum: "9",
    minMaxComputed: true,
    nullShare: 0.125,
    approximateDistinctCount: 42,
  });
  vi.spyOn(desktop, "cancelColumnStatistics").mockResolvedValue();
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataGrid window rendering", () => {
  it("refreshes canvas colors when the application theme changes", async () => {
    let color = "#111111";
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: () => color,
        }) as unknown as CSSStyleDeclaration,
    );
    render(<DataGrid source={source} />);

    expect(editorMock.props?.theme?.accentColor).toBe("#111111");
    color = "#222222";
    act(() => window.dispatchEvent(new Event(THEME_CHANGED_EVENT)));

    await waitFor(() =>
      expect(editorMock.props?.theme?.accentColor).toBe("#222222"),
    );
  });

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

  it("reloads only direct window columns when the horizontal viewport changes", async () => {
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 10, y: 0, width: 4, height: 5 },
        0,
        0,
        { freezeRegions: [{ x: 0, y: 0, width: 1, height: 5 }] },
      );
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 10, 11, 12, 13],
      ),
    );

    act(() => {
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 15, y: 0, width: 3, height: 5 },
        0,
        0,
        { freezeRegions: [{ x: 0, y: 0, width: 1, height: 5 }] },
      );
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        [0, 15, 16, 17],
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 10, y: 0, width: 4, height: 5 },
        0,
        0,
        { freezeRegions: [{ x: 0, y: 0, width: 1, height: 5 }] },
      );
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

    const getCellsForSelection = editorMock.props?.getCellsForSelection;
    expect(getCellsForSelection).toBeTypeOf("function");
    if (typeof getCellsForSelection !== "function") {
      return;
    }
    const selection = getCellsForSelection(
      { x: 2, y: 0, width: 2, height: 1 },
      new AbortController().signal,
    );
    await act(async () => {
      if (typeof selection === "function") {
        await selection();
      }
    });

    expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 512, [2, 3]);
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
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

    const getCellsForSelection = editorMock.props?.getCellsForSelection;
    expect(getCellsForSelection).toBeTypeOf("function");
    if (typeof getCellsForSelection !== "function") {
      return;
    }
    const selection = getCellsForSelection(
      { x: 2, y: 0, width: 2, height: 1 },
      new AbortController().signal,
    );
    await act(async () => {
      if (typeof selection === "function") {
        await selection();
      }
    });

    expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 1, 0, 37, [2, 3]);
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
      0,
      expect.any(Number),
      512,
      expect.any(Array),
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
      fillStyle: "",
      textAlign: "left",
      save: vi.fn(),
      restore: vi.fn(),
      fillText: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    const drawContent = vi.fn(() => {
      expect(context.font).toContain("Inter");
      expect(context.font).not.toContain("ui-monospace");
    });

    drawHeader?.(
      {
        ctx: context,
        menuBounds: { x: 100, y: 0, width: 20, height: 32 },
        rect: { x: 0, y: 0, width: 120, height: 32 },
        theme: { textLight: "#777" },
      } as Parameters<NonNullable<typeof drawHeader>>[0],
      drawContent,
    );

    expect(drawContent).toHaveBeenCalledOnce();
    expect(editorMock.props?.columns[0]?.icon).toBe("viewda-sort-neutral");
    const neutralIcon = editorMock.props?.headerIcons?.["viewda-sort-neutral"];
    expect(neutralIcon?.({ bgColor: "#123456", fgColor: "#ffffff" })).toContain(
      'stroke="#123456"',
    );
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
  });

  it("clamps the WHERE popup inside a narrow viewport", () => {
    vi.stubGlobal("innerWidth", 600);
    render(<DataGrid source={source} />);
    const wrap = document.querySelector(".query-where-wrap");
    vi.spyOn(wrap as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
      left: 520,
    } as DOMRect);

    fireEvent.click(
      within(wrap as HTMLDivElement).getByRole("button", { name: "⋯" }),
    );

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
      screen.getByLabelText("Query").querySelector(".query-slot"),
    ).toHaveTextContent("*");
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

  it("clamps narrow columns while keeping the title outside the left sort hitbox", () => {
    render(<DataGrid source={source} />);

    act(() => {
      editorMock.props?.onColumnResizeEnd?.(
        editorMock.props.columns[0]!,
        80,
        0,
        80,
      );
    });
    const resized = editorMock.props?.columns[0];
    expect(
      resized !== undefined && "width" in resized ? resized.width : 0,
    ).toBe(112);

    act(() => {
      editorMock.props?.onHeaderClicked?.(0, {
        bounds: { x: 0, y: 0, width: 80, height: 32 },
        localEventX: 40,
        isEdge: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
      } as never);
    });
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("sorts only from the header hotspot without suppressing column selection", async () => {
    render(<DataGrid source={source} />);
    const preventDefault = vi.fn();

    act(() => {
      editorMock.props?.onHeaderClicked?.(2, {
        bounds: { x: 0, y: 0, width: 120, height: 32 },
        localEventX: 16,
        isEdge: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault,
      } as never);
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
      expect(editorMock.props?.columns[2]?.title).toBe("column_2");
      expect(editorMock.props?.columns[2]?.icon).toBe("viewda-sort-ascending");
    });
    expect(preventDefault).not.toHaveBeenCalled();

    act(() => {
      editorMock.props?.onHeaderClicked?.(3, {
        bounds: { x: 0, y: 0, width: 120, height: 32 },
        localEventX: 16,
        isEdge: false,
        shiftKey: true,
        metaKey: false,
        ctrlKey: false,
        preventDefault,
      } as never);
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
      expect(editorMock.props?.columns[2]?.title).toBe("column_2");
      expect(editorMock.props?.columns[3]?.title).toBe("column_3");
      expect(editorMock.props?.columns[2]?.icon).toBe(
        "viewda-sort-ascending-1",
      );
      expect(editorMock.props?.columns[3]?.icon).toBe(
        "viewda-sort-ascending-2",
      );
    });
    const priorityIcon =
      editorMock.props?.headerIcons?.["viewda-sort-ascending-2"];
    const prioritySvg = priorityIcon?.({
      bgColor: "#123456",
      fgColor: "#ffffff",
    });
    expect(prioritySvg).toContain(">2</text>");
    expect(prioritySvg).toContain('fill="#123456"');

    act(() => {
      editorMock.props?.onGridSelectionChange?.({
        columns: desktopSelection(2),
        rows: desktopSelection(),
      });
    });
    expect(editorMock.props?.gridSelection?.columns.hasIndex(2)).toBe(true);

    vi.mocked(desktop.prepareDataView).mockClear();
    act(() => {
      editorMock.props?.onHeaderClicked?.(2, {
        bounds: { x: 0, y: 0, width: 120, height: 32 },
        localEventX: 56,
        isEdge: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault,
      } as never);
    });
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
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
    await waitFor(() => expect(editorMock.props?.rows).toBe(19));
    await act(async () => first.resolve({ revision: 1, rowCount: 99 }));
    expect(editorMock.props?.rows).toBe(19);
  });

  it("keeps sorting while a filter changes and clears both clauses together", async () => {
    render(<DataGrid source={source} />);
    act(() => {
      editorMock.props?.onHeaderClicked?.(2, {
        bounds: { x: 0, y: 0, width: 120, height: 32 },
        localEventX: 16,
        isEdge: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
      } as never);
    });
    await waitFor(() =>
      expect(editorMock.props?.columns[2]?.icon).toBe("viewda-sort-ascending"),
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
    expect(editorMock.props?.columns[2]?.title).toBe("column_2");
    expect(editorMock.props?.columns[2]?.icon).toBe("viewda-sort-neutral");
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
    expect(editorMock.props?.rows).toBe(10_000);
    expect(screen.getByLabelText("Query")).toHaveTextContent("preparing view…");
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 1',
    );

    await act(async () => preparation.resolve({ revision: 1, rowCount: 37 }));

    await waitFor(() => expect(editorMock.props?.rows).toBe(37));
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 0, y: 1_000, width: 4, height: 5 },
        0,
        0,
        { freezeRegions: [] },
      );
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
      editorMock.props?.onHeaderClicked?.(1, {
        bounds: { x: 0, y: 0, width: 120, height: 32 },
        localEventX: 16,
        isEdge: false,
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        preventDefault: vi.fn(),
      } as never);
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 0, y: 2_063_949, width: 4, height: 40 },
        0,
        0,
        { freezeRegions: [] },
      );
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
      editorMock.props?.onCellContextMenu?.([0, 2_063_949], {
        preventDefault: vi.fn(),
        bounds: { x: 20, y: 20, width: 120, height: 28 },
      } as never);
    });
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
    await waitFor(() => expect(editorMock.props?.rows).toBe(270_308));
    expect(editorMock.mountCount).toBe(2);
    expect(editorMock.scrollTo).toHaveBeenCalledWith(
      0,
      270_268,
      "vertical",
      0,
      0,
      { vAlign: "start" },
    );
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
      expect(editorMock.props?.getCellContent([0, 270_268]).kind).toBe(
        GridCellKind.Text,
      ),
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
    editorMock.updateCells.mockReset();
    await act(async () => staleWindow.resolve(new ArrayBuffer(2)));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(3));
    expect(editorMock.updateCells).not.toHaveBeenCalled();

    await act(async () => currentWindow.resolve(new ArrayBuffer(3)));
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalled());
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
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalled());
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
    expect(editorMock.props?.rows).toBe(10_000);
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
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalled());
    vi.mocked(desktop.getDataWindow).mockClear();
    addNumberFilter("9");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("could not be loaded");
    expect(editorMock.props?.rows).toBe(10_000);
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
      await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalled());

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
    act(() => editorMock.props?.onGridSelectionChange?.(selection));

    fireEvent.click(
      within(alert).getByRole("button", { name: "Retry window" }),
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(editorMock.props?.gridSelection).toEqual(selection),
    );
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
    expect(editorMock.props?.rows).toBe(source.rowCount);
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

    expect(editorMock.props?.rows).toBe(10_000);
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
    await waitFor(() => expect(editorMock.props?.rows).toBe(23));
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
      editorMock.props?.onVisibleRegionChanged?.(
        { x: 0, y: 1_000, width: 4, height: 5 },
        0,
        0,
        { freezeRegions: [] },
      );
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

function desktopSelection(index?: number): CompactSelection {
  return index === undefined
    ? CompactSelection.empty()
    : CompactSelection.fromSingleSelection(index);
}
