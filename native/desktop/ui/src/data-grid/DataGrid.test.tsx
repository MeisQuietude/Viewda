import {
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
import { utf8 } from "@uwdata/flechette";
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
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 512);
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

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
