import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  binary,
  dictionary,
  int32,
  list,
  struct,
  tableFromArrays,
  tableToIPC,
  TimeUnit,
  timestamp,
  utf8,
} from "@uwdata/flechette";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { DataGrid } from "./DataGrid";
import type { ArrowDataWindow } from "./arrow-window";
import { formatFieldPath } from "./field-path";
import { CompactSelection, type GridSelection } from "./grid-model";
import {
  createGridPerformanceController,
  type GridDiagnosticsController,
} from "./grid-performance-report";
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
let diagnosticsController: GridDiagnosticsController | null = null;

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
  columnCount: 8,
  schema: Array.from({ length: 8 }, (_, index) => ({
    name: `column_${index}`,
    physicalType: "INT32",
    logicalType: null,
    children: [],
  })),
  schemaNodeCount: 8,
  schemaIsTruncated: false,
  stringsTruncated: false,
};

const nestedSource: desktop.SourceSummary = {
  ...source,
  displayName: "nested.parquet",
  rowCount: 4,
  columnCount: 3,
  schema: [
    {
      name: "id",
      physicalType: "INT64",
      logicalType: null,
      children: [],
    },
    {
      name: "profile",
      physicalType: "GROUP",
      logicalType: null,
      children: [
        {
          name: "city.name",
          physicalType: "BYTE_ARRAY",
          logicalType: "String",
          children: [],
        },
        {
          name: "address",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: 'postal"code',
              physicalType: "INT32",
              logicalType: null,
              children: [],
            },
            {
              name: "geo",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                {
                  name: "latitude",
                  physicalType: "DOUBLE",
                  logicalType: null,
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      name: "tail",
      physicalType: "BOOLEAN",
      logicalType: null,
      children: [],
    },
  ],
  schemaNodeCount: 8,
};

const jsonSource: desktop.SourceSummary = {
  ...source,
  displayName: "json.parquet",
  rowCount: 4,
  columnCount: 1,
  schema: [
    {
      name: "payload",
      physicalType: "BYTE_ARRAY",
      logicalType: "JSON",
      children: [],
    },
  ],
  schemaNodeCount: 1,
};

const jsonSchemaInference: desktop.JsonSchemaInference = {
  isSampleDerived: true,
  sampleRowLimit: 512,
  sampleValueByteLimit: 1_048_576,
  sampleValueCharacterLimit: 1_048_576,
  sampleTotalByteLimit: 16_777_216,
  sampleArrowByteLimit: 33_554_432,
  sampledRowCount: 4,
  sampledValueBytes: 120,
  hasMoreRows: false,
  isTruncated: false,
  invalidValueCount: 0,
  oversizedValueCount: 0,
  nodes: [
    {
      segment: { field: "items" },
      observedTypes: ["array"],
      effectiveType: null,
      children: [
        {
          segment: { index: 0 },
          observedTypes: ["object"],
          effectiveType: null,
          children: [
            {
              segment: { field: "amount" },
              observedTypes: ["number"],
              effectiveType: "number",
              children: [],
            },
            {
              segment: { field: "mixed.value" },
              observedTypes: ["number", "string"],
              effectiveType: "mixed",
              children: [],
            },
          ],
        },
      ],
    },
  ],
};

const fieldColumnOffsets = (fieldPaths: readonly desktop.FieldPath[]) =>
  new Map(
    fieldPaths.map((fieldPath, offset) => [JSON.stringify(fieldPath), offset]),
  );

const sourceFieldPaths = (indices: readonly number[]) =>
  indices.map((index) => [`column_${index}`]);

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
      fieldPaths: readonly desktop.FieldPath[],
    ): ArrowDataWindow => {
      const offsets = fieldColumnOffsets(fieldPaths);
      return {
        rowOffset,
        rowCount:
          vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[3] ?? 512,
        fieldPaths,
        fieldColumnOffsets: offsets,
        table: {
          schema: {
            fields: Array.from({ length: fieldPaths.length }, () => ({
              type: utf8(),
            })),
          },
          getChildAt: () => ({ at: (row: number) => `row ${row}` }),
        } as unknown as ArrowDataWindow["table"],
      };
    },
  );
  vi.spyOn(desktop, "getDataWindow").mockResolvedValue(new ArrayBuffer(0));
  vi.spyOn(desktop, "getSourceSchemaPage").mockResolvedValue({
    offset: source.schema.length,
    totalCount: source.schema.length,
    columns: [],
  });
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
  vi.spyOn(desktop, "inferJsonSchema").mockResolvedValue(jsonSchemaInference);
  vi.spyOn(desktop, "cancelTextValueSuggestions").mockResolvedValue();
  vi.spyOn(desktop, "getColumnStatistics").mockResolvedValue({
    minimum: "1",
    maximum: "9",
    minMaxComputed: true,
    nullCount: 1_250,
    nullShare: 0.125,
    approximateDistinctCount: 42,
    containerCount: null,
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
  diagnosticsController?.dispose();
  diagnosticsController = null;
  cleanup();
  document.documentElement.style.removeProperty("--font-ui");
  document.documentElement.style.removeProperty("--font-mono");
  Reflect.deleteProperty(document, "fonts");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DataGrid window rendering", () => {
  it("does not build request diagnostics while recording is inactive", async () => {
    diagnosticsController = createGridPerformanceController();
    const queueRequest = vi.spyOn(diagnosticsController.sink, "queueRequest");

    render(
      <DataGrid source={source} diagnostics={diagnosticsController.sink} />,
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(queueRequest).not.toHaveBeenCalled();
  });

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
        sourceFieldPaths([0, 1, 2, 3, 4, 5, 6, 7]),
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
        10,
        sourceFieldPaths([8, 9, 10, 11, 12, 13, 14, 15, 16]),
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
        10,
        sourceFieldPaths([12, 13, 14, 15, 16, 17, 18, 19]),
      ),
    );
    expect(gridMock.props?.getCellContent({ row: 0, column: 0 }).kind).toBe(
      "text",
    );
    expect(gridMock.props?.getCellContent({ row: 0, column: 12 }).kind).toBe(
      "text",
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("loads a bounded schema page and fetches a column beyond the open prefix", async () => {
    const prefix = Array.from({ length: 256 }, (_, index) => ({
      ...source.schema[0]!,
      name: `column_${index}`,
    }));
    const wideSource = {
      ...source,
      columnCount: 300,
      schema: prefix,
      schemaNodeCount: 300,
      schemaIsTruncated: true,
    };
    vi.mocked(desktop.getSourceSchemaPage).mockResolvedValue({
      offset: 256,
      totalCount: 300,
      columns: Array.from({ length: 44 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${256 + index}`,
      })),
    });

    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    vi.mocked(desktop.getDataWindow).mockClear();

    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 256, 256),
    );
    expect(
      screen.queryByRole("button", { name: "Load more columns" }),
    ).not.toBeInTheDocument();

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 5,
        columnIndices: [299],
        mountedColumnIndices: [299],
      });
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        0,
        10,
        sourceFieldPaths([299]),
      ),
    );
  });

  it("keeps Peek open when pagination appends an unrelated trailing column", async () => {
    const page =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    vi.mocked(desktop.getSourceSchemaPage).mockReturnValue(page.promise);
    render(
      <DataGrid
        source={{
          ...source,
          rowCount: 1,
          columnCount: 2,
          schema: [source.schema[0]!],
          schemaNodeCount: 2,
          schemaIsTruncated: true,
        }}
      />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      const address = { column: 0, row: 0 };
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: address,
          range: { x: 0, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      });
      gridMock.props?.onCellPeek?.(address, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(screen.getByRole("dialog", { name: "Peek column_0" })).toBeVisible();

    await act(async () =>
      page.resolve({
        offset: 1,
        totalCount: 2,
        columns: [{ ...source.schema[1]!, name: "trailing" }],
      }),
    );

    await waitFor(() => expect(gridMock.props?.columns).toHaveLength(2));
    expect(screen.getByRole("dialog", { name: "Peek column_0" })).toBeVisible();
  });

  it("discards a delayed schema page when complete content replaces the preview", async () => {
    const earlyPrefix = Array.from({ length: 256 }, (_, index) => ({
      ...source.schema[0]!,
      name: `column_${index}`,
    }));
    const completePrefix = Array.from({ length: 300 }, (_, index) => ({
      ...source.schema[0]!,
      name: `column_${index}`,
    }));
    const stalePage =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    const activePage =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    vi.mocked(desktop.getSourceSchemaPage).mockImplementation(
      (_generation, offset) => {
        if (offset === 256) return stalePage.promise;
        if (offset === 300) return activePage.promise;
        throw new Error(`Unexpected schema page offset: ${offset}`);
      },
    );
    const view = render(
      <DataGrid
        source={{
          ...source,
          columnCount: 600,
          schema: earlyPrefix,
          schemaNodeCount: 600,
          schemaIsTruncated: true,
        }}
        contentIdentity="early-sample"
      />,
    );
    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 256, 256),
    );

    view.rerender(
      <DataGrid
        source={{
          ...source,
          columnCount: 320,
          schema: completePrefix,
          schemaNodeCount: 320,
          schemaIsTruncated: true,
        }}
        contentIdentity="complete"
      />,
    );

    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 300, 256),
    );
    await act(async () =>
      stalePage.resolve({
        offset: 256,
        totalCount: 600,
        columns: Array.from({ length: 256 }, (_, index) => ({
          ...source.schema[0]!,
          name: `stale_${256 + index}`,
        })),
      }),
    );

    view.rerender(
      <DataGrid
        source={{
          ...source,
          columnCount: 320,
          schema: completePrefix,
          schemaNodeCount: 320,
          schemaIsTruncated: true,
        }}
        contentIdentity="complete"
        active={false}
      />,
    );
    view.rerender(
      <DataGrid
        source={{
          ...source,
          columnCount: 320,
          schema: completePrefix,
          schemaNodeCount: 320,
          schemaIsTruncated: true,
        }}
        contentIdentity="complete"
      />,
    );

    expect(desktop.getSourceSchemaPage).toHaveBeenCalledTimes(2);
    await act(async () =>
      activePage.resolve({
        offset: 300,
        totalCount: 320,
        columns: Array.from({ length: 20 }, (_, index) => ({
          ...source.schema[0]!,
          name: `column_${300 + index}`,
        })),
      }),
    );
    await waitFor(() => expect(gridMock.props?.columns).toHaveLength(320));
    expect(gridMock.props?.columns).toHaveLength(320);
    expect(gridMock.props?.columns[256]?.title).toBe("column_256");
    expect(gridMock.props?.columns.at(-1)?.title).toBe("column_319");
  });

  it("collapses flattened paths when a later schema page reveals duplicate roots", async () => {
    const prefix = Array.from({ length: 256 }, (_, index) => ({
      ...source.schema[0]!,
      name: `column_${index}`,
      ...(index === 0
        ? {
            physicalType: "GROUP",
            children: [
              { ...source.schema[0]!, name: "left" },
              { ...source.schema[0]!, name: "right" },
            ],
          }
        : {}),
    }));
    const wideSource: desktop.SourceSummary = {
      ...source,
      columnCount: 300,
      schema: prefix,
      schemaNodeCount: 302,
      schemaIsTruncated: true,
    };
    const page =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    vi.mocked(desktop.getSourceSchemaPage).mockReturnValue(page.promise);

    render(<DataGrid source={wideSource} />);
    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 256, 256),
    );
    act(() => gridMock.props?.onColumnResize(0, 240));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    expect(gridMock.props?.columns).toHaveLength(257);
    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [{ fieldPath: ["column_0", "left"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );

    await act(async () =>
      page.resolve({
        offset: 256,
        totalCount: 300,
        columns: Array.from({ length: 44 }, (_, index) => ({
          ...source.schema[0]!,
          name: index === 0 ? "column_0" : `column_${256 + index}`,
        })),
      }),
    );

    await waitFor(() => expect(gridMock.props?.columns).toHaveLength(300));
    expect(gridMock.props?.columns[0]).toMatchObject({
      id: "source:0",
      width: 240,
      pinned: true,
      sort: { direction: "neutral" },
    });
    expect(gridMock.props?.columns[256]?.id).toBe("source:256");
    expect(gridMock.props?.columns.at(-1)?.title).toBe("column_299");
    expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1);
    expect(screen.getByText(/This file repeats column names/)).toBeVisible();
    await waitFor(() =>
      expect(
        vi.mocked(desktop.getDataWindow).mock.calls.some((call) => {
          const fieldPaths = call[4];
          return (
            call[1] === 0 &&
            fieldPaths.length === 300 &&
            fieldPaths[0]?.[0] === "column_0" &&
            fieldPaths[256]?.[0] === "column_0"
          );
        }),
      ).toBe(true),
    );
  });

  it("loads every schema page before requesting duplicate-name identity columns", async () => {
    const prefix = Array.from({ length: 256 }, (_, index) => ({
      ...source.schema[0]!,
      name: `column_${index}`,
    }));
    const wideSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 600,
      schema: prefix,
      schemaNodeCount: 600,
      schemaIsTruncated: true,
    };
    const secondPage =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    const thirdPage =
      deferred<Awaited<ReturnType<typeof desktop.getSourceSchemaPage>>>();
    vi.mocked(desktop.getSourceSchemaPage).mockImplementation(
      (_generation, offset) => {
        if (offset === 256) return secondPage.promise;
        if (offset === 512) return thirdPage.promise;
        throw new Error(`Unexpected schema page offset: ${offset}`);
      },
    );
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 4,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({ type: utf8() })),
          },
          getChildAt: (offset: number) => ({
            at: () => `source ${offset}`,
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );

    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 256, 256),
    );
    const windowCallsBeforeDuplicate = vi.mocked(desktop.getDataWindow).mock
      .calls.length;

    await act(async () =>
      secondPage.resolve({
        offset: 256,
        totalCount: 600,
        columns: Array.from({ length: 256 }, (_, index) => ({
          ...source.schema[0]!,
          name: index === 0 ? "column_0" : `column_${256 + index}`,
        })),
      }),
    );

    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 512, 256),
    );
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(
      windowCallsBeforeDuplicate,
    );
    expect(
      screen.queryByRole("button", { name: "Load more columns" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Viewda is loading every column before showing rows/),
    ).toBeVisible();
    expect(
      screen.getByText("Preparing columns…").closest('[role="status"]'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("viewda-grid")).not.toBeInTheDocument();

    const identityPaths = Array.from({ length: 600 }, (_, index) => [
      index === 256 ? "column_0" : `column_${index}`,
    ]);
    await act(async () =>
      thirdPage.resolve({
        offset: 512,
        totalCount: 600,
        columns: Array.from({ length: 88 }, (_, index) => ({
          ...source.schema[0]!,
          name: `column_${512 + index}`,
        })),
      }),
    );

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        0,
        4,
        identityPaths,
      ),
    );
    expect(desktop.getSourceSchemaPage).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(desktop.getDataWindow)
        .mock.calls.some(
          (call) =>
            call[4].length > 256 && call[4].length < identityPaths.length,
        ),
    ).toBe(false);
    expect(gridMock.props?.columns).toHaveLength(600);
    expect(gridMock.props?.columns[0]?.id).toBe("source:0");
    expect(gridMock.props?.columns[256]?.id).toBe("source:256");
    expect(gridMock.props?.getCellContent({ column: 0, row: 0 })).toMatchObject(
      { displayData: "source 0" },
    );
    expect(
      gridMock.props?.getCellContent({ column: 256, row: 0 }),
    ).toMatchObject({ displayData: "source 256" });
  });

  it("retries failed duplicate-name pagination without partial identity reads", async () => {
    const prefix = Array.from({ length: 256 }, (_, index) => ({
      ...source.schema[0]!,
      name: index === 1 ? "column_0" : `column_${index}`,
    }));
    const wideSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 600,
      schema: prefix,
      schemaNodeCount: 600,
      schemaIsTruncated: true,
    };
    let firstPageAttempt = true;
    vi.mocked(desktop.getSourceSchemaPage).mockImplementation(
      (_generation, offset) => {
        if (offset === 256 && firstPageAttempt) {
          firstPageAttempt = false;
          return Promise.reject(new Error("schema page unavailable"));
        }
        if (offset === 256) {
          return Promise.resolve({
            offset: 256,
            totalCount: 600,
            columns: Array.from({ length: 256 }, (_, index) => ({
              ...source.schema[0]!,
              name: `column_${256 + index}`,
            })),
          });
        }
        if (offset === 512) {
          return Promise.resolve({
            offset: 512,
            totalCount: 600,
            columns: Array.from({ length: 88 }, (_, index) => ({
              ...source.schema[0]!,
              name: `column_${512 + index}`,
            })),
          });
        }
        throw new Error(`Unexpected schema page offset: ${offset}`);
      },
    );

    render(<DataGrid source={wideSource} />);

    const retry = await screen.findByRole("button", {
      name: "Retry loading columns",
    });
    expect(desktop.getSourceSchemaPage).toHaveBeenCalledTimes(1);
    expect(desktop.getSourceSchemaPage).toHaveBeenLastCalledWith(7, 256, 256);
    expect(desktop.getDataWindow).not.toHaveBeenCalled();

    fireEvent.click(retry);

    const identityPaths = Array.from({ length: 600 }, (_, index) => [
      index === 1 ? "column_0" : `column_${index}`,
    ]);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        0,
        4,
        identityPaths,
      ),
    );
    expect(desktop.getSourceSchemaPage).toHaveBeenNthCalledWith(2, 7, 256, 256);
    expect(desktop.getSourceSchemaPage).toHaveBeenNthCalledWith(3, 7, 512, 256);
    expect(desktop.getSourceSchemaPage).toHaveBeenCalledTimes(3);
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(1);
    expect(vi.mocked(desktop.getDataWindow).mock.calls[0]?.[4]).toHaveLength(
      600,
    );
  });

  it("does not offer top-level columns when only a nested schema prefix is truncated", async () => {
    const nestedSource = {
      ...source,
      columnCount: 1,
      schema: [
        {
          name: "wrapper",
          physicalType: "GROUP",
          logicalType: null,
          children: [],
        },
      ],
      schemaNodeCount: 302,
      schemaIsTruncated: true,
    };
    vi.mocked(desktop.getSourceSchemaPage).mockResolvedValue({
      offset: 1,
      totalCount: 1,
      columns: [],
    });

    render(<DataGrid source={nestedSource} />);

    await waitFor(() =>
      expect(desktop.getSourceSchemaPage).toHaveBeenCalledWith(7, 1, 256),
    );
    expect(
      screen.queryByRole("button", { name: "Load more columns" }),
    ).not.toBeInTheDocument();
  });

  it("loads only viewport and frozen columns from a prepared view", async () => {
    diagnosticsController = createGridPerformanceController();
    const wideSource = {
      ...source,
      schema: Array.from({ length: 20 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(
      <DataGrid source={wideSource} diagnostics={diagnosticsController.sink} />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    diagnosticsController.start({
      runtime: {
        appVersion: "test",
        queryEngineVersion: "test",
        userAgent: "test",
        platform: "test",
        theme: "light",
      },
      source: { sizeBytes: 1, rowCount: 10_000, columnCount: 20 },
    });

    addNumberFilter("1");
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        1,
        expect.any(Number),
        37,
        sourceFieldPaths([0, 1, 2, 3, 4, 5, 6, 7]),
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
        10,
        sourceFieldPaths([10, 11, 12, 13]),
      ),
    );
    const recentRequests = JSON.parse(diagnosticsController.stop() ?? "null")
      .dataWindows.recentRequests;
    expect(recentRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "initial",
          filtered: true,
          sorted: false,
          projectionKey: expect.any(String),
        }),
        expect.objectContaining({
          reason: "columnProjection",
          filtered: true,
          sorted: false,
          projectionKey: expect.any(String),
        }),
      ]),
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
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        0,
        0,
        512,
        sourceFieldPaths([2, 3]),
      ),
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
      sourceFieldPaths([0, 1, 2, 3, 4]),
    );
    const copied = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(copied.split("\n")).toEqual([
      "row 1\trow 1\trow 1\trow 1\trow 1",
      "row 2\trow 2\trow 2\trow 2\trow 2",
      "row 5\trow 5\trow 5\trow 5\trow 5",
      "row 6\trow 6\trow 6\trow 6\trow 6",
    ]);
  });

  it("formats scalar range cells only through the copy boundary", async () => {
    const toString = vi.fn(() => "raw");
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 512,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({ type: utf8() })),
          },
          getChildAt: () => ({ at: () => ({ toString }) }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 0 },
          range: { x: 0, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      });
    });

    copyFromGrid();

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith("raw"));
    expect(toString).toHaveBeenCalledOnce();
  });

  it("copies cached dictionary strings and binary through multiple scheduler ticks", async () => {
    const text = `prefix-${"x".repeat(3 * 1024 * 1024)}-tail`;
    const payload = new Uint8Array(2 * 1024 * 1024);
    const bytes = tableToIPC(
      tableFromArrays(
        { text: [text], payload: [payload] },
        {
          types: {
            text: dictionary(utf8()),
            payload: dictionary(binary()),
          },
        },
      ),
      { format: "stream" },
    );
    const actualArrowWindow =
      await vi.importActual<typeof import("./arrow-window")>("./arrow-window");
    decodeArrowWindow.mockImplementation(actualArrowWindow.decodeArrowWindow);
    vi.mocked(desktop.getDataWindow).mockResolvedValue(
      Uint8Array.from(bytes!).buffer,
    );
    const dictionarySource: desktop.SourceSummary = {
      ...source,
      rowCount: 1,
      columnCount: 2,
      schema: source.schema.slice(0, 2),
      schemaNodeCount: 2,
    };
    render(<DataGrid source={dictionarySource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 0 },
          range: { x: 0, y: 0, width: 2, height: 1 },
          rangeStack: [],
        },
      });
    });

    const schedule = vi.spyOn(globalThis, "setTimeout");
    try {
      copyFromGrid();
      expect(clipboardWrite).not.toHaveBeenCalled();
      await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce(), {
        timeout: 5_000,
      });

      expect(
        schedule.mock.calls.filter(([, delay]) => delay === 0).length,
      ).toBeGreaterThan(1);
      const base64 = `${"AAAA".repeat(Math.floor(payload.length / 3))}AAA=`;
      expect(clipboardWrite).toHaveBeenCalledWith(`${text}\t${base64}`);
    } finally {
      schedule.mockRestore();
    }
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
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        1,
        0,
        37,
        sourceFieldPaths([2, 3]),
      ),
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

  it("lets only the latest copy write after a shared delayed window resolves", async () => {
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
          cell: { row: 1_000, column: 0 },
          range: { x: 0, y: 1_000, width: 1, height: 1 },
          rangeStack: [],
        },
      });
    });

    copyFromGrid();
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    copyFromGrid();
    copyWindow.resolve(new ArrayBuffer(0));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
  });

  it("keeps loaded cells populated without duplicate prefetches", async () => {
    render(<DataGrid source={source} />);

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      0,
      512,
      sourceFieldPaths([0, 1, 2, 3, 4, 5, 6, 7]),
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
      id: '["column_0"]',
      title: "column_0",
      monospace: false,
      pinned: false,
      pending: false,
      sortable: true,
      filterable: true,
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
      sourceFieldPaths([2, 0, 1, 3, 4, 5, 6]),
    );
    expect(desktop.getDataWindow).toHaveBeenNthCalledWith(
      2,
      7,
      0,
      0,
      64,
      sourceFieldPaths([2, 0, 1, 3, 4, 5, 6]),
    );
    expect(gridMock.props?.columns[0]?.id).toBe('["column_2"]');

    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    const restored = gridMock.props?.columns.find(
      (column) => column.id === '["column_7"]',
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
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 2,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map((fieldPath) => ({
              type: fieldPath.at(-1) === "number" ? int32() : utf8(),
            })),
          },
          getChildAt: (columnOffset: number) => ({
            at: () =>
              fieldPaths[columnOffset]?.at(-1) === "number"
                ? 123_456
                : "wide label",
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
    expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 2, [
      ["number"],
      ["label"],
    ]);
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
    expect(within(popup).getByText("No conditions yet.")).toBeVisible();
    expect(popup).toHaveClass("is-empty");
    expect(popup).toHaveStyle({ left: "444px", top: "88px" });
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
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7 cols]");

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
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7 cols]");

    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("*");
  });

  it("starts an exact virtual provenance column visible and pinned but still mutable", async () => {
    const pinned = new Set([7]);
    const view = render(
      <DataGrid
        source={source}
        contentIdentity="early-sample"
        defaultPinnedSourceIndices={pinned}
      />,
    );

    expect(screen.getByLabelText("Query")).toHaveTextContent("[8 cols]");
    expect(gridMock.props?.columns[0]).toMatchObject({
      title: "column_7",
      pinned: true,
    });
    const picker = openSelectPicker();
    expect(
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
    ).toBeChecked();
    const unpin = within(picker).getByRole("button", {
      name: "Unpin column_7",
    });
    fireEvent.click(unpin);
    expect(gridMock.props?.columns[7]).toMatchObject({
      title: "column_7",
      pinned: false,
    });
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7 cols]");

    view.rerender(
      <DataGrid
        source={{ ...source, rowCount: source.rowCount + 1 }}
        contentIdentity="complete"
        defaultPinnedSourceIndices={pinned}
      />,
    );
    expect(
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
    ).not.toBeChecked();
    expect(
      within(picker).queryByRole("button", { name: "Pin column_7" }),
    ).toBeNull();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
    );
    await waitFor(() =>
      expect(
        within(picker).getByRole("button", { name: "Pin column_7" }),
      ).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("recursively flattens structs into full grid columns and restores their ancestor", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const addressType = struct({
      'postal"code': int32(),
      geo: struct({ latitude: int32() }),
    });
    const profileType = struct({
      "city.name": utf8(),
      address: addressType,
    });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 4,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map((fieldPath) => ({
              type:
                fieldPath.length === 1 && fieldPath[0] === "profile"
                  ? profileType
                  : fieldPath.at(-1) === "address"
                    ? addressType
                    : fieldPath.at(-1) === "geo"
                      ? struct({ latitude: int32() })
                      : fieldPath.at(-1) === 'postal"code'
                        ? int32()
                        : utf8(),
            })),
          },
          getChildAt: () => ({ at: () => null }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={nestedSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => gridMock.props?.onColumnResize(1, 240));
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("[3 cols]");
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveAttribute("title", '"profile", "id", "tail"');
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    expect(gridMock.props?.columns.slice(0, 2)).toMatchObject([
      {
        id: '["profile","city.name"]',
        title: 'profile."city.name"',
        titlePrefix: "profile.",
        titleLeaf: '"city.name"',
        width: 240,
        pinned: true,
        sortable: true,
        filterable: true,
        groupRail: {
          title: "profile · struct<…>",
          start: true,
          end: false,
        },
      },
      {
        id: '["profile","address"]',
        width: 240,
        pinned: true,
        groupRail: {
          title: "profile · struct<…>",
          start: false,
          end: true,
        },
      },
    ]);
    expect(
      screen.getByText(/Flattened profile into 2 columns\./),
    ).toBeVisible();
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("[4 cols]");
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveAttribute(
      "title",
      '"profile"."city.name", "profile"."address", "id", "tail"',
    );

    const picker = openSelectPicker();
    expect(
      within(picker).getByRole("checkbox", {
        name: 'Project profile."city.name"',
      }),
    ).toBeChecked();
    expect(
      within(picker).getByRole("button", {
        name: 'Unpin profile."city.name"',
      }),
    ).toHaveAttribute("aria-pressed", "true");
    const pickerPath = within(picker)
      .getByRole("checkbox", { name: 'Project profile."city.name"' })
      .closest(".column-picker-row")!;
    expect(pickerPath.querySelector(".column-picker-name")).toHaveTextContent(
      'profile."city.name"',
    );
    expect(pickerPath).toHaveAttribute("aria-level", "2");
    fireEvent.click(
      screen.getByLabelText("Query").querySelector(".query-select")!,
    );

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin column" }));
    expect(gridMock.props?.columns[0]?.id).toBe('["profile","address"]');

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    const addressNode = within(sidebar).getByText("address").closest("li");
    if (addressNode === null) throw new Error("address schema node is missing");
    fireEvent.contextMenu(
      within(addressNode).getByText("address").closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Flatten profile.address" }),
    );
    fireEvent.contextMenu(
      within(addressNode).getByText("address").closest("button")!,
    );
    expect(
      screen.getByRole("menuitem", {
        name: "Unflatten profile.address",
      }),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(gridMock.scrollToColumn).toHaveBeenLastCalledWith(0, 16),
    );
    expect(gridMock.props?.selection.columns.hasIndex(0)).toBe(true);

    expect(gridMock.props?.columns.slice(0, 2)).toMatchObject([
      {
        id: '["profile","address","postal\\"code"]',
        titlePrefix: "profile.address.",
        titleLeaf: '"postal""code"',
        width: 240,
        pinned: true,
        groupRail: {
          title: "profile · struct<…>",
          start: true,
          end: false,
        },
      },
      {
        id: '["profile","address","geo"]',
        width: 240,
        pinned: true,
        groupRail: {
          title: "profile · struct<…>",
          start: false,
          end: true,
        },
      },
    ]);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        ["profile", "address", 'postal"code'],
        ["profile", "address", "geo"],
        ["id"],
        ["profile", "city.name"],
        ["tail"],
      ]),
    );
    gridMock.scrollToColumn.mockClear();
    fireEvent.click(
      within(sidebar)
        .getByText("profile", { selector: ".schema-name" })
        .closest("button")!,
    );
    expect(gridMock.scrollToColumn).toHaveBeenLastCalledWith(0, 16);
    expect(gridMock.props?.selection.columns.hasIndex(0)).toBe(true);

    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [
          {
            fieldPath: ["profile", "address", 'postal"code'],
            direction: "ascending",
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );
    openFilterEditor(0);
    const editor = screen.getByRole("form", {
      name: 'Filter profile.address."postal""code"',
    });
    fireEvent.change(within(editor).getByLabelText("Condition"), {
      target: { value: "isNull" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [
          {
            fieldPath: ["profile", "address", 'postal"code'],
            operator: "isNull",
            values: [],
          },
        ],
        [
          {
            fieldPath: ["profile", "address", 'postal"code'],
            direction: "ascending",
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );

    openColumnMenu(0);
    expect(
      screen.queryByRole("menuitem", {
        name: "Unflatten profile.address",
      }),
    ).toBeNull();
    const ancestorMenu = screen.getByRole("menu", {
      name: 'profile.address."postal""code" column',
    });
    expect(
      within(ancestorMenu).getAllByRole("menuitem", {
        name: /^Unflatten /,
      }),
    ).toHaveLength(1);
    const separators = within(ancestorMenu).getAllByRole("separator");
    expect(separators).toHaveLength(2);
    separators.forEach((separator) =>
      expect(separator).toHaveClass("grid-menu-separator"),
    );
    const unflatten = screen.getByRole("menuitem", {
      name: "Unflatten profile",
    });
    expect(unflatten).toHaveTextContent("3 columns → 1");
    expect(unflatten).toHaveTextContent("removes 1 filter");
    expect(unflatten).toHaveTextContent("removes 1 sort");
    expect(unflatten).toHaveAccessibleDescription(
      "3 columns → 1 · removes 1 filter · removes 1 sort",
    );
    fireEvent.click(unflatten);

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(7, 3, [], [], {
        memoryLimit: "mb384",
      }),
    );
    const unflattenAlert = screen.getByRole("alert");
    expect(unflattenAlert).toHaveClass("grid-error", "view-error");
    expect(unflattenAlert).toHaveTextContent(
      'Unflattened profile into one column; removed filters: profile.address."postal""code"; sorts: profile.address."postal""code".',
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["profile"]',
      '["id"]',
      '["tail"]',
    ]);
    expect(gridMock.props?.columns[0]).toMatchObject({
      width: 240,
      pinned: true,
    });
    expect(gridMock.mountCount).toBe(1);
    expect(gridMock.scrollToRow).not.toHaveBeenCalled();
    expect(gridMock.scrollToColumn).toHaveBeenCalledWith(0, 16);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 3, 0, 4, [
        ["profile"],
        ["id"],
        ["tail"],
      ]),
    );
  });

  it("projects arbitrary leaves from different schema branches in schema order", async () => {
    const projectionSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 3,
      schemaNodeCount: 9,
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "first" },
            { ...source.schema[0]!, name: "last" },
          ],
        },
        {
          name: "account",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "score" },
            { ...source.schema[0]!, name: "tag" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    render(<DataGrid source={projectionSource} />);
    const picker = openSelectPicker();
    fireEvent.click(within(picker).getByRole("button", { name: "Hide all" }));
    fireEvent.click(
      within(picker).getByRole("checkbox", {
        name: "Project account.score",
      }),
    );
    fireEvent.click(
      within(picker).getByRole("checkbox", {
        name: "Project profile.last",
      }),
    );

    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["profile","last"]',
      '["account","score"]',
    ]);
    const profile = within(picker).getByRole("checkbox", {
      name: "Project profile",
    }) as HTMLInputElement;
    expect(profile.indeterminate).toBe(true);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        ["profile", "last"],
        ["account", "score"],
      ]),
    );

    fireEvent.click(profile);
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["account","score"]',
    ]);
    expect(profile).not.toBeChecked();
    expect(profile.indeterminate).toBe(false);

    fireEvent.click(profile);
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["profile","first"]',
      '["profile","last"]',
      '["account","score"]',
    ]);
    expect(profile).toBeChecked();
    expect(profile.indeterminate).toBe(false);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        ["profile", "first"],
        ["profile", "last"],
        ["account", "score"],
      ]),
    );
  });

  it("removes an exact struct in one click and projects its leaves on the next", () => {
    render(<DataGrid source={nestedSource} />);
    const picker = openSelectPicker();
    const profile = within(picker).getByRole("checkbox", {
      name: "Project profile",
    }) as HTMLInputElement;
    const city = within(picker).getByRole("checkbox", {
      name: 'Project profile."city.name"',
    });
    const postal = within(picker).getByRole("checkbox", {
      name: 'Project profile.address."postal""code"',
    });

    expect(profile).toBeChecked();
    expect(profile.indeterminate).toBe(false);
    expect(city).not.toBeChecked();
    expect(postal).not.toBeChecked();

    fireEvent.click(profile);
    expect(profile).not.toBeChecked();
    expect(profile.indeterminate).toBe(false);
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["id"]',
      '["tail"]',
    ]);

    fireEvent.click(profile);
    expect(profile).toBeChecked();
    expect(profile.indeterminate).toBe(false);
    expect(city).toBeChecked();
    expect(postal).toBeChecked();
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["id"]',
      '["profile","city.name"]',
      '["profile","address","postal\\"code"]',
      '["profile","address","geo","latitude"]',
      '["tail"]',
    ]);
  });

  it("omits Parquet list and map encoding wrappers from the column picker", () => {
    const containerSource: desktop.SourceSummary = {
      ...source,
      columnCount: 3,
      schemaNodeCount: 8,
      schema: [
        { ...source.schema[0]!, name: "id" },
        {
          name: "tags",
          physicalType: "GROUP",
          logicalType: "List",
          children: [
            {
              name: "list",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                { ...source.schema[0]!, name: "item", logicalType: "String" },
              ],
            },
          ],
        },
        {
          name: "attributes",
          physicalType: "GROUP",
          logicalType: "Map",
          children: [
            {
              name: "entries",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                { ...source.schema[0]!, name: "key", logicalType: "String" },
                { ...source.schema[0]!, name: "value", logicalType: "String" },
              ],
            },
          ],
        },
      ],
    };
    render(<DataGrid source={containerSource} />);
    const picker = openSelectPicker();

    expect(
      within(picker).getByRole("checkbox", { name: "Project tags" }),
    ).toBeChecked();
    expect(
      within(picker).getByRole("checkbox", { name: "Project attributes" }),
    ).toBeChecked();
    expect(within(picker).getAllByRole("treeitem")).toHaveLength(3);
    expect(
      within(picker).queryByRole("checkbox", { name: "Project tags.list" }),
    ).toBeNull();
    expect(
      within(picker).queryByRole("checkbox", {
        name: "Project attributes.entries",
      }),
    ).toBeNull();

    fireEvent.change(within(picker).getByRole("searchbox"), {
      target: { value: "entries" },
    });
    expect(within(picker).getByText("No matching columns.")).toBeVisible();
  });

  it("matches a scalar struct Flatten with the equivalent picker projection", () => {
    const flatSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 2,
      schemaNodeCount: 4,
      schema: [
        {
          name: "group",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "left" },
            { ...source.schema[0]!, name: "right" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    render(<DataGrid source={flatSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    const flattened = gridMock.props?.columns.map((column) => column.id);
    expect(flattened).toEqual([
      '["group","left"]',
      '["group","right"]',
      '["tail"]',
    ]);

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unflatten group" }));
    const picker = openSelectPicker();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project group.left" }),
    );
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project group.right" }),
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual(
      flattened,
    );

    fireEvent.click(within(picker).getByRole("button", { name: "Show all" }));
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["group"]',
      '["tail"]',
    ]);
  });

  it("drops only structural dependencies when the picker removes a projected subtree", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const pickerSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 2,
      schemaNodeCount: 4,
      schema: [
        {
          name: "group",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "left" },
            { ...source.schema[0]!, name: "right" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    render(<DataGrid source={pickerSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    for (const column of [0, 2]) {
      openFilterEditor(column);
      const editor = screen.getByRole("form", {
        name: column === 0 ? "Filter group.left" : "Filter tail",
      });
      fireEvent.change(within(editor).getByLabelText("Condition"), {
        target: { value: "isNull" },
      });
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );
      await waitFor(() =>
        expect(desktop.prepareDataView).toHaveBeenCalledTimes(
          column === 0 ? 1 : 2,
        ),
      );
    }
    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(3),
    );
    act(() => gridMock.props?.onSort(2, true));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(4),
    );

    const picker = openSelectPicker();
    vi.mocked(desktop.getDataWindow).mockClear();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project group" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        5,
        [{ fieldPath: ["tail"], operator: "isNull", values: [] }],
        [{ fieldPath: ["tail"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["tail"]',
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Updated projected columns; removed filters: group.left; sorts: group.left.",
    );
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 5, 0, 4, [
        ["tail"],
      ]),
    );
    expect(
      vi
        .mocked(desktop.getDataWindow)
        .mock.calls.every(
          (call) => call[4].length === 1 && call[4][0]?.[0] === "tail",
        ),
    ).toBe(true);
  });

  it("drops only disappearing dependencies when Flatten replaces a struct", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const flattenSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 2,
      schemaNodeCount: 4,
      schema: [
        {
          name: "group",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "left" },
            { ...source.schema[0]!, name: "right" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    render(<DataGrid source={flattenSource} />);
    for (const column of [0, 1]) {
      openFilterEditor(column);
      const editor = screen.getByRole("form", {
        name: column === 0 ? "Filter group" : "Filter tail",
      });
      fireEvent.change(within(editor).getByLabelText("Condition"), {
        target: { value: "isNull" },
      });
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );
      await waitFor(() =>
        expect(desktop.prepareDataView).toHaveBeenCalledTimes(column + 1),
      );
    }
    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(3),
    );
    act(() => gridMock.props?.onSort(1, true));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(4),
    );

    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    expect(desktop.prepareDataView).toHaveBeenCalledTimes(4);
    fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        5,
        [{ fieldPath: ["tail"], operator: "isNull", values: [] }],
        [{ fieldPath: ["tail"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["group","left"]',
      '["group","right"]',
      '["tail"]',
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Flattened group into 2 columns; removed filters: group; sorts: group.",
    );
  });

  it("promotes a Peek leaf through the shared structural replacement contract", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const profileType = struct({
      address: struct({ city: utf8() }),
      name: utf8(),
    });
    const promoteSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 2,
      schemaNodeCount: 5,
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
              children: [{ ...source.schema[0]!, name: "city" }],
            },
            { ...source.schema[0]!, name: "name" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 4,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map((fieldPath) => ({
              type:
                fieldPath.length === 1 && fieldPath[0] === "profile"
                  ? profileType
                  : fieldPath.at(-1) === "address"
                    ? struct({ city: utf8() })
                    : utf8(),
            })),
          },
          getChildAt: (offset: number) => ({
            at: () =>
              fieldPaths[offset]?.[0] === "profile"
                ? { address: { city: "Utrecht" }, name: "Ada" }
                : "tail",
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={promoteSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());

    for (const column of [0, 1]) {
      openFilterEditor(column);
      const editor = screen.getByRole("form", {
        name: column === 0 ? "Filter profile" : "Filter tail",
      });
      fireEvent.change(within(editor).getByLabelText("Condition"), {
        target: { value: "isNull" },
      });
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );
      await waitFor(() =>
        expect(desktop.prepareDataView).toHaveBeenCalledTimes(column + 1),
      );
    }
    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(3),
    );
    act(() => gridMock.props?.onSort(1, true));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(4),
    );

    act(() =>
      gridMock.props?.onCellPeek?.(
        { column: 0, row: 0 },
        { x: 20, y: 20, width: 120, height: 28 },
      ),
    );
    const tree = await screen.findByRole("tree", { name: "profile value" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.keyDown(tree, { key: "ArrowRight" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Promote to column" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        5,
        [{ fieldPath: ["tail"], operator: "isNull", values: [] }],
        [{ fieldPath: ["tail"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["profile","address","city"]',
      '["tail"]',
    ]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Promoted profile.address.city to one column; removed filters: profile; sorts: profile.",
    );
  });

  it("keeps the requested struct selected when Sidebar Flatten needs its parent first", () => {
    render(<DataGrid source={nestedSource} />);
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    const addressNode = within(sidebar).getByText("address").closest("li");
    if (addressNode === null) throw new Error("address schema node is missing");

    fireEvent.contextMenu(
      within(addressNode).getByText("address").closest("button")!,
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Flatten profile.address" }),
    );

    expect(screen.getByText("Flatten profile first.")).toBeVisible();
    expect(
      within(addressNode).getByText("address").closest("button"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(addressNode).getByText('postal"code').closest("button"),
    ).not.toHaveAttribute("aria-pressed", "true");
    expect(gridMock.scrollToColumn).not.toHaveBeenCalled();
  });

  it("closes Peek on pin reorder and recopies the reordered header path", async () => {
    const fieldPath = ["profile", "weird name", "leaf"];
    const pathSource: desktop.SourceSummary = {
      ...source,
      rowCount: 1,
      columnCount: 2,
      schemaNodeCount: 4,
      schema: [
        { ...source.schema[0]!, name: "id" },
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "weird name",
              physicalType: "GROUP",
              logicalType: null,
              children: [
                {
                  name: "leaf",
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
    render(<DataGrid source={pathSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 1, [
        ["id"],
        fieldPath,
      ]),
    );

    const openPathPeek = () => {
      const column =
        gridMock.props?.columns.findIndex(
          (candidate) => candidate.id === JSON.stringify(fieldPath),
        ) ?? -1;
      expect(column).toBeGreaterThanOrEqual(0);
      const selection = {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { column, row: 0 },
          range: { x: column, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      };
      act(() => {
        gridMock.props?.onSelectionChange(selection);
        gridMock.props?.onCellPeek?.(selection.current.cell, {
          x: 20,
          y: 20,
          width: 120,
          height: 28,
        });
      });
      return column;
    };

    const originalIndex = openPathPeek();
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    expect(screen.getByRole("menuitem", { name: "Copy path" })).toBeVisible();
    openColumnMenu(originalIndex);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    expect(
      screen.queryByRole("menuitem", { name: "Copy path" }),
    ).not.toBeInTheDocument();

    const reorderedIndex = openPathPeek();
    expect(reorderedIndex).toBe(0);
    const headerTitle = gridMock.props?.columns[reorderedIndex]?.title;
    expect(headerTitle).toBe(formatFieldPath(fieldPath));
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));

    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(headerTitle),
    );
  });

  it("restores an unpinned flattened parent in the middle of its columns", async () => {
    render(<DataGrid source={nestedSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["id"]',
      '["profile","city.name"]',
      '["profile","address"]',
      '["tail"]',
    ]);

    openColumnMenu(1);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Unflatten profile",
      }),
    );

    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["id"]',
      '["profile"]',
      '["tail"]',
    ]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      screen
        .getByText(/Unflattened profile into one column\./)
        .closest('[role="status"]'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        ["id"],
        ["profile"],
        ["tail"],
      ]),
    );
  });

  it("keeps split rail segments when children have different pin states", async () => {
    const profileType = struct({
      "city.name": utf8(),
      address: struct({ 'postal"code': int32() }),
    });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 4,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map((fieldPath) => ({
              type:
                fieldPath.length === 1 && fieldPath[0] === "profile"
                  ? profileType
                  : utf8(),
            })),
          },
          getChildAt: () => ({ at: () => null }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={nestedSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin column" }));

    expect(gridMock.props?.columns[0]).toMatchObject({
      id: '["profile","address"]',
      groupRail: {
        title: "profile · struct<…>",
        start: true,
        end: true,
      },
    });
    const unpinnedCityIndex =
      gridMock.props?.columns.findIndex(
        (column) => column.id === '["profile","city.name"]',
      ) ?? -1;
    expect(unpinnedCityIndex).toBeGreaterThan(0);
    expect(gridMock.props?.columns[unpinnedCityIndex]).toMatchObject({
      groupRail: {
        title: "profile · struct<…>",
        start: true,
        end: true,
      },
    });

    openColumnMenu(unpinnedCityIndex);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        ["profile", "city.name"],
        ["profile", "address"],
        ["id"],
        ["tail"],
      ]),
    );
    expect(gridMock.props?.columns.slice(0, 2)).toMatchObject([
      {
        id: '["profile","city.name"]',
        groupRail: {
          title: "profile · struct<…>",
          start: true,
          end: false,
        },
      },
      {
        id: '["profile","address"]',
        groupRail: {
          title: "profile · struct<…>",
          start: false,
          end: true,
        },
      },
    ]);
  });

  it("breaks an adjacent group rail at the pinned boundary", () => {
    const oneStructSource: desktop.SourceSummary = {
      ...nestedSource,
      columnCount: 1,
      schemaNodeCount: 3,
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "city" },
            { ...source.schema[0]!, name: "country" },
          ],
        },
      ],
    };
    render(<DataGrid source={oneStructSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin column" }));

    expect(gridMock.props?.columns).toMatchObject([
      {
        id: '["profile","country"]',
        pinned: true,
        groupRail: { start: true, end: true },
      },
      {
        id: '["profile","city"]',
        pinned: false,
        groupRail: { start: true, end: true },
      },
    ]);
  });

  it("keeps one outer rail when every child of an unpinned parent is pinned", () => {
    render(<DataGrid source={nestedSource} />);
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    for (const id of ['["profile","city.name"]', '["profile","address"]']) {
      const index =
        gridMock.props?.columns.findIndex((column) => column.id === id) ?? -1;
      expect(index).toBeGreaterThanOrEqual(0);
      openColumnMenu(index);
      fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    }

    expect(gridMock.props?.columns.slice(0, 2)).toMatchObject([
      {
        id: '["profile","city.name"]',
        groupRail: {
          title: "profile · struct<…>",
          start: true,
          end: false,
        },
      },
      {
        id: '["profile","address"]',
        groupRail: {
          title: "profile · struct<…>",
          start: false,
          end: true,
        },
      },
    ]);
  });

  it("keeps a spaced nested path through flatten, filter, sort, and export", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const spacedSource: desktop.SourceSummary = {
      ...source,
      displayName: "spaced-field.parquet",
      rowCount: 4,
      columnCount: 1,
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "display name",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
          ],
        },
      ],
      schemaNodeCount: 2,
    };
    render(<DataGrid source={spacedSource} />);

    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    expect(gridMock.props?.columns[0]).toMatchObject({
      id: '["profile","display name"]',
      title: 'profile."display name"',
    });

    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [
          {
            fieldPath: ["profile", "display name"],
            direction: "ascending",
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );

    openFilterEditor(0);
    const editor = screen.getByRole("form", {
      name: 'Filter profile."display name"',
    });
    fireEvent.change(within(editor).getByLabelText("Condition"), {
      target: { value: "textContains" },
    });
    fireEvent.change(within(editor).getByRole("combobox", { name: "Value" }), {
      target: { value: "Ada" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [
          {
            fieldPath: ["profile", "display name"],
            operator: "textContains",
            values: ["Ada"],
          },
        ],
        [
          {
            fieldPath: ["profile", "display name"],
            direction: "ascending",
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );

    openGridMenu();
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Export current view \(4 rows\)/ }),
    );
    await waitFor(() =>
      expect(desktop.startDataExport).toHaveBeenCalledWith(7, 2, "view", {
        fieldPaths: [["profile", "display name"]],
        rowRanges: [],
        output: { format: "csv", options: {} },
      }),
    );
  });

  it("flattens a generated 100-child struct into addressable columns", async () => {
    const children = Array.from({ length: 100 }, (_, index) => ({
      name: `child_${index}`,
      physicalType: "INT32",
      logicalType: null,
      children: [],
    }));
    const wideSource: desktop.SourceSummary = {
      ...source,
      displayName: "wide-struct.parquet",
      rowCount: 4,
      columnCount: 1,
      schema: [
        {
          name: "wide",
          physicalType: "GROUP",
          logicalType: null,
          children,
        },
      ],
      schemaNodeCount: 101,
    };
    render(<DataGrid source={wideSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    const paths = children.map((child) => ["wide", child.name]);
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        4,
        paths.slice(0, 8),
      ),
    );
    expect(
      vi
        .mocked(desktop.getDataWindow)
        .mock.calls.every((call) => call[4].length <= 8),
    ).toBe(true);
    expect(gridMock.props?.columns).toHaveLength(100);
    expect(gridMock.props?.columns[0]).toMatchObject({
      id: '["wide","child_0"]',
      title: "wide.child_0",
      groupRail: { start: true, end: false },
    });
    expect(gridMock.props?.columns[99]).toMatchObject({
      id: '["wide","child_99"]',
      title: "wide.child_99",
      groupRail: { start: false, end: true },
    });
    const picker = openSelectPicker();
    expect(within(picker).getAllByRole("checkbox").length).toBeLessThan(20);
    fireEvent.change(within(picker).getByRole("searchbox"), {
      target: { value: "child_99" },
    });
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(2);
    expect(
      within(picker).getByRole("checkbox", {
        name: "Project wide.child_99",
      }),
    ).toBeChecked();
  });

  it("does not traverse a wide schema for column-state updates while the picker is closed", () => {
    let childNameReads = 0;
    const children = Array.from({ length: 100 }, (_, index) => {
      const field = {
        physicalType: "INT32",
        logicalType: null,
        children: [],
      } as unknown as desktop.SchemaField;
      Object.defineProperty(field, "name", {
        enumerable: true,
        get: () => {
          childNameReads += 1;
          return `child_${index}`;
        },
      });
      return field;
    });
    render(
      <DataGrid
        source={{
          ...source,
          columnCount: 1,
          schemaNodeCount: 101,
          schema: [
            {
              name: "wide",
              physicalType: "GROUP",
              logicalType: null,
              children,
            },
          ],
        }}
      />,
    );
    childNameReads = 0;

    act(() => gridMock.props?.onColumnResize(0, 220));
    expect(childNameReads).toBe(0);

    const picker = openSelectPicker();
    expect(childNameReads).toBeGreaterThan(0);
    expect(
      within(picker).getByRole("checkbox", { name: "Project wide" }),
    ).toBeChecked();
  });

  it("indexes one 10k-wide projection macro instead of rescanning the schema", () => {
    let childNameReads = 0;
    const children = Array.from({ length: 10_000 }, (_, index) => {
      const field: desktop.SchemaField = {
        name: "",
        physicalType: "INT32",
        logicalType: null,
        children: [],
      };
      Object.defineProperty(field, "name", {
        enumerable: true,
        get: () => {
          childNameReads += 1;
          return `child_${index}`;
        },
      });
      return field;
    });
    const wideSource: desktop.SourceSummary = {
      ...source,
      displayName: "10k-wide-struct.parquet",
      rowCount: 1,
      columnCount: 1,
      schema: [
        {
          name: "wide",
          physicalType: "GROUP",
          logicalType: null,
          children,
        },
      ],
      schemaNodeCount: 10_001,
    };
    render(<DataGrid source={wideSource} />);
    const picker = openSelectPicker();
    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project wide" }),
    );
    childNameReads = 0;

    fireEvent.click(
      within(picker).getByRole("checkbox", { name: "Project wide" }),
    );

    expect(gridMock.props?.columns).toHaveLength(10_000);
    expect(gridMock.props?.columns[0]?.id).toBe('["wide","child_0"]');
    expect(gridMock.props?.columns[9_999]?.id).toBe('["wide","child_9999"]');
    expect(childNameReads).toBeLessThan(100_000);
  });

  it("preserves a generated six-level struct path through recursive flattening", async () => {
    let nestedField: desktop.SchemaField = {
      name: "leaf",
      physicalType: "BYTE_ARRAY",
      logicalType: "String",
      children: [],
    };
    for (let depth = 5; depth >= 1; depth -= 1) {
      nestedField = {
        name: `level_${depth}`,
        physicalType: "GROUP",
        logicalType: null,
        children: [nestedField],
      };
    }
    const deepSource: desktop.SourceSummary = {
      ...source,
      displayName: "deep-struct.parquet",
      rowCount: 4,
      columnCount: 1,
      schema: [
        {
          name: "root",
          physicalType: "GROUP",
          logicalType: null,
          children: [nestedField],
        },
      ],
      schemaNodeCount: 7,
    };
    render(<DataGrid source={deepSource} />);

    for (let depth = 0; depth < 6; depth += 1) {
      openColumnMenu(0);
      fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    }

    const fieldPath = [
      "root",
      "level_1",
      "level_2",
      "level_3",
      "level_4",
      "level_5",
      "leaf",
    ];
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 4, [
        fieldPath,
      ]),
    );
    expect(gridMock.props?.columns).toMatchObject([
      {
        id: JSON.stringify(fieldPath),
        title: "root.level_1.level_2.level_3.level_4.level_5.leaf",
        titlePrefix: "root.level_1.level_2.level_3.level_4.level_5.",
        titleLeaf: "leaf",
        groupRail: {
          title: "root · struct<…>",
          start: true,
          end: true,
        },
      },
    ]);
  });

  it("names bounded dependent filters and sorts when unflattening", async () => {
    vi.mocked(desktop.prepareDataView).mockImplementation(
      async (_generation, revision) => ({ revision, rowCount: 4 }),
    );
    const boundedSource: desktop.SourceSummary = {
      ...source,
      displayName: "bounded-notice.parquet",
      rowCount: 4,
      columnCount: 2,
      schema: [
        {
          name: "group",
          physicalType: "GROUP",
          logicalType: null,
          children: Array.from({ length: 5 }, (_, index) => ({
            name: `child_${index}`,
            physicalType: "INT32",
            logicalType: null,
            children: [],
          })),
        },
        {
          name: "tail",
          physicalType: "INT32",
          logicalType: null,
          children: [],
        },
      ],
      schemaNodeCount: 7,
    };
    render(<DataGrid source={boundedSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    for (let index = 0; index < 5; index += 1) {
      openFilterEditor(index);
      const editor = screen.getByRole("form", {
        name: `Filter group.child_${index}`,
      });
      fireEvent.change(within(editor).getByLabelText("Condition"), {
        target: { value: "isNull" },
      });
      fireEvent.click(
        within(editor).getByRole("button", { name: "Add condition" }),
      );
      await waitFor(() =>
        expect(desktop.prepareDataView).toHaveBeenCalledTimes(index + 1),
      );
    }
    openFilterEditor(5);
    const tailEditor = screen.getByRole("form", { name: "Filter tail" });
    fireEvent.change(within(tailEditor).getByLabelText("Condition"), {
      target: { value: "isNull" },
    });
    fireEvent.click(
      within(tailEditor).getByRole("button", { name: "Add condition" }),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(6),
    );

    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(7),
    );
    act(() => gridMock.props?.onSort(5, true));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(8),
    );
    openColumnMenu(0);
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Unflatten group",
      }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        9,
        [{ fieldPath: ["tail"], operator: "isNull", values: [] }],
        [{ fieldPath: ["tail"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unflattened group into one column; removed filters: group.child_0, group.child_1, group.child_2, +2 more; sorts: group.child_0.",
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["group"]',
      '["tail"]',
    ]);
  });

  it("recomputes the Unflatten price when a pending view fails", async () => {
    const pricedSource: desktop.SourceSummary = {
      ...source,
      rowCount: 4,
      columnCount: 2,
      schemaNodeCount: 4,
      schema: [
        {
          name: "group",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            { ...source.schema[0]!, name: "left" },
            { ...source.schema[0]!, name: "right" },
          ],
        },
        { ...source.schema[0]!, name: "tail" },
      ],
    };
    render(<DataGrid source={pricedSource} />);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));
    openFilterEditor(0);
    const editor = screen.getByRole("form", { name: "Filter group.left" });
    fireEvent.change(within(editor).getByLabelText("Condition"), {
      target: { value: "isNull" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(1),
    );
    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledTimes(2),
    );

    const pending = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(pending.promise);
    vi.mocked(desktop.getDataViewStatus).mockResolvedValue({
      revision: 2,
      rowCount: 4,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Clear WHERE and ORDER BY" }),
    );
    openColumnMenu(0);
    let unflatten = screen.getByRole("menuitem", {
      name: "Unflatten group",
    });
    expect(unflatten).toHaveAccessibleDescription("2 columns → 1");

    await act(async () =>
      pending.reject(new desktop.DataWindowCommandError("queryFailed")),
    );
    await waitFor(() => {
      unflatten = screen.getByRole("menuitem", {
        name: "Unflatten group",
      });
      expect(unflatten).toHaveAccessibleDescription(
        "2 columns → 1 · removes 1 filter · removes 1 sort",
      );
    });
  });

  it("keeps flattened columns when an early dataset sample becomes complete", async () => {
    const view = render(
      <DataGrid source={nestedSource} contentIdentity="early-sample" />,
    );
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Flatten" }));

    view.rerender(
      <DataGrid
        source={{
          ...nestedSource,
          rowCount: 8,
          schema: structuredClone(nestedSource.schema),
        }}
        contentIdentity="complete"
      />,
    );

    await waitFor(() =>
      expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
        '["id"]',
        '["profile","city.name"]',
        '["profile","address"]',
        '["tail"]',
      ]),
    );
    expect(screen.queryByText(/Flattened profile into 2 columns/)).toBeNull();
    openColumnMenu(1);
    expect(
      screen.getByRole("menuitem", {
        name: "Unflatten profile",
      }),
    ).toBeInTheDocument();
  });

  it("keeps the SELECT picker and grid column menu on one visibility state", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    openColumnMenu(7);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    const picker = openSelectPicker();
    const lastColumn = within(picker).getByRole("checkbox", {
      name: "Project column_7",
    });
    expect(lastColumn).not.toBeChecked();
    expect(screen.getByLabelText("Query")).toHaveTextContent("[7 cols]");
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        512,
        sourceFieldPaths([0, 1, 2, 3, 4, 5, 6]),
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
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
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
      within(picker).getByRole("checkbox", { name: "Project column_7" }),
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

    expect(screen.getByLabelText("Query")).toHaveTextContent("[0 cols]");
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
        sourceFieldPaths([0, 1, 2, 3, 4, 5, 6, 7]),
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
      name: "Project column_9999",
    });
    expect(lastColumn).toBeInTheDocument();
    expect(within(picker).getAllByRole("checkbox")).toHaveLength(1);

    fireEvent.click(lastColumn);
    const selectButton = screen
      .getByLabelText("Query")
      .querySelector<HTMLButtonElement>(".query-select");
    expect(selectButton).toHaveAttribute("title", "9,999 projected columns");
    expect(selectButton?.title.length).toBeLessThan(100);
  });

  it("shrinks a short SELECT list and exposes complete list semantics", () => {
    render(
      <DataGrid source={{ ...source, schema: source.schema.slice(0, 3) }} />,
    );

    const picker = openSelectPicker();
    const list = within(picker).getByRole("tree", { name: "Columns" });
    expect(list).toHaveStyle({ maxHeight: "336px" });
    expect(list.style.height).toBe("");
    expect(within(list).getAllByRole("treeitem")).toHaveLength(3);
    expect(within(picker).getByRole("status")).toHaveTextContent(
      "3 projected columns",
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
      name: "Project column_0",
    });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = within(picker).getByRole("checkbox", {
      name: "Project column_1",
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
        sourceFieldPaths([0, 2, 3, 4, 5, 6, 7]),
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
        [{ fieldPath: ["column_0"], operator: "equals", values: ["1"] }],
        [{ fieldPath: ["column_0"], direction: "ascending" }],
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
      within(picker).getByRole("checkbox", { name: "Project column_0" }),
    );

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        2,
        0,
        37,
        sourceFieldPaths([1, 2, 3, 4, 5, 6, 7]),
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
      target: { value: '["column_0"]' },
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
        [{ fieldPath: ["column_0"], operator: "equals", values: ["42"] }],
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

  it("auto-fits one column from a bounded preview in its rendered font", async () => {
    const fittingSource: desktop.SourceSummary = {
      ...source,
      rowCount: 2,
      schema: [{ ...source.schema[0]!, name: "number" }],
    };
    const nestedValue = ["x".repeat(1_000), "unread"];
    const unreadTail = vi.fn(() => {
      throw new Error("auto-fit traversed beyond the display preview");
    });
    Object.defineProperty(nestedValue, 1, { get: unreadTail });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 2,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: [{ type: list(utf8()) }] },
          getChildAt: () => ({ at: () => nestedValue }),
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
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 2, [
        ["number"],
      ]),
    );
    expect(
      gridMock.props?.columns[0] !== undefined &&
        "width" in gridMock.props.columns[0]
        ? gridMock.props.columns[0].width
        : 0,
    ).toBe(260);
    expect(context.font).toContain("ui-monospace");
    expect(unreadTail).not.toHaveBeenCalled();
  });

  it("prepares a multi-megabyte nested grid copy incrementally", async () => {
    const nestedSource: desktop.SourceSummary = {
      ...source,
      rowCount: 1,
      schema: [source.schema[0]!],
    };
    const nestedValue = ["x".repeat(2 * 1024 * 1024)];
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: [{ type: list(utf8()) }] },
          getChildAt: () => ({ at: () => nestedValue }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={nestedSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 0 },
          range: { x: 0, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      });
    });

    copyFromGrid();
    expect(screen.getByText("Preparing copy…")).toBeInTheDocument();
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });

    const copied = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(copied.startsWith('"')).toBe(true);
    expect(copied.endsWith('"')).toBe(true);
    expect(JSON.parse(copied.slice(1, -1).replaceAll('""', '"'))).toEqual(
      nestedValue,
    );
    expect(screen.queryByText("Preparing copy…")).not.toBeInTheDocument();
  });

  it("copies a 10k nested range in bounded shared scheduler ticks", async () => {
    const nestedSource: desktop.SourceSummary = {
      ...source,
      schema: [source.schema[0]!],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: Math.min(512, nestedSource.rowCount - rowOffset),
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: [{ type: list(int32()) }] },
          getChildAt: () => ({ at: (row: number) => [rowOffset + row] }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={nestedSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { row: 0, column: 0 },
          range: { x: 0, y: 0, width: 1, height: 10_000 },
          rangeStack: [],
        },
      });
    });
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => {
      time += 0.001;
      return time;
    });
    const timers = vi.spyOn(globalThis, "setTimeout");

    copyFromGrid();
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });

    expect(clipboardWrite).toHaveBeenCalledOnce();
    const copied = clipboardWrite.mock.calls[0]?.[0] as string;
    expect(copied.split("\n")).toHaveLength(10_000);
    expect(timers.mock.calls.length).toBeGreaterThan(1);
    expect(timers.mock.calls.length).toBeLessThan(100);
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
        [{ fieldPath: ["column_2"], direction: "ascending" }],
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
          { fieldPath: ["column_2"], direction: "ascending" },
          { fieldPath: ["column_3"], direction: "ascending" },
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

  it("rebuilds an early-sample sort on completion without remounting the grid", async () => {
    const { rerender } = render(
      <DataGrid source={source} contentIdentity="early-sample" />,
    );
    act(() => {
      gridMock.props?.onSort(2, false);
    });
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [{ fieldPath: ["column_2"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    vi.mocked(desktop.prepareDataView).mockClear();

    rerender(
      <DataGrid
        source={{ ...source, rowCount: source.rowCount + 100 }}
        contentIdentity="complete"
      />,
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        2,
        [],
        [{ fieldPath: ["column_2"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.columns[2]?.sort.direction).toBe("ascending");
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
      target: { value: '["quoted\\"name"]' },
    });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: '["second"]' },
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
        { fieldPath: ["second"], direction: "descending" },
        { fieldPath: ['quoted"name'], direction: "ascending" },
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
      target: { value: '["column_0"]' },
    });
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [],
        [{ fieldPath: ["column_0"], direction: "ascending" }],
        { memoryLimit: "mb384" },
      ),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "⋯" })[1]!);
    popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    expect(
      within(popup).getByRole("button", { name: "Remove sort column_0" }),
    ).toBeInTheDocument();
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: '["column_1"]' },
    });
    fireEvent.click(within(popup).getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [],
        [
          { fieldPath: ["column_0"], direction: "ascending" },
          { fieldPath: ["column_1"], direction: "ascending" },
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
        [{ fieldPath: ["column_0"], operator: "equals", values: ["4"] }],
        [{ fieldPath: ["column_2"], direction: "ascending" }],
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
    expect(popup).not.toHaveClass("is-empty");
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

  it("applies a manually entered JSON array path and cancels its scan", async () => {
    const preparation = deferred<desktop.DataViewStatus>();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    render(<DataGrid source={jsonSource} />);

    openFilterEditor(0);
    const editor = screen.getByRole("form", { name: "Filter payload" });
    fireEvent.change(within(editor).getByLabelText("Filter value"), {
      target: { value: "jsonField" },
    });
    expect(
      await within(editor).findByText(/Sample-derived fields from at most/),
    ).toBeInTheDocument();
    expect(within(editor).getByText(/scans the JSON column/)).toBeVisible();
    vi.mocked(desktop.getTextValueSuggestions).mockClear();

    const manualPath = within(editor).getByLabelText("Manual JSON path");
    fireEvent.change(manualPath, { target: { value: "items[" } });
    expect(
      within(editor).getByRole("button", { name: "Add condition" }),
    ).toBeDisabled();
    expect(desktop.prepareDataView).not.toHaveBeenCalled();

    fireEvent.change(manualPath, {
      target: { value: 'items[3]."late.value"' },
    });
    fireEvent.change(within(editor).getByLabelText("Value type"), {
      target: { value: "number" },
    });
    fireEvent.change(within(editor).getByLabelText("Condition"), {
      target: { value: "greaterThan" },
    });
    fireEvent.change(within(editor).getByLabelText("Value"), {
      target: { value: "10" },
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(desktop.getTextValueSuggestions).not.toHaveBeenCalled();
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [
          {
            fieldPath: ["payload"],
            jsonTarget: {
              path: [{ field: "items" }, { index: 3 }, { field: "late.value" }],
              valueType: "number",
            },
            operator: "greaterThan",
            values: ["10"],
          },
        ],
        [],
        { memoryLimit: "mb384" },
      ),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent(
      "preparing view… cancel",
    );
    fireEvent.click(
      within(screen.getByLabelText("Query")).getByRole("button", {
        name: "cancel",
      }),
    );
    await waitFor(() =>
      expect(desktop.cancelDataView).toHaveBeenCalledWith(7, 1),
    );
  });

  it("invalidates shared JSON inference when the source revision changes", async () => {
    const inference = vi.mocked(desktop.inferJsonSchema);
    inference.mockClear();
    const revisionSource = { ...jsonSource, generation: 811 };
    const { rerender } = render(
      <DataGrid source={revisionSource} contentIdentity="early-sample" />,
    );

    openFilterEditor(0);
    let editor = screen.getByRole("form", { name: "Filter payload" });
    fireEvent.change(within(editor).getByLabelText("Filter value"), {
      target: { value: "jsonField" },
    });
    await within(editor).findByText(/Sample-derived fields from at most/);
    expect(inference).toHaveBeenCalledTimes(1);
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    fireEvent.click(document.querySelector<HTMLButtonElement>(".query-order")!);
    let popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: '["payload"]' },
    });
    fireEvent.change(within(popup).getByLabelText("Sort value for payload"), {
      target: { value: "jsonField" },
    });
    await within(popup).findByText(/Sample-derived fields from at most/);
    expect(inference).toHaveBeenCalledTimes(1);
    fireEvent.click(within(popup).getByRole("button", { name: "Cancel" }));

    rerender(<DataGrid source={revisionSource} contentIdentity="complete" />);
    openFilterEditor(0);
    editor = screen.getByRole("form", { name: "Filter payload" });
    fireEvent.change(within(editor).getByLabelText("Filter value"), {
      target: { value: "jsonField" },
    });
    await waitFor(() => expect(inference).toHaveBeenCalledTimes(2));
    fireEvent.click(within(editor).getByRole("button", { name: "Cancel" }));

    rerender(
      <DataGrid
        source={{ ...revisionSource, rowCount: revisionSource.rowCount + 1 }}
        contentIdentity="complete"
      />,
    );
    fireEvent.click(document.querySelector<HTMLButtonElement>(".query-order")!);
    popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: '["payload"]' },
    });
    fireEvent.change(within(popup).getByLabelText("Sort value for payload"), {
      target: { value: "jsonField" },
    });
    await waitFor(() => expect(inference).toHaveBeenCalledTimes(3));
  });

  it("sorts a sampled mixed JSON path with the mixed target contract", async () => {
    render(<DataGrid source={jsonSource} />);

    const orderButton =
      document.querySelector<HTMLButtonElement>(".query-order");
    expect(orderButton).not.toBeNull();
    fireEvent.click(orderButton!);
    const popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    fireEvent.change(within(popup).getByLabelText("Add column"), {
      target: { value: '["payload"]' },
    });
    fireEvent.change(within(popup).getByLabelText("Sort value for payload"), {
      target: { value: "jsonField" },
    });
    const apply = within(popup).getByRole("button", { name: "Apply" });
    fireEvent.change(await within(popup).findByLabelText("Manual JSON path"), {
      target: { value: "items[" },
    });
    expect(apply).toBeDisabled();
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
    fireEvent.click(
      await within(popup).findByRole("treeitem", {
        name: 'items[0]."mixed.value" mixed · text',
      }),
    );
    expect(apply).toBeEnabled();
    fireEvent.click(apply);

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [],
        [
          {
            fieldPath: ["payload"],
            direction: "ascending",
            jsonTarget: {
              path: [
                { field: "items" },
                { index: 0 },
                { field: "mixed.value" },
              ],
              valueType: "mixed",
            },
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );
    expect(screen.getByLabelText("Query")).toHaveTextContent(
      'payload.items[0]."mixed.value" ASC',
    );
  });

  it("sorts multiple JSON paths from one column without duplicating an identity", async () => {
    render(<DataGrid source={jsonSource} />);

    fireEvent.click(document.querySelector<HTMLButtonElement>(".query-order")!);
    const popup = screen.getByRole("dialog", { name: "ORDER BY columns" });
    const addColumn = within(popup).getByLabelText("Add column");
    fireEvent.change(addColumn, { target: { value: '["payload"]' } });
    fireEvent.change(within(popup).getByLabelText("Sort value for payload"), {
      target: { value: "jsonField" },
    });
    const firstPath = await within(popup).findByLabelText("Manual JSON path");
    fireEvent.change(firstPath, { target: { value: "items[0].rank" } });
    fireEvent.change(within(popup).getByLabelText("Value type"), {
      target: { value: "number" },
    });

    fireEvent.change(addColumn, { target: { value: '["payload"]' } });
    const paths = within(popup).getAllByLabelText("Manual JSON path");
    const types = within(popup).getAllByLabelText("Value type");
    fireEvent.change(paths[1]!, { target: { value: "items[0].rank" } });
    fireEvent.change(types[1]!, { target: { value: "text" } });

    const apply = within(popup).getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    expect(within(popup).getByRole("alert")).toHaveTextContent(
      "Each whole column or JSON path can be sorted only once.",
    );

    fireEvent.change(paths[1]!, { target: { value: "items[0].name" } });
    expect(apply).toBeEnabled();
    fireEvent.click(
      within(popup).getByRole("button", {
        name: "Move payload.items[0].name earlier",
      }),
    );
    expect(
      within(popup)
        .getAllByLabelText("Manual JSON path")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["items[0].name", "items[0].rank"]);
    fireEvent.click(apply);

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [],
        [
          {
            fieldPath: ["payload"],
            direction: "ascending",
            jsonTarget: {
              path: [{ field: "items" }, { index: 0 }, { field: "name" }],
              valueType: "text",
            },
          },
          {
            fieldPath: ["payload"],
            direction: "ascending",
            jsonTarget: {
              path: [{ field: "items" }, { index: 0 }, { field: "rank" }],
              valueType: "number",
            },
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.columns[0]?.sort.direction).toBe("neutral");

    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        2,
        [],
        [
          { fieldPath: ["payload"], direction: "ascending" },
          {
            fieldPath: ["payload"],
            direction: "ascending",
            jsonTarget: {
              path: [{ field: "items" }, { index: 0 }, { field: "name" }],
              valueType: "text",
            },
          },
          {
            fieldPath: ["payload"],
            direction: "ascending",
            jsonTarget: {
              path: [{ field: "items" }, { index: 0 }, { field: "rank" }],
              valueType: "number",
            },
          },
        ],
        { memoryLimit: "mb384" },
      ),
    );
  });

  it("opens an exact JSON field filter from Peek", async () => {
    const json = JSON.stringify({ items: [{ "unit.price": 12 }] });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 4,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: [{ type: utf8() }] },
          getChildAt: () => ({ at: () => json }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={jsonSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(
      await screen.findByText("items", {
        selector: ".value-tree-name.is-key",
      }),
    ).toBeInTheDocument();
    const tree = screen.getByRole("tree", { name: "payload value" });
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    for (let step = 0; step < 4; step += 1) {
      fireEvent.keyDown(tree, { key: "ArrowRight" });
    }
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Filter by this field" }),
    );

    const editor = screen.getByRole("form", {
      name: 'Filter payload.items[0]."unit.price"',
    });
    fireEvent.change(within(editor).getByLabelText("Value"), {
      target: { value: "12" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Add condition" }),
    );
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [
          {
            fieldPath: ["payload"],
            jsonTarget: {
              path: [{ field: "items" }, { index: 0 }, { field: "unit.price" }],
              valueType: "number",
            },
            operator: "equals",
            values: ["12"],
          },
        ],
        [],
        { memoryLimit: "mb384" },
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
        [
          {
            fieldPath: ["label"],
            operator: "textContains",
            values: ["Alpha"],
          },
        ],
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
            fieldPath: ["label"],
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
    const onOperationChange = vi.fn();
    const replacementOperationChange = vi.fn();
    vi.mocked(desktop.prepareDataView).mockReturnValueOnce(preparation.promise);
    const { rerender } = render(
      <DataGrid source={source} onOperationChange={onOperationChange} />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    onOperationChange.mockClear();

    addNumberFilter("1");

    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenCalledWith(
        7,
        1,
        [{ fieldPath: ["column_0"], operator: "equals", values: ["1"] }],
        [],
        { memoryLimit: "mb384" },
      ),
    );
    expect(gridMock.props?.rowCount).toBe(10_000);
    expect(screen.getByLabelText("Query")).toHaveTextContent("preparing view…");
    expect(onOperationChange).toHaveBeenLastCalledWith(true);
    rerender(
      <DataGrid
        source={source}
        onOperationChange={replacementOperationChange}
      />,
    );
    expect(onOperationChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByLabelText("Query")).not.toHaveTextContent(
      '"column_0" = 1',
    );

    await act(async () => preparation.resolve({ revision: 1, rowCount: 37 }));

    await waitFor(() => expect(gridMock.props?.rowCount).toBe(37));
    expect(screen.getByLabelText("Query")).toHaveTextContent('"column_0" = 1');
    expect(screen.getByLabelText("Query")).toHaveTextContent("37 rows");
    expect(onOperationChange).toHaveBeenLastCalledWith(true);
    expect(replacementOperationChange).toHaveBeenLastCalledWith(false);
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
        sourceFieldPaths([0, 1, 2, 3]),
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
      expect(desktop.getDataWindow).toHaveBeenCalledWith(
        7,
        1,
        0,
        3,
        sourceFieldPaths([0, 1]),
      ),
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
        [["boolean_value"], ["int16_value"], ["column_2"], ["column_3"]],
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
        [{ fieldPath: ["boolean_value"], operator: "isNull", values: [] }],
        [{ fieldPath: ["int16_value"], direction: "ascending" }],
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
        [["boolean_value"], ["int16_value"], ["column_2"], ["column_3"]],
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
        [{ fieldPath: ["column_1"], operator: "equals", values: ["2"] }],
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
    decodeArrowWindow.mockImplementation(
      (
        bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 3,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({
              type:
                bytes.byteLength === 2
                  ? struct({ stale_child: utf8() })
                  : bytes.byteLength === 3
                    ? int32()
                    : utf8(),
            })),
          },
          getChildAt: () => ({ at: (row: number) => `row ${row}` }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
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
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    expect(screen.queryByText("stale_child")).not.toBeInTheDocument();

    await act(async () => currentWindow.resolve(new ArrayBuffer(3)));
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    expect(screen.getAllByTitle("int32").length).toBeGreaterThan(0);
  });

  it("defers horizontal projection work and prioritizes the latest row window", async () => {
    diagnosticsController = createGridPerformanceController();
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
    render(
      <DataGrid source={wideSource} diagnostics={diagnosticsController.sink} />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    diagnosticsController.start({
      runtime: {
        appVersion: "test",
        queryEngineVersion: "test",
        userAgent: "test",
        platform: "test",
        theme: "light",
      },
      source: { sizeBytes: 1, rowCount: 10_000, columnCount: 40 },
    });
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow)
      .mockReturnValueOnce(horizontalWindow.promise)
      .mockReturnValueOnce(latestWindow.promise);
    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [20, 21],
        mountedRowStart: 0,
        mountedRowCount: 31,
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
      936,
      expect.any(Number),
      sourceFieldPaths([20, 21]),
    );
    gridMock.revisionChanged.mockReset();

    await act(async () => horizontalWindow.resolve(new ArrayBuffer(1)));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      expect.any(Number),
      expect.any(Number),
      sourceFieldPaths([20, 21]),
    );
    expect(
      vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[2],
    ).toBeGreaterThan(1_000);
    expect(gridMock.revisionChanged).not.toHaveBeenCalled();

    await act(async () => latestWindow.resolve(new ArrayBuffer(2)));
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
    const dataWindows = JSON.parse(
      diagnosticsController.stop() ?? "null",
    ).dataWindows;
    expect(dataWindows).toMatchObject({
      queued: 3,
      started: 2,
      completed: 2,
      stale: 1,
      pendingAtStop: 0,
      pendingRequestDisposals: {
        supersededBeforeStart: 1,
        satisfiedByCompletedWindow: 0,
        invalidatedBeforeStart: 0,
      },
    });
    expect(dataWindows.recentRequests).toEqual([
      expect.objectContaining({
        reason: "columnProjection",
        rowOffset: 0,
        projectionKey: expect.any(String),
        outcome: "supersededBeforeStart",
      }),
      expect.objectContaining({
        reason: "rowWindow",
        rowOffset: 936,
        projectionKey: expect.any(String),
        stale: true,
      }),
      expect.objectContaining({
        reason: "rowWindow",
        projectionKey: expect.any(String),
        outcome: "completed",
        stale: false,
      }),
    ]);
  });

  it("keeps only the latest row window behind an active projection supplement", async () => {
    const projectionWindow = deferred<ArrayBuffer>();
    const rowWindow = deferred<ArrayBuffer>();
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
      .mockReturnValueOnce(projectionWindow.promise)
      .mockReturnValueOnce(rowWindow.promise);

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [20, 21],
        mountedRowStart: 0,
        mountedRowCount: 31,
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      0,
      62,
      sourceFieldPaths([20, 21]),
    );

    act(() => {
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

    await act(async () => projectionWindow.resolve(new ArrayBuffer(1)));
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      expect.any(Number),
      512,
      sourceFieldPaths([20, 21]),
    );
    expect(
      vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[2],
    ).toBeGreaterThan(1_000);

    await act(async () => rowWindow.resolve(new ArrayBuffer(2)));
    expect(desktop.getDataWindow).toHaveBeenCalledTimes(2);
  });

  it("preserves the usable base when an away request loses to a returning supplement", async () => {
    const awayWindow = deferred<ArrayBuffer>();
    const returningSupplement = deferred<ArrayBuffer>();
    const wideSource = {
      ...source,
      schema: Array.from({ length: 40 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow)
      .mockReturnValueOnce(awayWindow.promise)
      .mockReturnValueOnce(returningSupplement.promise);

    act(() => {
      reportViewport({
        rowStart: 1_000,
        rowCount: 3,
        columnIndices: [0, 1],
      });
      reportViewport({
        rowStart: 10,
        rowCount: 3,
        columnIndices: [0, 20],
        mountedRowStart: 10,
        mountedRowCount: 5,
      });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    await act(
      () =>
        new Promise<void>((resolve) => {
          window.setTimeout(resolve, 150);
        }),
    );
    gridMock.revisionChanged.mockReset();

    await act(async () => awayWindow.resolve(new ArrayBuffer(1)));

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      8,
      10,
      sourceFieldPaths([20]),
    );
    expect(gridMock.revisionChanged).not.toHaveBeenCalled();

    await act(async () => returningSupplement.resolve(new ArrayBuffer(2)));
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
    expect(gridMock.props?.getCellContent({ row: 10, column: 0 }).kind).toBe(
      "text",
    );
    expect(gridMock.props?.getCellContent({ row: 10, column: 20 }).kind).toBe(
      "text",
    );
  });

  it("loads row-only projection supplements without horizontal debounce", async () => {
    const verticalSupplement = deferred<ArrayBuffer>();
    const wideSource = {
      ...source,
      schema: Array.from({ length: 40 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());

    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [0, 20],
        mountedRowStart: 0,
        mountedRowCount: 31,
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(gridMock.props?.getCellContent({ row: 0, column: 20 }).kind).toBe(
        "text",
      ),
    );
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(
      verticalSupplement.promise,
    );
    gridMock.revisionChanged.mockReset();

    act(() => {
      reportViewport({
        rowStart: 40,
        rowCount: 3,
        columnIndices: [0, 20],
        mountedRowStart: 37,
        mountedRowCount: 31,
      });
    });

    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      0,
      22,
      62,
      sourceFieldPaths([20]),
    );
    expect(gridMock.props?.getCellContent({ row: 67, column: 20 }).kind).toBe(
      "loading",
    );

    await act(async () => verticalSupplement.resolve(new ArrayBuffer(3)));
    await waitFor(() =>
      expect(gridMock.props?.getCellContent({ row: 67, column: 20 }).kind).toBe(
        "text",
      ),
    );
    vi.mocked(desktop.getDataWindow).mockClear();

    act(() => {
      reportViewport({
        rowStart: 41,
        rowCount: 3,
        columnIndices: [0, 20],
        mountedRowStart: 38,
        mountedRowCount: 31,
      });
    });
    expect(desktop.getDataWindow).not.toHaveBeenCalled();
  });

  it("drops queued away windows after returning to cached rows", async () => {
    const activeAway = deferred<ArrayBuffer>();
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(activeAway.promise);

    act(() => {
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 2_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 10, rowCount: 3, columnIndices: [0, 1] });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    gridMock.revisionChanged.mockReset();

    await act(async () => activeAway.resolve(new ArrayBuffer(1)));

    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    expect(gridMock.revisionChanged).not.toHaveBeenCalled();
    expect(gridMock.props?.getCellContent({ row: 10, column: 0 }).kind).toBe(
      "text",
    );
  });

  it("applies an active visible window without dropping its queued prefetch", async () => {
    const activeWindow = deferred<ArrayBuffer>();
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(activeWindow.promise);

    act(() => {
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 2_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    gridMock.revisionChanged.mockReset();

    await act(async () => activeWindow.resolve(new ArrayBuffer(1)));

    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(desktop.getDataWindow).mock.calls;
    expect(calls[1]?.[2]).toBeLessThan(calls[0]?.[2] ?? 0);
    expect(gridMock.props?.getCellContent({ row: 1_000, column: 0 }).kind).toBe(
      "text",
    );
  });

  it("keeps horizontal debounce across repeated viewports in one mounted range", async () => {
    const wideSource = {
      ...source,
      schema: Array.from({ length: 40 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.useFakeTimers();
    try {
      act(() => {
        reportViewport({
          rowStart: 0,
          rowCount: 3,
          columnIndices: [0, 20],
          mountedRowStart: 0,
          mountedRowCount: 31,
        });
      });
      await act(async () => vi.advanceTimersByTimeAsync(60));
      act(() => {
        reportViewport({
          rowStart: 1,
          rowCount: 3,
          columnIndices: [0, 20],
          mountedRowStart: 0,
          mountedRowCount: 31,
        });
      });
      await act(async () => vi.advanceTimersByTimeAsync(59));
      expect(desktop.getDataWindow).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(desktop.getDataWindow).toHaveBeenCalledOnce();
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
        7,
        0,
        0,
        62,
        sourceFieldPaths([20]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores an obsolete window failure after returning to cached rows", async () => {
    const activeAway = deferred<ArrayBuffer>();
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(activeAway.promise);

    act(() => {
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 10, rowCount: 3, columnIndices: [0, 1] });
    });
    await act(async () => activeAway.reject(new Error("obsolete failure")));

    expect(screen.queryByRole("button", { name: "Retry window" })).toBeNull();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(gridMock.props?.getCellContent({ row: 10, column: 0 }).kind).toBe(
      "text",
    );
  });

  it("clears a failed supplement after returning to a base-only projection", async () => {
    const failedSupplement = deferred<ArrayBuffer>();
    const wideSource = {
      ...source,
      schema: Array.from({ length: 40 }, (_, index) => ({
        ...source.schema[0]!,
        name: `column_${index}`,
      })),
    };
    render(<DataGrid source={wideSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(
      failedSupplement.promise,
    );

    act(() => {
      reportViewport({ rowStart: 0, rowCount: 3, columnIndices: [0, 20] });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      reportViewport({ rowStart: 0, rowCount: 3, columnIndices: [0] });
    });
    await act(async () =>
      failedSupplement.reject(new Error("obsolete supplement")),
    );

    expect(screen.queryByRole("button", { name: "Retry window" })).toBeNull();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
    expect(gridMock.props?.getCellContent({ row: 0, column: 0 }).kind).toBe(
      "text",
    );
  });

  it("does not let an old viewChanged result replace a promoted view request", async () => {
    const oldWindow = deferred<ArrayBuffer>();
    const promotedWindow = deferred<ArrayBuffer>();
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataViewStatus).mockClear();
    vi.mocked(desktop.getDataWindow)
      .mockReturnValueOnce(oldWindow.promise)
      .mockReturnValueOnce(promotedWindow.promise);

    act(() => {
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
    });
    addNumberFilter("1");
    await waitFor(() => expect(gridMock.props?.rowCount).toBe(37));
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();
    gridMock.revisionChanged.mockReset();

    await act(async () =>
      oldWindow.reject(new desktop.DataWindowCommandError("viewChanged")),
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(desktop.getDataWindow).toHaveBeenLastCalledWith(
      7,
      1,
      expect.any(Number),
      expect.any(Number),
      sourceFieldPaths([0, 1]),
    );
    expect(desktop.getDataViewStatus).not.toHaveBeenCalled();

    await act(async () => promotedWindow.resolve(new ArrayBuffer(2)));
    await waitFor(() =>
      expect(gridMock.revisionChanged).toHaveBeenCalledOnce(),
    );
  });

  it("does not let same-view recovery replace a newer row request", async () => {
    const obsoleteWindow = deferred<ArrayBuffer>();
    const currentWindow = deferred<ArrayBuffer>();
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    vi.mocked(desktop.getDataWindow).mockClear();
    vi.mocked(desktop.getDataViewStatus).mockClear();
    vi.mocked(desktop.getDataWindow)
      .mockReturnValueOnce(obsoleteWindow.promise)
      .mockReturnValueOnce(currentWindow.promise);

    act(() => {
      reportViewport({ rowStart: 1_000, rowCount: 3, columnIndices: [0, 1] });
      reportViewport({ rowStart: 2_000, rowCount: 3, columnIndices: [0, 1] });
    });
    expect(desktop.getDataWindow).toHaveBeenCalledOnce();

    await act(async () =>
      obsoleteWindow.reject(new desktop.DataWindowCommandError("viewChanged")),
    );

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(desktop.getDataWindow).mock.calls.at(-1)?.[2],
    ).toBeGreaterThan(1_000);
    expect(desktop.getDataViewStatus).not.toHaveBeenCalled();

    await act(async () => currentWindow.resolve(new ArrayBuffer(2)));
    await waitFor(() =>
      expect(
        gridMock.props?.getCellContent({ row: 2_000, column: 0 }).kind,
      ).toBe("text"),
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
      code: "sourceChanged" as const,
      member: "year=2026/changed.parquet",
      message:
        "Dataset member year=2026/changed.parquet changed. Reload the dataset.",
    },
    {
      code: "invalidMember" as const,
      member: "year=2026/broken.parquet",
      message:
        "Dataset member year=2026/broken.parquet is damaged or unsupported. Reload the dataset.",
    },
    {
      code: "memberPermissionDenied" as const,
      member: "year=2026/private.parquet",
      message:
        "Fix permissions for dataset member year=2026/private.parquet, then reload the dataset.",
    },
  ])(
    "reloads the dataset instead of retrying a $code window",
    async (failure) => {
      const onReloadDataset = vi.fn();
      vi.mocked(desktop.getDataWindow).mockRejectedValue(
        new desktop.DataWindowCommandError(failure.code, undefined, {
          code: failure.code,
          member: failure.member,
        }),
      );

      render(<DataGrid source={source} onReloadDataset={onReloadDataset} />);

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(failure.message);
      expect(
        within(alert).queryByRole("button", { name: "Retry window" }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(alert).getByRole("button", { name: "Reload dataset" }),
      );

      expect(onReloadDataset).toHaveBeenCalledOnce();
    },
  );

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
        [{ fieldPath: ["column_1"], operator: "equals", values: ["2"] }],
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
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({
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

    fireEvent.click(within(sidebar).getByText("profile").closest("button")!);
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
        7,
        ["profile"],
        true,
      ),
    );
    expect(await within(sidebar).findByText("12.5%")).toBeInTheDocument();
    expect(within(sidebar).getByText("≈ 42")).toBeInTheDocument();
    expect(gridMock.scrollToColumn).toHaveBeenCalledWith(0, 16);
  });

  it("keeps Peek open and updates it as the active cell moves", async () => {
    const view = render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const first = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(first);
      gridMock.props?.onCellPeek?.(first.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).toHaveTextContent("row 0");
    const initialPlacement = screen.getByRole("dialog", {
      name: "Peek column_0",
    }).style.cssText;

    act(() => {
      gridMock.props?.onSelectionChange({
        ...first,
        current: {
          ...first.current,
          cell: { column: 0, row: 1 },
          range: { x: 0, y: 1, width: 1, height: 1 },
        },
      });
    });
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).toHaveTextContent("row 1");
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }).style.cssText,
    ).toBe(initialPlacement);
    expect(gridMock.focus).not.toHaveBeenCalled();

    act(() => {
      gridMock.props?.onSelectionChange({
        ...first,
        current: {
          ...first.current,
          cell: { column: 0, row: 9_999 },
          range: { x: 0, y: 9_999, width: 1, height: 1 },
        },
      });
    });
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).toHaveTextContent("Loading next cell…");
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).not.toHaveTextContent("row 1");

    act(() => gridMock.props?.onSelectionChange(first));

    act(() => {
      gridMock.props?.onCellPeek?.(
        { column: 0, row: 1 },
        { x: 300, y: 120, width: 120, height: 28 },
        "open",
      );
    });
    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).toHaveTextContent("row 1");

    act(() => gridMock.props?.onPeekFocus?.());
    expect(screen.getByRole("tree")).toHaveFocus();
    act(() => gridMock.props?.onScrollInteraction?.());
    expect(
      screen.queryByRole("dialog", { name: "Peek column_0" }),
    ).not.toBeInTheDocument();

    act(() => {
      gridMock.props?.onCellPeek?.(first.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(screen.getByRole("dialog", { name: "Peek column_0" })).toBeVisible();
    view.rerender(<DataGrid source={source} active={false} />);
    expect(
      screen.queryByRole("dialog", { name: "Peek column_0" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a loading Peek inert until the next Arrow window arrives", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(screen.getByRole("tree")).toBeInTheDocument();

    const nextWindow = deferred<ArrayBuffer>();
    vi.mocked(desktop.getDataWindow).mockReturnValueOnce(nextWindow.promise);
    act(() => {
      gridMock.props?.onSelectionChange({
        ...selection,
        current: {
          ...selection.current,
          cell: { column: 0, row: 9_999 },
          range: { x: 0, y: 9_999, width: 1, height: 1 },
        },
      });
      reportViewport({
        rowStart: 9_990,
        rowCount: 10,
        columnIndices: [0],
      });
    });

    const dialog = screen.getByRole("dialog", { name: "Peek column_0" });
    expect(dialog).toHaveTextContent("Loading next cell…");
    expect(screen.queryByRole("tree")).not.toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "c", ctrlKey: true });
    expect(clipboardWrite).not.toHaveBeenCalled();
    act(() => gridMock.props?.onPeekFocus?.());

    await act(async () => nextWindow.resolve(new ArrayBuffer(0)));
    const tree = await screen.findByRole("tree");
    expect(tree).toHaveFocus();
    fireEvent.keyDown(tree, {
      key: "c",
      ctrlKey: true,
    });
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
  });

  it("shows Peek copy failure when the system clipboard rejects the write", async () => {
    clipboardWrite.mockRejectedValueOnce(new Error("clipboard unavailable"));
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });

    fireEvent.keyDown(screen.getByRole("tree"), {
      key: "c",
      ctrlKey: true,
    });

    expect(
      await screen.findByText("The JSON value could not be copied."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Copied JSON.")).not.toBeInTheDocument();
  });

  it("uses the source schema JSON hint after visible-column reordering", async () => {
    const json = '{"wide":1.2300e+400}';
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 3,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: fieldPaths.map(() => ({ type: utf8() })) },
          getChildAt: (offset: number) => ({
            at: () =>
              fieldPaths[offset]?.at(-1) === "json_value" ? json : json,
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(
      <DataGrid
        source={{
          ...source,
          rowCount: 3,
          schema: [
            {
              name: "plain",
              physicalType: "BYTE_ARRAY",
              logicalType: "String",
              children: [],
            },
            {
              name: "json_value",
              physicalType: "BYTE_ARRAY",
              logicalType: "JSON",
              children: [],
            },
          ],
        }}
      />,
    );
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalled());
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    await waitFor(() =>
      expect(gridMock.props?.columns[0]?.title).toBe("json_value"),
    );

    act(() => {
      const selection = {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { column: 0, row: 0 },
          range: { x: 0, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      };
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(
      await screen.findByText("wide", { selector: ".value-tree-name.is-key" }),
    ).toBeInTheDocument();

    act(() => {
      const selection = {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: { column: 1, row: 0 },
          range: { x: 1, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      };
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(
        selection.current.cell,
        { x: 20, y: 20, width: 120, height: 28 },
        "open",
      );
    });
    expect(
      screen.getByRole("dialog", { name: "Peek plain" }),
    ).toHaveTextContent(json);
    expect(
      screen.queryByText("wide", { selector: ".value-tree-name.is-key" }),
    ).not.toBeInTheDocument();
  });

  it("uses a lazily loaded JSON hint beyond the truncated schema prefix", async () => {
    const json = '{"nested":{"answer":42}}';
    const prefix = Array.from({ length: 256 }, (_value, index) => ({
      name: `plain_${index}`,
      physicalType: "BYTE_ARRAY",
      logicalType: "String",
      children: [],
    }));
    const page = Array.from({ length: 44 }, (_value, index) => ({
      name: index === 43 ? "json_value" : `plain_${256 + index}`,
      physicalType: "BYTE_ARRAY",
      logicalType: index === 43 ? "JSON" : "String",
      children: [],
    }));
    vi.mocked(desktop.getSourceSchemaPage).mockResolvedValue({
      offset: 256,
      totalCount: 300,
      columns: page,
    });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 3,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: fieldPaths.map(() => ({ type: utf8() })) },
          getChildAt: (offset: number) => ({
            at: () =>
              fieldPaths[offset]?.at(-1) === "json_value" ? json : "plain",
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(
      <DataGrid
        source={{
          ...source,
          rowCount: 3,
          columnCount: 300,
          schema: prefix,
          schemaNodeCount: 300,
          schemaIsTruncated: true,
        }}
      />,
    );

    await waitFor(() => expect(gridMock.props?.columns).toHaveLength(300));
    act(() => {
      reportViewport({
        rowStart: 0,
        rowCount: 3,
        columnIndices: [299],
        mountedColumnIndices: [299],
      });
    });
    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenLastCalledWith(7, 0, 0, 3, [
        ["json_value"],
      ]),
    );
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 299, row: 0 },
        range: { x: 299, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(selection);
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });

    expect(
      await screen.findByText("nested", {
        selector: ".value-tree-name.is-key",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Peek json_value" }),
    ).toBeVisible();
  });

  it("keeps Peek parse, search, and expansion progress across unrelated rerenders", async () => {
    const json = JSON.stringify(
      Array.from({ length: 10_000 }, (_value, index) => ({ value: index })),
    );
    const emojiFont = deferred<void>();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        *[Symbol.iterator]() {
          yield { family: '"Noto Emoji"', load: () => emojiFont.promise };
        },
      },
    });
    const jsonSource: desktop.SourceSummary = {
      ...source,
      rowCount: 1,
      schema: [
        {
          name: "json_value",
          physicalType: "BYTE_ARRAY",
          logicalType: "JSON",
          children: [],
        },
      ],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: [{ type: utf8() }] },
          getChildAt: () => ({ at: () => json }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    const view = render(<DataGrid source={jsonSource} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => gridMock.props?.onSelectionChange(selection));
    gridMock.props?.getCellContent(selection.current.cell);
    vi.useFakeTimers();
    try {
      act(() =>
        gridMock.props?.onCellPeek?.(selection.current.cell, {
          x: 20,
          y: 20,
          width: 120,
          height: 28,
        }),
      );

      await act(async () => vi.runOnlyPendingTimersAsync());
      const firstParse = progressNumber(/Parsing JSON · ([\d,]+) of/);
      view.rerender(
        <DataGrid
          source={{
            ...jsonSource,
            schema: jsonSource.schema.map((field) => ({ ...field })),
          }}
        />,
      );
      await act(async () => emojiFont.resolve());
      await act(async () => vi.runOnlyPendingTimersAsync());
      expect(progressNumber(/Parsing JSON · ([\d,]+) of/)).toBeGreaterThan(
        firstParse,
      );
      await act(async () => vi.runAllTimersAsync());

      const search = screen.getByRole("searchbox", {
        name: "Search keys and values",
      });
      fireEvent.change(search, { target: { value: "not-present" } });
      await act(async () => vi.runOnlyPendingTimersAsync());
      const firstSearch = progressNumber(/([\d,]+) characters/);
      act(() => gridMock.props?.onColumnResize(0, 240));
      await act(async () => vi.runOnlyPendingTimersAsync());
      expect(progressNumber(/([\d,]+) characters/)).toBeGreaterThan(
        firstSearch,
      );
      fireEvent.change(search, { target: { value: "" } });

      fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
      await act(async () => vi.runOnlyPendingTimersAsync());
      const firstExpand = progressNumber(/Expanding after ([\d,]+) nodes/);
      view.rerender(<DataGrid source={jsonSource} />);
      await act(async () => vi.runOnlyPendingTimersAsync());
      expect(progressNumber(/Expanding after ([\d,]+) nodes/)).toBeGreaterThan(
        firstExpand,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one active-cell materialization between the grid and Peek", async () => {
    const emojiFont = deferred<void>();
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        *[Symbol.iterator]() {
          yield { family: '"Noto Emoji"', load: () => emojiFont.promise };
        },
      },
    });
    const at = vi.fn((row: number) => `row ${row}`);
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 512,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({ type: utf8() })),
          },
          getChildAt: () => ({ at }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    const view = render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(selection);
    });
    expect(at).not.toHaveBeenCalled();

    expect(
      gridMock.props?.getCellContent(selection.current.cell),
    ).toMatchObject({ kind: "text", displayData: "row 0" });
    expect(at).toHaveBeenCalledOnce();

    act(() => {
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(at).toHaveBeenCalledOnce();

    view.rerender(<DataGrid source={source} />);
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    gridMock.revisionChanged.mockClear();
    await act(async () => emojiFont.resolve());
    await waitFor(() => expect(gridMock.revisionChanged).toHaveBeenCalled());
    expect(at).toHaveBeenCalledOnce();

    const secondSelection = {
      ...selection,
      current: {
        ...selection.current,
        cell: { column: 0, row: 1 },
        range: { x: 0, y: 1, width: 1, height: 1 },
      },
    };
    act(() => {
      gridMock.props?.onSelectionChange(secondSelection);
    });
    expect(at).toHaveBeenCalledTimes(2);
    expect(
      gridMock.props?.getCellContent(secondSelection.current.cell),
    ).toMatchObject({ kind: "text", displayData: "row 1" });
    expect(at).toHaveBeenCalledTimes(2);

    act(() => gridMock.props?.onSort(0, false));
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    act(() => gridMock.props?.onSelectionChange(secondSelection));
    expect(
      gridMock.props?.getCellContent(secondSelection.current.cell),
    ).toMatchObject({ kind: "text", displayData: "row 1" });
    expect(at).toHaveBeenCalledTimes(3);
    act(() => {
      gridMock.props?.onCellPeek?.(secondSelection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(at).toHaveBeenCalledTimes(3);
  });

  it("releases a cached large value when its selection or window is replaced", async () => {
    const largeValue = "x".repeat(2 * 1024 * 1024);
    const firstAt = vi.fn(() => largeValue);
    const replacementAt = vi.fn((row: number) => `replacement ${row}`);
    let decodeCount = 0;
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => {
        const at = decodeCount === 0 ? firstAt : replacementAt;
        decodeCount += 1;
        return {
          rowOffset,
          rowCount: 512,
          fieldPaths,
          fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
          table: {
            schema: {
              fields: fieldPaths.map(() => ({ type: utf8() })),
            },
            getChildAt: () => ({ at }),
          } as unknown as ArrowDataWindow["table"],
        };
      },
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const activeSelection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => gridMock.props?.onSelectionChange(activeSelection));
    gridMock.props?.getCellContent(activeSelection.current.cell);
    expect(firstAt).toHaveBeenCalledOnce();

    act(() =>
      gridMock.props?.onSelectionChange({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
      }),
    );
    act(() => gridMock.props?.onSelectionChange(activeSelection));
    gridMock.props?.getCellContent(activeSelection.current.cell);
    expect(firstAt).toHaveBeenCalledTimes(2);

    act(() => {
      gridMock.props?.onViewportChange({
        rowStart: 1_000,
        rowCount: 5,
        columnIndices: [0],
        mountedRowStart: 997,
        mountedRowCount: 11,
        mountedColumnIndices: [0],
      });
    });
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    const replacementSelection = {
      ...activeSelection,
      current: {
        ...activeSelection.current,
        cell: { column: 0, row: 1_000 },
        range: { x: 0, y: 1_000, width: 1, height: 1 },
      },
    };
    act(() => gridMock.props?.onSelectionChange(replacementSelection));
    gridMock.props?.getCellContent(replacementSelection.current.cell);
    act(() => {
      gridMock.props?.onCellPeek?.(replacementSelection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(replacementAt).toHaveBeenCalledOnce();
  });

  it("does not populate or replace the active-cell cache while copying", async () => {
    const at = vi.fn((row: number) => `row ${row}`);
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 512,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: {
            fields: fieldPaths.map(() => ({ type: utf8() })),
          },
          getChildAt: () => ({ at }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    const selection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 0, row: 0 },
        range: { x: 0, y: 0, width: 1, height: 1 },
        rangeStack: [],
      },
    };
    act(() => gridMock.props?.onSelectionChange(selection));

    copyFromGrid();
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(at).toHaveBeenCalledOnce();
    gridMock.props?.getCellContent(selection.current.cell);
    expect(at).toHaveBeenCalledTimes(2);
    act(() => {
      gridMock.props?.onCellPeek?.(selection.current.cell, {
        x: 20,
        y: 20,
        width: 120,
        height: 28,
      });
    });
    expect(at).toHaveBeenCalledTimes(2);

    clipboardWrite.mockClear();
    copyFromGrid();
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce());
    expect(at).toHaveBeenCalledTimes(3);
    gridMock.props?.getCellContent(selection.current.cell);
    expect(at).toHaveBeenCalledTimes(3);
  });

  it("opens Peek from the cell context menu and returns focus to the grid", async () => {
    render(<DataGrid source={source} />);
    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledOnce());
    act(() => {
      gridMock.props?.onCellContextMenu(
        { column: 0, row: 2 },
        { x: 20, y: 20, width: 120, height: 28 },
      );
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Peek/ }));

    expect(
      screen.getByRole("dialog", { name: "Peek column_0" }),
    ).toHaveTextContent("row 2");
    expect(gridMock.focus).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close Peek" }));
    expect(
      screen.queryByRole("dialog", { name: "Peek column_0" }),
    ).not.toBeInTheDocument();
    expect(gridMock.focus).toHaveBeenCalledTimes(2);
  });

  it("keeps duplicate top-level columns ordered by source identity", async () => {
    const duplicateSource: desktop.SourceSummary = {
      ...source,
      columnCount: 2,
      rowCount: 1,
      schema: [
        { ...source.schema[0]!, name: "duplicate" },
        { ...source.schema[1]!, name: "duplicate" },
      ],
      schemaNodeCount: 2,
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: new Map([[JSON.stringify(["duplicate"]), 0]]),
        table: {
          schema: { fields: [{ type: utf8() }, { type: utf8() }] },
          getChildAt: (offset: number) => ({
            at: () => (offset === 0 ? "first value" : "second value"),
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );

    render(<DataGrid source={duplicateSource} />);

    await waitFor(() =>
      expect(desktop.getDataWindow).toHaveBeenCalledWith(7, 0, 0, 1, [
        ["duplicate"],
        ["duplicate"],
      ]),
    );
    expect(gridMock.props?.columns).toMatchObject([
      { id: "source:0", sortable: false, filterable: false },
      { id: "source:1", sortable: false, filterable: false },
    ]);
    expect(gridMock.props?.getCellContent({ column: 0, row: 0 })).toMatchObject(
      { displayData: "first value" },
    );
    expect(gridMock.props?.getCellContent({ column: 1, row: 0 })).toMatchObject(
      { displayData: "second value" },
    );
    const reason = screen.getByText(/This file repeats column names/);
    expect(reason).toBeVisible();
    const query = screen.getByLabelText("Query");
    const where = query.querySelector(".query-where");
    const orderBy = query.querySelector(".query-order");
    expect(where).toHaveAccessibleName(
      "WHERE unavailable: duplicate column names",
    );
    expect(orderBy).toHaveAccessibleName(
      "ORDER BY unavailable: duplicate column names",
    );
    expect(where).not.toHaveAttribute("aria-describedby");
    expect(orderBy).not.toHaveAttribute("aria-describedby");
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const schemaPathActions = within(
      screen.getByRole("complementary", { name: "Schema sidebar" }),
    )
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("disabled"));
    expect(schemaPathActions.length).toBeGreaterThan(0);
    schemaPathActions.forEach((button) => {
      expect(button).not.toHaveAttribute("aria-describedby");
      expect(button).toHaveAccessibleName(/duplicate column names/);
    });
    openGridMenu();
    const unavailableExport = screen.getAllByRole("menuitem", {
      name: /Export is unavailable because this file repeats column names/,
    });
    expect(unavailableExport.length).toBeGreaterThan(0);
    unavailableExport.forEach((action) => expect(action).toBeDisabled());
    expect(desktop.startDataExport).not.toHaveBeenCalled();

    clipboardWrite.mockClear();
    act(() =>
      gridMock.props?.onCellPeek?.(
        { column: 1, row: 0 },
        { x: 20, y: 20, width: 120, height: 28 },
      ),
    );
    expect(
      screen.getByRole("dialog", { name: "Peek duplicate" }),
    ).toHaveTextContent("second value");
    expect(
      screen.queryByRole("button", { name: "Copy path" }),
    ).not.toBeInTheDocument();
    expect(clipboardWrite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close Peek" }));

    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      "source:1",
      "source:0",
    ]);
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      "source:0",
    ]);
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
  });

  it("retains duplicate source identities across sample schema transitions", async () => {
    const duplicateSource: desktop.SourceSummary = {
      ...source,
      columnCount: 2,
      rowCount: 1,
      schemaNodeCount: 2,
      schema: [
        { ...source.schema[0]!, name: "duplicate" },
        { ...source.schema[1]!, name: "duplicate" },
      ],
    };
    const view = render(
      <DataGrid source={duplicateSource} contentIdentity="early-sample" />,
    );
    act(() => gridMock.props?.onColumnResize(0, 231));
    openColumnMenu(0);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin column" }));

    view.rerender(
      <DataGrid
        source={{
          ...duplicateSource,
          rowCount: 2,
          schema: structuredClone(duplicateSource.schema),
        }}
        contentIdentity="complete"
      />,
    );

    await waitFor(() =>
      expect(gridMock.props?.columns).toMatchObject([
        { id: "source:0", width: 231, pinned: true },
        { id: "source:1", pinned: false },
      ]),
    );
    openColumnMenu(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide column" }));
    view.rerender(
      <DataGrid
        source={{
          ...duplicateSource,
          rowCount: 3,
          schema: structuredClone(duplicateSource.schema),
        }}
        contentIdentity="refreshed"
      />,
    );
    await waitFor(() =>
      expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
        "source:0",
      ]),
    );
  });

  it("does not share runtime types between heterogeneous duplicate columns", async () => {
    const duplicateSource: desktop.SourceSummary = {
      ...source,
      columnCount: 2,
      rowCount: 1,
      schemaNodeCount: 3,
      schema: [
        {
          name: "duplicate",
          physicalType: "BYTE_ARRAY",
          logicalType: "String",
          children: [],
        },
        {
          name: "duplicate",
          physicalType: "GROUP",
          logicalType: null,
          children: [{ ...source.schema[0]!, name: "physical_child" }],
        },
      ],
    };
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: new Map([[JSON.stringify(["duplicate"]), 0]]),
        table: {
          schema: {
            fields: [
              { type: utf8() },
              { type: struct({ runtime_child: utf8() }) },
            ],
          },
          getChildAt: (offset: number) => ({
            at: () =>
              offset === 0 ? "scalar value" : { runtime_child: "nested" },
          }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );
    render(<DataGrid source={duplicateSource} />);
    await waitFor(() =>
      expect(
        gridMock.props?.getCellContent({ column: 0, row: 0 }),
      ).toMatchObject({ displayData: "scalar value" }),
    );
    expect(gridMock.props?.getCellContent({ column: 1, row: 0 })).toMatchObject(
      { displayData: expect.stringContaining("runtime_child") },
    );

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    expect(within(sidebar).getByText("physical_child")).toBeVisible();
    expect(within(sidebar).queryByText("runtime_child")).toBeNull();
    expect(within(sidebar).getAllByText("duplicate")).toHaveLength(2);
  });

  it("keeps a struct readable but disables flatten for duplicate child names", async () => {
    const nestedDuplicateSource: desktop.SourceSummary = {
      ...source,
      columnCount: 1,
      rowCount: 1,
      schema: [
        {
          name: "profile",
          physicalType: "GROUP",
          logicalType: null,
          children: [
            {
              name: "city",
              physicalType: "GROUP",
              logicalType: null,
              children: [{ ...source.schema[0]!, name: "name" }],
            },
            {
              name: "city",
              physicalType: "GROUP",
              logicalType: null,
              children: [{ ...source.schema[0]!, name: "name" }],
            },
          ],
        },
      ],
      schemaNodeCount: 5,
    };
    const profileType = struct({ city: struct({ name: utf8() }) });
    decodeArrowWindow.mockImplementation(
      (
        _bytes: ArrayBuffer,
        rowOffset: number,
        fieldPaths: readonly desktop.FieldPath[],
      ): ArrowDataWindow => ({
        rowOffset,
        rowCount: 1,
        fieldPaths,
        fieldColumnOffsets: fieldColumnOffsets(fieldPaths),
        table: {
          schema: { fields: fieldPaths.map(() => ({ type: profileType })) },
          getChildAt: () => ({ at: () => ({ city: { name: "Utrecht" } }) }),
        } as unknown as ArrowDataWindow["table"],
      }),
    );

    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(<DataGrid source={nestedDuplicateSource} />);
    await waitFor(() =>
      expect(
        gridMock.props?.getCellContent({ column: 0, row: 0 }),
      ).toBeDefined(),
    );

    openColumnMenu(0);
    const flatten = screen.getByRole("menuitem", {
      name: "Flatten profile. Unavailable: duplicate child names.",
    });
    expect(flatten).toBeDisabled();
    expect(flatten).toHaveAccessibleName(
      "Flatten profile. Unavailable: duplicate child names.",
    );
    expect(flatten).toHaveTextContent("FlattenDuplicate child names");
    expect(flatten.querySelector(".menu-shortcut")).toHaveTextContent(
      "Duplicate child names",
    );
    expect(flatten).toHaveAttribute(
      "title",
      "Flatten is unavailable because this struct contains duplicate child names.",
    );
    expect(gridMock.props?.columns).toHaveLength(1);
    expect(gridMock.props?.columns[0]?.id).toBe('["profile"]');

    act(() =>
      gridMock.props?.onCellPeek?.(
        { column: 0, row: 0 },
        { x: 20, y: 20, width: 120, height: 28 },
      ),
    );
    const tree = await screen.findByRole("tree", { name: "profile value" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    fireEvent.contextMenu(screen.getByRole("treeitem", { selected: true }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Promote to column" }),
    );
    expect(gridMock.props?.columns.map((column) => column.id)).toEqual([
      '["profile"]',
    ]);
    expect(
      screen.getByText(
        "profile.city cannot be promoted because its field path is ambiguous.",
      ),
    ).toHaveTextContent(
      "profile.city cannot be promoted because its field path is ambiguous.",
    );
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close Peek" }));

    const picker = openSelectPicker();
    const profile = within(picker).getByRole("checkbox", {
      name: "Project profile",
    });
    expect(profile).toBeChecked();
    fireEvent.click(profile);
    expect(profile).not.toBeChecked();
    expect(
      screen.getByLabelText("Query").querySelector(".query-select"),
    ).toHaveTextContent("[0 cols]");
    expect(screen.queryByTestId("viewda-grid")).not.toBeInTheDocument();
    expect(desktop.prepareDataView).not.toHaveBeenCalled();
    const duplicateChildren = within(picker).getAllByRole("checkbox", {
      name: "Project profile.city",
    });
    expect(duplicateChildren).toHaveLength(2);
    duplicateChildren.forEach((child) => {
      expect(child).toBeDisabled();
      expect(child.closest(".column-picker-row")).toHaveTextContent(
        /contains duplicate child names/,
      );
    });
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("same key");
    consoleError.mockRestore();
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
          nullCount: 100,
          nullShare: 0.01,
          approximateDistinctCount: 31_300_000,
          containerCount: null,
        })
        .mockResolvedValueOnce({
          minimum: "001",
          maximum: "zzz",
          minMaxComputed: true,
          nullCount: 100,
          nullShare: 0.01,
          approximateDistinctCount: 31_300_000,
          containerCount: null,
        });
      render(<DataGrid source={byteArraySource} />);

      fireEvent.click(screen.getByRole("button", { name: "Schema" }));
      const sidebar = screen.getByRole("complementary", {
        name: "Schema sidebar",
      });
      fireEvent.click(within(sidebar).getByRole("button", { name: /label/ }));

      await waitFor(() =>
        expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
          7,
          ["label"],
          false,
        ),
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
          ["label"],
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
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
        7,
        ["column_0"],
        true,
      ),
    );
    expect(await within(sidebar).findByText("Minimum")).toBeInTheDocument();
    expect(within(sidebar).getByText("1")).toBeInTheDocument();
    expect(within(sidebar).getByText("9")).toBeInTheDocument();
    expect(
      within(sidebar).queryByRole("button", { name: "Compute min/max" }),
    ).not.toBeInTheDocument();
  });

  it("drops early-sample statistics when the complete dataset replaces it", async () => {
    vi.mocked(desktop.getColumnStatistics)
      .mockResolvedValueOnce({
        minimum: "1",
        maximum: "2",
        minMaxComputed: true,
        nullCount: 1_250,
        nullShare: 0.125,
        approximateDistinctCount: 2,
        containerCount: null,
      })
      .mockResolvedValueOnce({
        minimum: "1",
        maximum: "9",
        minMaxComputed: true,
        nullCount: 5_050,
        nullShare: 0.5,
        approximateDistinctCount: 9,
        containerCount: null,
      });
    const { rerender } = render(
      <DataGrid source={source} contentIdentity="early-sample" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    let sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_0/ }));
    expect(await within(sidebar).findByText("12.5%")).toBeInTheDocument();
    vi.mocked(desktop.cancelColumnStatistics).mockClear();

    rerender(
      <DataGrid
        source={{ ...source, rowCount: source.rowCount + 100 }}
        contentIdentity="complete"
      />,
    );

    sidebar = screen.getByRole("complementary", { name: "Schema sidebar" });
    expect(
      within(sidebar).getByText("Select a column to scan its statistics."),
    ).toBeInTheDocument();
    expect(within(sidebar).queryByText("12.5%")).not.toBeInTheDocument();
    expect(desktop.cancelColumnStatistics).toHaveBeenCalledWith(7);

    fireEvent.click(within(sidebar).getByRole("button", { name: /column_0/ }));
    expect(await within(sidebar).findByText("50%")).toBeInTheDocument();
    expect(desktop.getColumnStatistics).toHaveBeenCalledTimes(2);
  });

  it("lets the backend replace an active statistics scan", async () => {
    const firstStatistics = deferred<desktop.ColumnStatistics>();
    vi.mocked(desktop.getColumnStatistics)
      .mockReturnValueOnce(firstStatistics.promise)
      .mockResolvedValueOnce({
        minimum: "2",
        maximum: "8",
        minMaxComputed: true,
        nullCount: 0,
        nullShare: 0,
        approximateDistinctCount: 4,
        containerCount: null,
      });
    render(<DataGrid source={source} />);

    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    const sidebar = screen.getByRole("complementary", {
      name: "Schema sidebar",
    });
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_2/ }));
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
        7,
        ["column_2"],
        true,
      ),
    );
    fireEvent.click(within(sidebar).getByRole("button", { name: /column_4/ }));
    await waitFor(() =>
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
        7,
        ["column_4"],
        true,
      ),
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
      expect(desktop.getColumnStatistics).toHaveBeenCalledWith(
        7,
        ["column_3"],
        true,
      ),
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
  it("keeps export unavailable until dataset inspection finishes", async () => {
    render(<DataGrid source={source} exportEnabled={false} />);
    await act(async () => {});

    expect(desktop.getDataExportStatus).not.toHaveBeenCalled();
    openGridMenu();
    expect(
      screen.getByRole("menuitem", {
        name: "Export is available after dataset inspection finishes",
      }),
    ).toBeDisabled();

    fireEvent.keyDown(window, { key: "E", ctrlKey: true, shiftKey: true });
    expect(desktop.startDataExport).not.toHaveBeenCalled();
  });

  it("exports the active filtered and sorted view revision", async () => {
    render(<DataGrid source={source} />);
    addNumberFilter("4");
    await waitFor(() =>
      expect(desktop.prepareDataView).toHaveBeenLastCalledWith(
        7,
        1,
        [{ fieldPath: ["column_0"], operator: "equals", values: ["4"] }],
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
        [{ fieldPath: ["column_0"], operator: "equals", values: ["4"] }],
        [{ fieldPath: ["column_1"], direction: "ascending" }],
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
        fieldPaths: sourceFieldPaths([0, 1, 2, 3, 4, 5, 6, 7]),
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
          fieldPaths: sourceFieldPaths([0, 1, 2, 3, 4]),
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

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledOnce(), {
      timeout: 5_000,
    });
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

    const alert = await screen.findByRole("alert", {}, { timeout: 5_000 });
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

function progressNumber(pattern: RegExp): number {
  const status =
    document.querySelector(".value-tree-status")?.textContent ?? "";
  const match = pattern.exec(status)?.[1];
  if (match === undefined) throw new Error(`Progress did not match: ${status}`);
  return Number(match.replaceAll(",", ""));
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
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function desktopSelection(index?: number): CompactSelection {
  return index === undefined
    ? CompactSelection.empty()
    : CompactSelection.fromSingleSelection(index);
}
