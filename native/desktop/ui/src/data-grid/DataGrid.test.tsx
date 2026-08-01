import {
  type DataEditorProps,
  type DataEditorRef,
} from "@glideapps/glide-data-grid";
import { cleanup, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as desktop from "../desktop";
import { DataGrid } from "./DataGrid";
import type { ArrowDataWindow } from "./arrow-window";

const editorMock = vi.hoisted(() => ({
  props: undefined as DataEditorProps | undefined,
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
          ({ updateCells: editorMock.updateCells }) as unknown as DataEditorRef,
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
  editorMock.updateCells.mockReset();
  decodeArrowWindow.mockImplementation(
    (_bytes: ArrayBuffer, rowOffset: number): ArrowDataWindow => ({
      rowOffset,
      rowCount: 100,
      table: {
        schema: { fields: [] },
      } as unknown as ArrowDataWindow["table"],
    }),
  );
  vi.spyOn(desktop, "getDataWindow").mockResolvedValue(new ArrayBuffer(0));
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

    const visibleRegionChanged = editorMock.props?.onVisibleRegionChanged;
    expect(visibleRegionChanged).toBeTypeOf("function");
    act(() => {
      visibleRegionChanged?.({ x: 3, y: 500, width: 4, height: 5 }, 0, 0, {
        freezeRegions: [{ x: 0, y: 500, width: 1, height: 5 }],
      });
    });

    await waitFor(() => expect(desktop.getDataWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editorMock.updateCells).toHaveBeenCalledOnce());

    const damage = editorMock.updateCells.mock.calls[0]?.[0] as {
      cell: readonly [number, number];
    }[];
    expect(damage).toHaveLength(25);
    expect(damage).toContainEqual({ cell: [0, 500] });
    expect(damage).toContainEqual({ cell: [3, 500] });
    expect(damage).toContainEqual({ cell: [6, 504] });
    expect(damage).not.toContainEqual({ cell: [1, 500] });
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
});
