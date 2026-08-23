import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyGridSelection, selectCell } from "./grid-selection";
import {
  ViewdaGrid,
  browserMeasurementPort,
  type GridMeasurementPort,
  type ViewdaGridHandle,
  type ViewdaGridProps,
} from "./ViewdaGrid";
import type { GridColumn } from "./grid-model";
import {
  createGridPerformanceController,
  type GridDiagnosticsController,
} from "./grid-performance-report";

// Exceeds every fake extent so probe tests exercise clamped read-back. The value
// is unrelated to the production sentinel. Increase it if a fake extent grows.
const OVERSIZED_TEST_EXTENT = 1_000_000_000;
let diagnosticsController: GridDiagnosticsController | null = null;

afterEach(() => {
  diagnosticsController?.dispose();
  diagnosticsController = null;
  cleanup();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "releasePointerCapture");
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
});

function createDiagnostics() {
  diagnosticsController = createGridPerformanceController();
  return diagnosticsController;
}

function startDiagnostics(controller: GridDiagnosticsController) {
  controller.start({
    runtime: {
      appVersion: "test",
      queryEngineVersion: "test",
      userAgent: "test",
      platform: "test",
      theme: "light",
    },
    source: { sizeBytes: 1, rowCount: 1_000_000_000, columnCount: 40 },
  });
}

function installPointerCapture() {
  const captures = new Set<number>();
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  setPointerCapture.mockImplementation((pointerId: number) => {
    captures.add(pointerId);
  });
  releasePointerCapture.mockImplementation((pointerId: number) => {
    captures.delete(pointerId);
  });
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: {
      configurable: true,
      value: vi.fn((pointerId: number) => captures.has(pointerId)),
    },
    releasePointerCapture: {
      configurable: true,
      value: releasePointerCapture,
    },
  });
  return { setPointerCapture, releasePointerCapture };
}

function column(index: number, pinned = false): GridColumn {
  return {
    id: String(index),
    title: `Column ${index}`,
    width: 100,
    monospace: false,
    pinned,
    pending: false,
    sortable: true,
    filterable: true,
    sort: { direction: "neutral" },
  };
}

function measurementPort(
  width: number,
  height: number,
  safeExtent = 1_000_000,
): GridMeasurementPort {
  return {
    read: (scrollport) => ({
      width,
      height,
      scrollTop: scrollport.scrollTop,
      scrollLeft: scrollport.scrollLeft,
      devicePixelRatio: 1.5,
    }),
    observe: () => () => undefined,
    bounds: () => ({ x: 1, y: 2, width: 100, height: 28 }),
    probeScrollExtent: () => ({
      vertical: safeExtent,
      horizontal: safeExtent,
    }),
  };
}

function wheelEvent(init: WheelEventInit, timeStamp: number): WheelEvent {
  const event = new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  return event;
}

function transformY(element: HTMLElement | null): number {
  const match = element?.style.transform.match(/^translateY\((-?[\d.]+)px\)$/);
  return Number(match?.[1] ?? 0);
}

function props(overrides: Partial<ViewdaGridProps> = {}): ViewdaGridProps {
  return {
    columns: Array.from({ length: 12 }, (_, index) => column(index)),
    rowCount: 1_000,
    selection: emptyGridSelection(),
    contentRevision: 0,
    getCellContent: ({ row, column: columnIndex }) => ({
      kind: "text",
      displayData: `${row}:${columnIndex}`,
      copyData: `${row}:${columnIndex}`,
      alignment: "left",
      faded: false,
    }),
    onSelectionChange: vi.fn(),
    onViewportChange: vi.fn(),
    onColumnResize: vi.fn(),
    onColumnAutoFit: vi.fn(),
    onSort: vi.fn(),
    onFilter: vi.fn(),
    onHeaderContextMenu: vi.fn(),
    onCellContextMenu: vi.fn(),
    onCopy: vi.fn(),
    onHorizontalExtentChange: vi.fn(),
    measurementPort: measurementPort(420, 84),
    ...overrides,
  };
}

function installProbeElements({
  verticalLimit,
  horizontalLimit,
  clientHeight,
  clientWidth,
  scrollHeight,
  scrollWidth,
  zeroBeyondLimit = false,
  failVerticalRead = false,
}: {
  verticalLimit: number;
  horizontalLimit: number;
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
  zeroBeyondLimit?: boolean;
  failVerticalRead?: boolean;
}): {
  scrollport: HTMLElement;
  horizontalAssignments: number[];
  verticalAssignments: number[];
} {
  const scrollport = document.createElement("div");
  const spacer = document.createElement("div");
  let scrollTop = 0;
  let scrollLeft = 0;
  const verticalAssignments: number[] = [];
  const horizontalAssignments: number[] = [];
  const assignedPosition = (value: number, limit: number) =>
    zeroBeyondLimit && value > limit ? 0 : Math.min(value, limit);
  Object.defineProperties(scrollport, {
    clientHeight: { configurable: true, value: clientHeight },
    clientWidth: { configurable: true, value: clientWidth },
    scrollHeight: {
      configurable: true,
      get: () => {
        if (failVerticalRead) {
          throw new Error("extent read failed");
        }
        return scrollHeight;
      },
    },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        verticalAssignments.push(value);
        scrollTop = assignedPosition(value, verticalLimit);
      },
    },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        horizontalAssignments.push(value);
        scrollLeft = assignedPosition(value, horizontalLimit);
      },
    },
  });
  vi.spyOn(document, "createElement")
    .mockReturnValueOnce(scrollport)
    .mockReturnValueOnce(spacer);
  return { scrollport, horizontalAssignments, verticalAssignments };
}

describe("browser measurement port", () => {
  it("uses the clamped position and reported extent for each axis", () => {
    const { scrollport } = installProbeElements({
      verticalLimit: 900,
      horizontalLimit: 3_500,
      clientHeight: 10,
      clientWidth: 7,
      scrollHeight: 910,
      scrollWidth: 3_507,
    });

    expect(browserMeasurementPort.probeScrollExtent()).toEqual({
      vertical: 910,
      horizontal: 3_507,
    });
    expect(scrollport.isConnected).toBe(false);
  });

  it("searches below oversized writes that read back as zero", () => {
    const { horizontalAssignments, verticalAssignments } = installProbeElements(
      {
        verticalLimit: 12_345,
        horizontalLimit: 4_321,
        clientHeight: 10,
        clientWidth: 7,
        scrollHeight: OVERSIZED_TEST_EXTENT,
        scrollWidth: OVERSIZED_TEST_EXTENT,
        zeroBeyondLimit: true,
      },
    );

    expect(browserMeasurementPort.probeScrollExtent()).toEqual({
      vertical: 12_355,
      horizontal: 4_328,
    });
    expect(verticalAssignments.length).toBeLessThan(64);
    expect(horizontalAssignments.length).toBeLessThan(64);
  });

  it("removes the probe when reading an extent fails", () => {
    const { scrollport } = installProbeElements({
      verticalLimit: 900,
      horizontalLimit: 3_500,
      clientHeight: 10,
      clientWidth: 7,
      scrollHeight: 910,
      scrollWidth: 3_507,
      failVerticalRead: true,
    });

    expect(() => browserMeasurementPort.probeScrollExtent()).toThrow(
      "extent read failed",
    );
    expect(scrollport.isConnected).toBe(false);
  });
});

describe("ViewdaGrid foundation", () => {
  it("renders a bounded set of complete semantic rows", () => {
    const columns = [column(0), column(1, true), column(2), column(3, true)];

    const { container } = render(
      <ViewdaGrid {...props({ columns, rowCount: 1_000_000_000 })} />,
    );

    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeLessThanOrEqual(8);
    const firstBodyRow = rows[1];
    expect(firstBodyRow?.querySelector('[role="rowheader"]')).toHaveTextContent(
      "1",
    );
    expect(
      [...(firstBodyRow?.querySelectorAll('[role="gridcell"]') ?? [])].map(
        (cell) => cell.getAttribute("aria-colindex"),
      ),
    ).toEqual(["2", "3", "4", "5"]);
    expect(container.querySelectorAll('[role="gridcell"]').length).toBeLessThan(
      40,
    );
  });

  it("keeps the horizontal scrollbar outside sticky columns", () => {
    const columns = [column(0, true), column(1), column(2), column(3)];
    const { container } = render(
      <ViewdaGrid {...props({ columns, rowCount: 1_000 })} />,
    );

    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    expect(horizontalScrollbar).not.toHaveAttribute("hidden");
    expect(horizontalScrollbar).toHaveStyle({ marginLeft: "153px" });
    expect(
      horizontalScrollport.querySelector(".viewda-grid-horizontal-spacer"),
    ).toHaveStyle({ width: "300px" });
    expect(horizontalScrollbar).toHaveAttribute(
      "aria-controls",
      bodyScrollport.id,
    );

    horizontalScrollport.scrollLeft = 40;
    fireEvent.scroll(horizontalScrollport);

    expect(bodyScrollport.scrollLeft).toBe(40);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-40px)" });
    const firstBodyRow = screen.getAllByRole("row")[1];
    expect(
      [...(firstBodyRow?.querySelectorAll('[role="gridcell"]') ?? [])].map(
        (cell) => cell.getAttribute("aria-colindex"),
      ),
    ).toEqual(["2", "3", "4", "5"]);
  });

  it("keeps the horizontal thumb visible, clickable, and draggable", () => {
    installPointerCapture();
    const basePort = measurementPort(420, 84);
    const port: GridMeasurementPort = {
      ...basePort,
      bounds: (element) =>
        element.classList.contains("viewda-grid-horizontal-scrollbar")
          ? { x: 100, y: 200, width: 367, height: 14 }
          : basePort.bounds(element),
    };
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port })} />,
    );
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });
    const horizontalThumb = horizontalScrollbar.querySelector(
      ".viewda-grid-horizontal-thumb",
    ) as HTMLElement;
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const thumbWidth = Number.parseFloat(horizontalThumb.style.width);

    expect(thumbWidth).toBeGreaterThanOrEqual(28);
    expect(horizontalThumb.style.transform).toBe("translateX(0px)");

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 400,
      pointerId: 6,
    });
    expect(bodyScrollport.scrollLeft).toBeGreaterThan(0);
    fireEvent.pointerUp(horizontalScrollbar, { pointerId: 6 });
    fireEvent.keyDown(horizontalScrollbar, { key: "Home" });

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 105,
      pointerId: 7,
    });
    fireEvent.pointerMove(horizontalScrollbar, {
      clientX: 300,
      pointerId: 7,
    });

    const expectedScrollLeft = (195 / (367 - thumbWidth)) * 833;
    expect(bodyScrollport.scrollLeft).toBeCloseTo(expectedScrollLeft);
    expect(horizontalScrollport.scrollLeft).toBeCloseTo(expectedScrollLeft);
    expect(horizontalScrollbar).toHaveAttribute(
      "aria-valuenow",
      String(Math.round(expectedScrollLeft)),
    );
    expect(horizontalThumb.style.transform).not.toBe("translateX(0px)");

    fireEvent.pointerUp(horizontalScrollbar, { pointerId: 7 });
    expect(horizontalScrollbar).not.toHaveAttribute("data-dragging");
  });

  it("uses current scrollbar geometry throughout a horizontal drag", () => {
    installPointerCapture();
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let resize: (() => void) | undefined;
    let viewportWidth = 420;
    const basePort = measurementPort(viewportWidth, 84);
    const port: GridMeasurementPort = {
      ...basePort,
      read: (scrollport) => ({
        width: viewportWidth,
        height: 84,
        scrollTop: scrollport.scrollTop,
        scrollLeft: scrollport.scrollLeft,
        devicePixelRatio: 1.5,
      }),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
      bounds: (element) => {
        if (!element.classList.contains("viewda-grid-horizontal-scrollbar")) {
          return basePort.bounds(element);
        }
        const declaredWidth = Number.parseFloat(element.style.width);
        return {
          x: 100,
          y: 200,
          width: Number.isNaN(declaredWidth)
            ? viewportWidth - 53
            : declaredWidth,
          height: 14,
        };
      },
    };
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port })} />,
    );
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 105,
      pointerId: 7,
    });
    viewportWidth = 320;
    act(() => resize?.());
    fireEvent.pointerMove(horizontalScrollbar, {
      clientX: 367,
      pointerId: 7,
    });

    expect(bodyScrollport.scrollLeft).toBeCloseTo(933);
    act(() => frames.shift()?.(0));
    expect(bodyScrollport.scrollLeft).toBeCloseTo(933);
    fireEvent.pointerUp(horizontalScrollbar, { pointerId: 7 });
  });

  it("does not let another pointer replace or finish an active drag", () => {
    const { setPointerCapture, releasePointerCapture } =
      installPointerCapture();
    const basePort = measurementPort(420, 84);
    const port: GridMeasurementPort = {
      ...basePort,
      bounds: (element) =>
        element.classList.contains("viewda-grid-horizontal-scrollbar")
          ? { x: 100, y: 200, width: 367, height: 14 }
          : basePort.bounds(element),
    };
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port })} />,
    );
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 105,
      pointerId: 7,
    });
    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 106,
      pointerId: 8,
    });
    fireEvent.pointerUp(horizontalScrollbar, { pointerId: 8 });
    fireEvent.pointerMove(horizontalScrollbar, {
      clientX: 300,
      pointerId: 7,
    });

    expect(setPointerCapture).toHaveBeenCalledTimes(1);
    expect(horizontalScrollbar).toHaveAttribute("data-dragging", "true");
    expect(bodyScrollport.scrollLeft).toBeGreaterThan(0);

    fireEvent.pointerUp(horizontalScrollbar, { pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(horizontalScrollbar).not.toHaveAttribute("data-dragging");
  });

  it("allows another drag after pointer capture is lost", () => {
    const { setPointerCapture } = installPointerCapture();
    const basePort = measurementPort(420, 84);
    const port: GridMeasurementPort = {
      ...basePort,
      bounds: (element) =>
        element.classList.contains("viewda-grid-horizontal-scrollbar")
          ? { x: 100, y: 200, width: 367, height: 14 }
          : basePort.bounds(element),
    };
    render(<ViewdaGrid {...props({ measurementPort: port })} />);
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 105,
      pointerId: 7,
    });
    fireEvent.lostPointerCapture(horizontalScrollbar, { pointerId: 7 });
    expect(horizontalScrollbar).not.toHaveAttribute("data-dragging");

    fireEvent.pointerDown(horizontalScrollbar, {
      button: 0,
      clientX: 105,
      pointerId: 8,
    });
    expect(setPointerCapture).toHaveBeenNthCalledWith(2, 8);
    expect(horizontalScrollbar).toHaveAttribute("data-dragging", "true");
  });

  it("supports keyboard scrolling from the horizontal scrollbar", () => {
    const { container } = render(<ViewdaGrid {...props()} />);
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    fireEvent.keyDown(horizontalScrollbar, { key: "End" });
    expect(bodyScrollport.scrollLeft).toBe(833);
    expect(horizontalScrollbar).toHaveAttribute("aria-valuenow", "833");

    fireEvent.keyDown(horizontalScrollbar, { key: "Home" });
    expect(bodyScrollport.scrollLeft).toBe(0);
    expect(horizontalScrollbar).toHaveAttribute("aria-valuenow", "0");
  });

  it("keeps vertical navigation keys inside the horizontal scrollbar", () => {
    const onSelectionChange = vi.fn();
    render(<ViewdaGrid {...props({ onSelectionChange })} />);
    const horizontalScrollbar = screen.getByRole("scrollbar", {
      name: "Horizontal grid scroll",
    });

    fireEvent.keyDown(horizontalScrollbar, { key: "ArrowUp" });
    fireEvent.keyDown(horizontalScrollbar, { key: "ArrowDown" });

    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("mirrors horizontal input through the body authority without feedback", () => {
    const { container } = render(<ViewdaGrid {...props()} />);
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    let bodyLeft = 0;
    let horizontalLeft = 40;
    const bodyWrites: number[] = [];
    const horizontalWrites: number[] = [];
    Object.defineProperty(bodyScrollport, "scrollLeft", {
      configurable: true,
      get: () => bodyLeft,
      set: (value: number) => {
        bodyWrites.push(value);
        bodyLeft = value;
      },
    });
    Object.defineProperty(horizontalScrollport, "scrollLeft", {
      configurable: true,
      get: () => horizontalLeft,
      set: (value: number) => {
        horizontalWrites.push(value);
        horizontalLeft = value;
      },
    });

    fireEvent.scroll(horizontalScrollport);

    expect(bodyWrites).toEqual([40]);
    expect(horizontalWrites).toEqual([]);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-40px)" });

    bodyLeft = 40.5;
    fireEvent.scroll(bodyScrollport);

    expect(horizontalWrites).toEqual([]);
    expect(scrollingHeaders).toHaveStyle({
      transform: "translateX(-40.5px)",
    });
  });

  it("mirrors the body clamp back to the external horizontal track", () => {
    const { container } = render(<ViewdaGrid {...props()} />);
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    let bodyLeft = 0;
    let horizontalLeft = 300;
    Object.defineProperty(bodyScrollport, "scrollLeft", {
      configurable: true,
      get: () => bodyLeft,
      set: (value: number) => {
        bodyLeft = Math.min(100, value);
      },
    });
    Object.defineProperty(horizontalScrollport, "scrollLeft", {
      configurable: true,
      get: () => horizontalLeft,
      set: (value: number) => {
        horizontalLeft = value;
      },
    });

    fireEvent.scroll(horizontalScrollport);

    expect(bodyScrollport.scrollLeft).toBe(100);
    expect(horizontalScrollport.scrollLeft).toBe(100);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-100px)" });
  });

  it("does not reserve a horizontal scrollbar lane without overflow", () => {
    const { container } = render(
      <ViewdaGrid
        {...props({ columns: [column(0), column(1)], rowCount: 1_000 })}
      />,
    );

    expect(
      container.querySelector(".viewda-grid-horizontal-scrollbar"),
    ).toHaveAttribute("hidden");
  });

  it("names the grid, headers, and header actions", () => {
    render(
      <ViewdaGrid
        {...props({ columns: [column(0), column(1)], rowCount: 1 })}
      />,
    );

    expect(screen.getByRole("grid", { name: "Data grid" })).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Row numbers" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Column 0" })).toHaveClass(
      "has-filter",
    );
    const sort = screen.getByRole("button", { name: "Sort Column 0" });
    expect(sort).toBeInTheDocument();
    expect(sort.querySelector("svg")).toBeInTheDocument();
    expect(sort.textContent).toBe("");
    expect(
      screen.getByRole("button", { name: "Filter Column 0" }),
    ).toBeInTheDocument();
  });

  it("omits unavailable header actions and keeps the title and resize handle", () => {
    render(
      <ViewdaGrid
        {...props({
          columns: [
            { ...column(0), filterable: false },
            {
              ...column(1),
              sortable: false,
              filterable: false,
            },
          ],
          rowCount: 1,
        })}
      />,
    );

    const sortableHeader = screen.getByRole("columnheader", {
      name: "Column 0",
    });
    expect(sortableHeader).toHaveAttribute("aria-sort", "none");
    expect(sortableHeader).not.toHaveClass("has-filter");
    expect(
      screen.getByRole("button", { name: "Sort Column 0" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Filter Column 0" }),
    ).toBeNull();

    const descriptiveHeader = screen.getByRole("columnheader", {
      name: "Column 1",
    });
    expect(descriptiveHeader).not.toHaveAttribute("aria-sort");
    expect(screen.queryByRole("button", { name: "Sort Column 1" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Filter Column 1" }),
    ).toBeNull();
    expect(
      descriptiveHeader.querySelector(".viewda-grid-header-title"),
    ).toHaveTextContent("Column 1");
    expect(
      descriptiveHeader.querySelector(".viewda-grid-resize-handle"),
    ).toBeInTheDocument();
  });

  it("reports the actual viewport while rendering overscan around it", () => {
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid {...props({ onViewportChange })} />,
    );

    expect(onViewportChange).toHaveBeenLastCalledWith({
      rowStart: 0,
      rowCount: 3,
      columnIndices: [0, 1, 2, 3],
      mountedRowStart: 0,
      mountedRowCount: 6,
      mountedColumnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    expect(container.querySelectorAll(".viewda-grid-row")).toHaveLength(6);
    expect(
      container.querySelectorAll('.viewda-grid-cell[data-column="7"]'),
    ).not.toHaveLength(0);
  });

  it("requests fallback data before relying on measured viewport", () => {
    const onViewportChange = vi.fn();

    const { rerender } = render(
      <ViewdaGrid
        {...props({
          rowCount: 10_000,
          onViewportChange,
          measurementPort: measurementPort(0, 0),
        })}
      />,
    );

    expect(onViewportChange.mock.calls[0]?.[0]).toEqual({
      rowStart: 0,
      rowCount: 64,
      columnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
      mountedRowStart: 0,
      mountedRowCount: 64,
      mountedColumnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    expect(
      onViewportChange.mock.calls.filter(
        ([viewport]) => viewport.rowCount === 64,
      ),
    ).toHaveLength(1);
    const replacement = vi.fn();
    rerender(
      <ViewdaGrid
        {...props({
          rowCount: 10_000,
          onViewportChange: replacement,
          measurementPort: measurementPort(0, 0),
        })}
      />,
    );
    expect(replacement).not.toHaveBeenCalledWith(
      expect.objectContaining({ rowCount: 64 }),
    );
  });

  it("keeps the scroll position while its panel is hidden", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let resize: (() => void) | undefined;
    let visible = true;
    let scrollLeft = 0;
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84),
      // A hidden panel reports a zero viewport, and the browser forgets the
      // scroll offset of a box it destroyed.
      read: (scrollport) => ({
        width: visible ? 420 : 0,
        height: visible ? 84 : 0,
        scrollTop: visible ? scrollport.scrollTop : 0,
        scrollLeft: visible ? scrollLeft : 0,
        devicePixelRatio: 1,
      }),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port })} />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalTrack = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const grid = scrollport.closest(".viewda-grid") as HTMLElement;
    scrollport.scrollTop = 4_200;
    scrollLeft = 640;
    scrollport.scrollLeft = 640;
    fireEvent.scroll(scrollport);
    act(() => frames.shift()?.(0));
    expect(scrollport.scrollTop).toBe(4_200);
    expect(scrollport.scrollLeft).toBe(640);

    visible = false;
    scrollport.scrollTop = 0;
    scrollLeft = 0;
    scrollport.scrollLeft = 0;
    grid.hidden = true;
    fireEvent.scroll(scrollport);
    horizontalTrack.scrollLeft = 0;
    fireEvent.scroll(horizontalTrack);
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    visible = true;
    grid.hidden = false;
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    expect(scrollport.scrollTop).toBe(4_200);
    expect(scrollport.scrollLeft).toBe(640);
  });

  it("keeps pending scroll input when its panel hides before measurement", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let resize: (() => void) | undefined;
    let visible = true;
    let scrollLeft = 0;
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84),
      read: (scrollport) => ({
        width: visible ? 420 : 0,
        height: visible ? 84 : 0,
        scrollTop: visible ? scrollport.scrollTop : 0,
        scrollLeft: visible ? scrollLeft : 0,
        devicePixelRatio: 1,
      }),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port })} />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalTrack = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const grid = scrollport.closest(".viewda-grid") as HTMLElement;
    scrollport.scrollTop = 4_200;
    scrollLeft = 640;
    scrollport.scrollLeft = 640;
    fireEvent.scroll(scrollport);

    visible = false;
    scrollport.scrollTop = 0;
    scrollLeft = 0;
    scrollport.scrollLeft = 0;
    grid.hidden = true;
    fireEvent.scroll(scrollport);
    horizontalTrack.scrollLeft = 0;
    fireEvent.scroll(horizontalTrack);
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    visible = true;
    grid.hidden = false;
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    expect(scrollport.scrollTop).toBe(4_200);
    expect(scrollport.scrollLeft).toBe(640);
  });

  it("does not quantize compressed vertical state after horizontal input", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let resize: (() => void) | undefined;
    let visible = true;
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84, 1_000_000),
      read: (scrollport) => ({
        width: visible ? 420 : 0,
        height: visible ? 84 : 0,
        scrollTop: visible ? scrollport.scrollTop : 0,
        scrollLeft: visible ? scrollport.scrollLeft : 0,
        devicePixelRatio: 1,
      }),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid
        {...props({
          rowCount: 3_514_000,
          onViewportChange,
          measurementPort: port,
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalTrack = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const grid = scrollport.closest(".viewda-grid") as HTMLElement;
    let quantizedScrollTop = Math.floor(scrollport.scrollTop);
    Object.defineProperty(scrollport, "scrollTop", {
      configurable: true,
      get: () => quantizedScrollTop,
      set: (value: number) => {
        quantizedScrollTop = Math.floor(value);
      },
    });
    frames.length = 0;
    onViewportChange.mockClear();

    act(() => scrollport.dispatchEvent(wheelEvent({ deltaY: 56 }, 0)));
    act(() => frames.shift()?.(0));
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 2 }),
    );

    scrollport.scrollLeft = 320;
    fireEvent.scroll(scrollport);
    act(() => frames.shift()?.(0));
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 2 }),
    );

    scrollport.scrollLeft = 640;
    fireEvent.scroll(scrollport);
    visible = false;
    scrollport.scrollLeft = 0;
    grid.hidden = true;
    fireEvent.scroll(scrollport);
    horizontalTrack.scrollLeft = 0;
    fireEvent.scroll(horizontalTrack);
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    visible = true;
    grid.hidden = false;
    act(() => resize?.());
    act(() => frames.shift()?.(0));

    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 2 }),
    );
    expect(scrollport.scrollLeft).toBe(640);
  });

  it("reports viewport shapes once and uses the latest callback", async () => {
    let resize: (() => void) | undefined;
    let scrollLeft = 0;
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84),
      read: (scrollport) => ({
        width: 420,
        height: 84,
        scrollTop: scrollport.scrollTop,
        scrollLeft,
        devicePixelRatio: 1,
      }),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const first = vi.fn();
    const latest = vi.fn();
    const initialProps = props({ measurementPort: port });
    const { rerender } = render(
      <ViewdaGrid {...initialProps} onViewportChange={first} />,
    );
    first.mockClear();

    rerender(<ViewdaGrid {...initialProps} onViewportChange={latest} />);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    scrollLeft = 400;
    act(() => resize?.());
    await waitFor(() => expect(latest).toHaveBeenCalledOnce());
    expect(latest).toHaveBeenLastCalledWith(
      expect.objectContaining({ columnIndices: [4, 5, 6, 7] }),
    );
  });

  it("keeps header and bounded cells synchronous across horizontal scroll", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const getCellContent = vi.fn(props().getCellContent);
    const { container } = render(<ViewdaGrid {...props({ getCellContent })} />);
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    frames.length = 0;
    getCellContent.mockClear();

    horizontalScrollport.scrollLeft = 10;
    fireEvent.scroll(horizontalScrollport);
    expect(bodyScrollport.scrollLeft).toBe(10);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-10px)" });
    expect(getCellContent).not.toHaveBeenCalled();
    act(() => frames.shift()?.(0));
    expect(getCellContent).not.toHaveBeenCalled();

    horizontalScrollport.scrollLeft = 201;
    fireEvent.scroll(horizontalScrollport);
    act(() => frames.shift()?.(0));
    expect(getCellContent).not.toHaveBeenCalled();

    horizontalScrollport.scrollLeft = 301;
    fireEvent.scroll(horizontalScrollport);
    act(() => frames.shift()?.(0));
    expect(getCellContent).toHaveBeenCalledTimes(18);
    expect(
      new Set(getCellContent.mock.calls.map(([address]) => address.column)),
    ).toEqual(new Set([8, 9, 10]));
  });

  it("publishes exact visible columns without rerendering a stable mounted window", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = createDiagnostics();
    const getCellContent = vi.fn(props().getCellContent);
    const onViewportChange = vi.fn();
    const gridProps = props({
      diagnostics: diagnostics.sink,
      getCellContent,
      onViewportChange,
    });
    startDiagnostics(diagnostics);
    const { container } = render(<ViewdaGrid {...gridProps} />);
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    onViewportChange.mockClear();
    getCellContent.mockClear();
    frames.length = 0;

    horizontalScrollport.scrollLeft = 201;
    fireEvent.scroll(horizontalScrollport);
    act(() => frames.pop()?.(16));

    expect(getCellContent).not.toHaveBeenCalled();
    expect(onViewportChange).toHaveBeenCalledOnce();
    expect(onViewportChange.mock.calls[0]?.[0]).toMatchObject({
      columnIndices: [2, 3, 4, 5],
      mountedColumnIndices: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    const report = JSON.parse(diagnostics.stop() ?? "null");
    expect(
      report.grid.visibleColumnChanges - report.grid.mountedColumnChanges,
    ).toBe(1);
  });

  it("records a snapshot when horizontal movement stays within the mounted window", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = createDiagnostics();
    const gridProps = props({ diagnostics: diagnostics.sink });
    const { container, rerender } = render(<ViewdaGrid {...gridProps} />);
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    frames.length = 0;
    startDiagnostics(diagnostics);
    act(() =>
      horizontalScrollport.dispatchEvent(wheelEvent({ deltaX: 10 }, 1)),
    );
    act(() => frames.pop()?.(16));
    rerender(<ViewdaGrid {...gridProps} contentRevision={1} />);

    const report = JSON.parse(diagnostics.stop() ?? "null");
    expect(bodyScrollport.scrollLeft).toBe(10);
    expect(report.grid.configuration).not.toBeNull();
    expect(report.grid.maximumDomCells).toBeGreaterThan(0);
    expect(report.grid.visibleViewportChanges).toBe(1);
    expect(report.timing.inputToReactCommitMs.count).toBe(0);
  });

  it("does not inspect rendered cells while diagnostics are inactive", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = createDiagnostics();
    const { container } = render(
      <ViewdaGrid {...props({ diagnostics: diagnostics.sink })} />,
    );
    const root = container.querySelector(".viewda-grid") as HTMLElement;
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const inspectCells = vi.spyOn(root, "querySelectorAll");
    frames.length = 0;

    act(() => scrollport.dispatchEvent(wheelEvent({ deltaY: 28 }, 0)));
    act(() => frames.shift()?.(16));

    expect(inspectCells).not.toHaveBeenCalledWith(".viewda-grid-cell");

    startDiagnostics(diagnostics);
    act(() => scrollport.dispatchEvent(wheelEvent({ deltaY: 28 }, 200)));

    expect(inspectCells).toHaveBeenCalledWith(".viewda-grid-cell");
  });

  it("reports wheel outcomes from the rendered scroll boundaries", () => {
    const diagnostics = createDiagnostics();
    const { container } = render(
      <ViewdaGrid {...props({ diagnostics: diagnostics.sink })} />,
    );
    const horizontalTrack = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    let scrollLeft = 833;
    Object.defineProperty(scrollport, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.max(0, Math.min(833, value));
      },
    });
    startDiagnostics(diagnostics);
    act(() => {
      horizontalTrack.dispatchEvent(wheelEvent({ deltaX: 10 }, 0));
      scrollport.dispatchEvent(wheelEvent({ deltaY: 7 }, 200));
    });

    const report = JSON.parse(diagnostics.stop() ?? "null");
    expect(report.wheel).toMatchObject({
      consumedEvents: 1,
      movedEvents: 0,
      horizontal: {
        movedEvents: 0,
        outcomes: { atEndBoundary: 1 },
      },
      vertical: {
        movedEvents: 0,
        outcomes: { accumulatingWholeRow: 1 },
      },
    });
  });

  it("routes a boundary-reaching delta without discarding its remainder", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const diagnostics = createDiagnostics();
    const { container } = render(
      <div data-testid="outer-scroll-owner">
        <ViewdaGrid
          {...props({
            rowCount: 4,
            measurementPort: measurementPort(420, 70),
            diagnostics: diagnostics.sink,
          })}
        />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll-owner");
    outer.style.overflowY = "auto";
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const header = container.querySelector(
      ".viewda-grid-header",
    ) as HTMLElement;
    frames.length = 0;
    scrollport.scrollTop = 30;
    fireEvent.scroll(scrollport);
    act(() => frames.shift()?.(0));
    startDiagnostics(diagnostics);
    const wheel = wheelEvent({ deltaY: 84 }, 10);
    act(() => header.dispatchEvent(wheel));

    const report = JSON.parse(diagnostics.stop() ?? "null");
    expect(wheel.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(42);
    expect(outer.scrollTop).toBe(72);
    expect(report.wheel).toMatchObject({
      consumedEvents: 1,
      movedEvents: 1,
      vertical: {
        requestedPixels: 84,
        appliedRowSteps: 12 / 28,
        outcomes: { appliedMovement: 1 },
      },
    });
  });

  it("forwards accumulated downward and upward boundary remainder", () => {
    const { container } = render(
      <div data-testid="outer-scroll-owner">
        <ViewdaGrid
          {...props({
            rowCount: 5,
            measurementPort: measurementPort(420, 84),
          })}
        />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll-owner");
    outer.style.overflowY = "auto";
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    const downPending = wheelEvent({ deltaY: 20 }, 1);
    act(() => scrollport.dispatchEvent(downPending));
    expect(downPending.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(0);
    expect(outer.scrollTop).toBe(0);

    const downBoundary = wheelEvent({ deltaY: 50 }, 2);
    act(() => scrollport.dispatchEvent(downBoundary));
    expect(downBoundary.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(56);
    expect(outer.scrollTop).toBe(14);

    outer.scrollTop = 100;
    const upPending = wheelEvent({ deltaY: -20 }, 200);
    act(() => scrollport.dispatchEvent(upPending));
    expect(upPending.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(56);
    expect(outer.scrollTop).toBe(100);

    const upBoundary = wheelEvent({ deltaY: -50 }, 201);
    act(() => scrollport.dispatchEvent(upBoundary));
    expect(upBoundary.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(0);
    expect(outer.scrollTop).toBe(86);
  });

  it("does not flush retained vertical remainder on opposing noise", () => {
    const ref = createRef<ViewdaGridHandle>();
    const { container } = render(
      <div data-testid="outer-scroll-owner">
        <ViewdaGrid
          ref={ref}
          {...props({
            rowCount: 5,
            measurementPort: measurementPort(420, 84),
          })}
        />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll-owner");
    outer.style.overflowY = "auto";
    Object.defineProperties(outer, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 2_000 },
    });
    outer.scrollTop = 100;
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    act(() => scrollport.dispatchEvent(wheelEvent({ deltaY: 20 }, 1)));
    act(() => ref.current?.scrollToRow(5));
    const opposingNoise = wheelEvent({ deltaY: -1 }, 2);
    act(() => scrollport.dispatchEvent(opposingNoise));

    expect(opposingNoise.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBe(56);
    expect(outer.scrollTop).toBe(100);
  });

  it("uses the newest frame when older measurement and newer input share a commit", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const diagnostics = createDiagnostics();
    const { container } = render(
      <ViewdaGrid
        {...props({
          columns: Array.from({ length: 40 }, (_, index) => column(index)),
          rowCount: 1_000_000_000,
          measurementPort: measurementPort(420, 84, 1_000_000),
          diagnostics: diagnostics.sink,
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalTrack = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    frames.length = 0;
    startDiagnostics(diagnostics);
    act(() => {
      horizontalTrack.dispatchEvent(wheelEvent({ deltaX: 800 }, 1_000));
      now = 1_002;
      frames.pop()?.(1_001);
      scrollport.dispatchEvent(wheelEvent({ deltaY: 28 }, 1_003));
    });
    now = 1_006;
    act(() => frames.pop()?.(1_006));

    const report = JSON.parse(diagnostics.stop() ?? "null");
    expect(report.timing).toMatchObject({
      measurementFrames: 1,
      measurementFramesAwaitingReactCommit: 1,
      measurementToReactCommitMs: { count: 1 },
      inputToReactCommitMs: { count: 1 },
      commitToNextAnimationFrameMs: { count: 1 },
    });
    expect(report.grid.visibleViewportChanges).toBe(1);
    const diagnosticFrames = report.diagnostics.diagnosticEpisodes.flatMap(
      (episode: { frames: unknown[] }) => episode.frames,
    );
    const nextFrameOwner = diagnosticFrames.find(
      (frame: { commitToNextAnimationFrame: { count: number } }) =>
        frame.commitToNextAnimationFrame.count === 1,
    );
    expect(nextFrameOwner.frameId).toBe(
      Math.max(
        ...diagnosticFrames.map((frame: { frameId: number }) => frame.frameId),
      ),
    );
  });

  it("keeps column commits and DOM bounded across the horizontal extent", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const onViewportChange = vi.fn();
    const getCellContent = vi.fn(props().getCellContent);
    const columns = Array.from({ length: 40 }, (_, index) => column(index));
    const { container } = render(
      <ViewdaGrid {...props({ columns, getCellContent, onViewportChange })} />,
    );
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    const maximumLeft = 4_000 - (420 - 53);
    let scrollLeft = 0;
    Object.defineProperty(bodyScrollport, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.max(0, Math.min(maximumLeft, value));
      },
    });
    frames.length = 0;
    onViewportChange.mockClear();
    getCellContent.mockClear();
    let maximumCells = container.querySelectorAll(".viewda-grid-cell").length;
    const eventCount = 400;

    for (let eventIndex = 1; eventIndex <= eventCount; eventIndex += 1) {
      const previousLeft = bodyScrollport.scrollLeft;
      const wheel = wheelEvent(
        { deltaX: 10, deltaY: 0.5, deltaMode: WheelEvent.DOM_DELTA_PIXEL },
        (eventIndex - 1) * 8,
      );
      act(() => horizontalScrollport.dispatchEvent(wheel));
      expect(horizontalScrollport.scrollLeft).toBe(bodyScrollport.scrollLeft);
      expect(scrollingHeaders).toHaveStyle({
        transform: `translateX(${-bodyScrollport.scrollLeft}px)`,
      });
      act(() => {
        frames.shift()?.(eventIndex * 8);
      });
      expect(wheel.defaultPrevented).toBe(
        bodyScrollport.scrollLeft !== previousLeft,
      );
      maximumCells = Math.max(
        maximumCells,
        container.querySelectorAll(".viewda-grid-cell").length,
      );
    }

    expect(bodyScrollport.scrollLeft).toBe(maximumLeft);
    expect(horizontalScrollport.scrollLeft).toBe(maximumLeft);
    expect(onViewportChange.mock.calls.at(-1)?.[0].columnIndices).toContain(39);
    expect(onViewportChange.mock.calls.length).toBeLessThan(eventCount / 2);
    const mountedShapes = new Set(
      onViewportChange.mock.calls.map(([viewport]) =>
        viewport.mountedColumnIndices.join(","),
      ),
    );
    expect(mountedShapes.size).toBeLessThan(20);
    expect(maximumCells).toBeLessThanOrEqual(78);
    expect(getCellContent.mock.calls.length).toBeLessThanOrEqual(40 * 6);
  });

  it("mounts one row per native step while preserving overlapping row transforms", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const getCellContent = vi.fn(props().getCellContent);
    const { container } = render(<ViewdaGrid {...props({ getCellContent })} />);
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    frames.length = 0;
    getCellContent.mockClear();
    const stableRow = container.querySelector<HTMLElement>(
      '.viewda-grid-row[aria-rowindex="3"]',
    );
    const initialTransform = stableRow?.style.transform;

    scrollport.scrollTop = 28;
    fireEvent.scroll(scrollport);
    act(() => frames.shift()?.(0));

    expect(getCellContent).toHaveBeenCalledTimes(8);
    expect(
      new Set(getCellContent.mock.calls.map(([address]) => address.row)),
    ).toEqual(new Set([6]));
    expect(container.querySelector('.viewda-grid-row[aria-rowindex="3"]')).toBe(
      stableRow,
    );
    expect(stableRow?.style.transform).toBe(initialTransform);
    getCellContent.mockClear();

    scrollport.scrollTop = 56;
    fireEvent.scroll(scrollport);
    act(() => frames.shift()?.(16));

    expect(getCellContent).toHaveBeenCalledTimes(8);
    expect(
      new Set(getCellContent.mock.calls.map(([address]) => address.row)),
    ).toEqual(new Set([7]));
    expect(stableRow?.style.transform).toBe(initialTransform);
  });

  it("keeps root focus semantics when the active cell is recycled", () => {
    const ref = createRef<ViewdaGridHandle>();
    const selection = selectCell(
      emptyGridSelection(),
      { row: 0, column: 0 },
      false,
      false,
    );

    render(
      <ViewdaGrid
        ref={ref}
        {...props({
          rowCount: 1_000_000_000,
          selection,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );

    const grid = screen.getByRole("grid");
    expect(grid).toHaveAttribute("aria-activedescendant");
    act(() => ref.current?.scrollToRow(100_000));
    expect(grid).not.toHaveAttribute("aria-activedescendant");
    expect(grid).toHaveAttribute("tabindex", "0");
    act(() => ref.current?.scrollToRow(0));
    expect(grid).toHaveAttribute("aria-activedescendant");
  });

  it("clamps a deep viewport to the last visible area after row count shrinks", () => {
    const ref = createRef<ViewdaGridHandle>();
    const onViewportChange = vi.fn();
    const initial = props({
      rowCount: 1_000_000_000,
      onViewportChange,
      measurementPort: measurementPort(420, 84, 1_000_000),
    });
    const { rerender } = render(<ViewdaGrid ref={ref} {...initial} />);
    act(() => ref.current?.scrollToRow(100_000));

    rerender(<ViewdaGrid ref={ref} {...initial} rowCount={20} />);

    expect(screen.getByRole("rowheader", { name: "20" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "100001" })).toBeNull();
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 17, rowCount: 3 }),
    );
  });

  it("reports horizontal extent transitions once per geometry change", () => {
    const port = measurementPort(420, 84, 500);
    const exceeded = vi.fn();
    const recovered = vi.fn();
    const wideColumns = Array.from({ length: 12 }, (_, index) => ({
      ...column(index),
      width: 100_000,
    }));
    const { rerender } = render(
      <ViewdaGrid
        {...props({
          columns: wideColumns,
          rowCount: 100_000,
          measurementPort: port,
          onHorizontalExtentChange: exceeded,
        })}
      />,
    );

    expect(exceeded).toHaveBeenCalledOnce();
    expect(exceeded).toHaveBeenLastCalledWith(true, 1_200_071, 500);
    rerender(
      <ViewdaGrid
        {...props({
          columns: wideColumns,
          rowCount: 100_000,
          measurementPort: port,
          onHorizontalExtentChange: recovered,
        })}
      />,
    );
    expect(recovered).not.toHaveBeenCalled();

    rerender(
      <ViewdaGrid
        {...props({
          columns: [column(0)],
          rowCount: 100_000,
          measurementPort: port,
          onHorizontalExtentChange: recovered,
        })}
      />,
    );
    expect(recovered).toHaveBeenCalledOnce();
    expect(recovered).toHaveBeenLastCalledWith(false, 171, 500);
  });

  it("routes cell and header actions through the grid root", () => {
    const onSelectionChange = vi.fn();
    const onSort = vi.fn();
    const onFilter = vi.fn();
    const { container } = render(
      <ViewdaGrid {...props({ onSelectionChange, onSort, onFilter })} />,
    );

    const cell = screen.getByRole("gridcell", { name: "0:0" });
    expect(cell.onclick).toBeNull();
    fireEvent.click(cell);
    const sort = container.querySelector('[data-action="sort"]') as HTMLElement;
    sort.focus();
    fireEvent.click(sort, { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("grid"));
    const filter = container.querySelector(
      '[data-action="filter"]',
    ) as HTMLElement;
    filter.focus();
    fireEvent.click(filter);
    expect(document.activeElement).toBe(screen.getByRole("grid"));

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSort).toHaveBeenCalledWith(0, true);
    expect(onFilter).toHaveBeenCalledWith(
      0,
      expect.objectContaining({ width: 100 }),
    );
  });

  it("extends a cell selection while the pointer is captured", () => {
    const onSelectionChange = vi.fn();
    const { setPointerCapture, releasePointerCapture } =
      installPointerCapture();
    const { container } = render(
      <ViewdaGrid {...props({ onSelectionChange })} />,
    );
    const origin = screen.getByRole("gridcell", { name: "0:0" });
    const destination = screen.getByRole("gridcell", { name: "1:1" });
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => destination),
    });
    const grid = screen.getByRole("grid");

    fireEvent.pointerDown(origin, {
      button: 0,
      pointerId: 7,
      clientX: 20,
      clientY: 20,
    });
    fireEvent.pointerMove(grid, {
      pointerId: 7,
      clientX: 40,
      clientY: 40,
    });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          range: { x: 0, y: 0, width: 2, height: 2 },
        }),
      }),
    );

    fireEvent.pointerUp(grid, { pointerId: 7 });
    onSelectionChange.mockClear();
    fireEvent.pointerMove(grid, {
      pointerId: 7,
      clientX: 40,
      clientY: 40,
    });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(origin, { button: 0, pointerId: 8 });
    fireEvent.pointerCancel(grid, { pointerId: 8 });
    onSelectionChange.mockClear();
    fireEvent.click(destination);
    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("[onclick]")).toHaveLength(0);
  });

  it("keeps auto-scrolling while a selection drag stays at the viewport edge", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    installPointerCapture();
    const onSelectionChange = vi.fn();
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84, 1_000_000),
      bounds: () => ({ x: 0, y: 0, width: 420, height: 84 }),
    };
    const onViewportChange = vi.fn();
    function ControlledGrid() {
      const [selection, setSelection] = useState(emptyGridSelection());
      return (
        <ViewdaGrid
          {...props({
            rowCount: 1_000_000_000,
            selection,
            measurementPort: port,
            onViewportChange,
            onSelectionChange: (next) => {
              onSelectionChange(next);
              setSelection(next);
            },
          })}
        />
      );
    }
    const { container } = render(<ControlledGrid />);
    const grid = screen.getByRole("grid");
    const origin = screen.getByRole("gridcell", { name: "0:0" });
    const edgeCell = screen.getByRole("gridcell", { name: "2:0" });
    const elementFromPoint = vi.fn((): Element | null => edgeCell);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });

    fireEvent.pointerDown(origin, {
      button: 0,
      pointerId: 31,
      clientX: 200,
      clientY: 14,
    });
    fireEvent.pointerMove(grid, {
      pointerId: 31,
      clientX: 200,
      clientY: 70,
    });

    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(0));
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          range: { x: 0, y: 0, width: 1, height: 5 },
        }),
      }),
    );
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 2 }),
    );

    fireEvent.pointerMove(grid, {
      pointerId: 31,
      clientX: 410,
      clientY: 42,
    });
    act(() => frames.shift()?.(0));
    act(() => frames.shift()?.(0));
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    expect(bodyScrollport.scrollLeft).toBe(28);
    expect(horizontalScrollport.scrollLeft).toBe(28);

    elementFromPoint.mockReturnValue(null);
    onSelectionChange.mockClear();
    fireEvent.pointerMove(grid, {
      pointerId: 31,
      clientX: 200,
      clientY: 42,
    });
    act(() => {
      for (const frame of frames.splice(0)) {
        frame(0);
      }
    });
    expect(frames).toHaveLength(0);
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(grid, {
      pointerId: 31,
      clientX: 200,
      clientY: 70,
    });
    expect(frames).toHaveLength(1);
    fireEvent.pointerUp(grid, { pointerId: 31 });
    act(() => {
      for (const frame of frames.splice(0)) {
        frame(0);
      }
    });
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
  });

  it("reports a live resize with the column index before its width", () => {
    const onColumnResize = vi.fn();
    installPointerCapture();
    const { container } = render(<ViewdaGrid {...props({ onColumnResize })} />);
    const handle = container.querySelector(
      '[data-action="resize"][data-column="0"]',
    ) as HTMLElement;

    fireEvent.pointerDown(handle, { pointerId: 9, clientX: 100 });
    fireEvent.pointerMove(screen.getByRole("grid"), {
      pointerId: 9,
      clientX: 135,
    });

    expect(onColumnResize).toHaveBeenCalledWith(0, 135);
  });

  it("keeps the column width when a resize pointer does not move", () => {
    const onColumnResize = vi.fn();
    installPointerCapture();
    const { container } = render(<ViewdaGrid {...props({ onColumnResize })} />);
    const handle = container.querySelector(
      '[data-action="resize"][data-column="0"]',
    ) as HTMLElement;
    const header = handle.closest<HTMLElement>('[role="columnheader"]');

    fireEvent.pointerDown(handle, { pointerId: 10, clientX: 100 });
    fireEvent.pointerUp(screen.getByRole("grid"), {
      pointerId: 10,
      clientX: 100,
    });

    expect(onColumnResize).not.toHaveBeenCalled();
    expect(header).toHaveStyle({ width: "100px" });
  });

  it("keeps resize clicks out of column selection", () => {
    const onColumnAutoFit = vi.fn();
    const onSelectionChange = vi.fn();
    const { container } = render(
      <ViewdaGrid {...props({ onColumnAutoFit, onSelectionChange })} />,
    );
    const handle = container.querySelector(
      '[data-action="resize"][data-column="0"]',
    ) as HTMLElement;

    fireEvent.click(handle);
    fireEvent.doubleClick(handle);

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onColumnAutoFit).toHaveBeenCalledOnce();
  });

  it("suppresses only the click synthesized by a completed resize", () => {
    const onColumnResize = vi.fn();
    const onSelectionChange = vi.fn();
    installPointerCapture();
    const { container } = render(
      <ViewdaGrid {...props({ onColumnResize, onSelectionChange })} />,
    );
    const handle = container.querySelector(
      '[data-action="resize"][data-column="0"]',
    ) as HTMLElement;
    const header = handle.closest<HTMLElement>('[role="columnheader"]')!;
    const grid = screen.getByRole("grid");

    fireEvent.pointerDown(handle, { pointerId: 11, clientX: 100 });
    fireEvent.pointerMove(grid, { pointerId: 11, clientX: 120 });
    fireEvent.pointerUp(grid, { pointerId: 11, clientX: 120 });
    fireEvent.click(header);
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.pointerDown(handle, { pointerId: 12, clientX: 100 });
    fireEvent.pointerMove(grid, { pointerId: 12, clientX: 120 });
    fireEvent.pointerCancel(grid, { pointerId: 12, clientX: 120 });
    fireEvent.click(header);
    expect(onSelectionChange).toHaveBeenCalledOnce();
  });

  it("releases captured gestures on blur and unmount", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const { setPointerCapture, releasePointerCapture } =
      installPointerCapture();
    const onSelectionChange = vi.fn();
    const { container, unmount } = render(
      <ViewdaGrid {...props({ onSelectionChange })} />,
    );
    const grid = screen.getByRole("grid");
    const cell = screen.getByRole("gridcell", { name: "0:0" });
    fireEvent.pointerDown(cell, { button: 0, pointerId: 21 });
    fireEvent.pointerMove(grid, {
      pointerId: 21,
      clientX: 200,
      clientY: 200,
    });
    fireEvent.blur(grid);
    expect(releasePointerCapture).toHaveBeenCalledWith(21);
    expect(window.cancelAnimationFrame).toHaveBeenCalled();

    onSelectionChange.mockClear();
    fireEvent.click(cell);
    expect(onSelectionChange).toHaveBeenCalledOnce();

    const liveResize = container.querySelector(
      '[data-action="resize"][data-column="0"]',
    ) as HTMLElement;
    fireEvent.pointerDown(liveResize, { pointerId: 22, clientX: 100 });
    expect(setPointerCapture).toHaveBeenCalledWith(22);
    unmount();
    expect(releasePointerCapture).toHaveBeenCalledWith(22);
  });

  it("coalesces scroll and resize reads into one animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    let resize: (() => void) | undefined;
    const read = vi.fn((scrollport: HTMLElement) => ({
      width: 420,
      height: 84,
      scrollTop: scrollport.scrollTop,
      scrollLeft: scrollport.scrollLeft,
      devicePixelRatio: 1,
    }));
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84),
      read,
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid {...props({ measurementPort: port, onViewportChange })} />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    read.mockClear();
    onViewportChange.mockClear();
    scrollport.scrollTop = 112;
    fireEvent.scroll(scrollport);
    fireEvent.scroll(scrollport);
    resize?.();

    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(0));
    expect(read).toHaveBeenCalledOnce();
    expect(onViewportChange).toHaveBeenCalledTimes(1);
  });

  it("forwards header horizontal wheel and handles every vertical zone once", async () => {
    const columns = [column(0, true), column(1), column(2), column(3)];
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid
        {...props({
          columns,
          rowCount: 1_000_000_000,
          onViewportChange,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;
    const header = container.querySelector(
      ".viewda-grid-header",
    ) as HTMLElement;
    const horizontal = wheelEvent({ deltaX: 112 }, 0);
    act(() => header.dispatchEvent(horizontal));
    expect(horizontal.defaultPrevented).toBe(true);
    expect(bodyScrollport.scrollLeft).toBe(112);
    expect(horizontalScrollport.scrollLeft).toBe(112);
    expect(scrollingHeaders).toHaveStyle({
      transform: "translateX(-112px)",
    });

    const targets = [
      header,
      screen.getByRole("rowheader", { name: "1" }),
      container.querySelector(".viewda-grid-cell.is-pinned") as HTMLElement,
      container.querySelector(
        ".viewda-grid-cell:not(.is-pinned)",
      ) as HTMLElement,
    ];
    for (const [index, target] of targets.entries()) {
      const wheel = wheelEvent({ deltaY: 28 }, 200 + index * 10);
      act(() => target.dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(true);
    }

    await waitFor(() =>
      expect(
        container.querySelector('.viewda-grid-row[aria-rowindex="2"]'),
      ).toBeNull(),
    );
    expect(
      container.querySelector('.viewda-grid-row[aria-rowindex="3"]'),
    ).toBeInTheDocument();

    const tinyWheel = wheelEvent({ deltaY: 0.1 }, 400);
    act(() => horizontalScrollport.dispatchEvent(tinyWheel));
    expect(tinyWheel.defaultPrevented).toBe(true);
  });

  it("maps Shift+wheel to horizontal movement", () => {
    const { container } = render(<ViewdaGrid {...props()} />);
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const shiftedWheel = wheelEvent(
      {
        deltaY: 3,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        shiftKey: true,
      },
      0,
    );

    act(() => bodyScrollport.dispatchEvent(shiftedWheel));

    expect(shiftedWheel.defaultPrevented).toBe(true);
    expect(bodyScrollport.scrollLeft).toBe(84);
    expect(horizontalScrollport.scrollLeft).toBe(84);
    expect(bodyScrollport.scrollTop).toBe(0);
  });

  it("lets pure vertical input take over a horizontal gesture", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid
        {...props({
          rowCount: 1_000_000_000,
          onViewportChange,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    frames.length = 0;
    onViewportChange.mockClear();

    const undecided = wheelEvent({ deltaX: 10, deltaY: 9 }, 0);
    act(() => horizontalScrollport.dispatchEvent(undecided));
    expect(undecided.defaultPrevented).toBe(true);
    expect(bodyScrollport.scrollLeft).toBe(0);
    expect(horizontalScrollport.scrollLeft).toBe(0);
    expect(onViewportChange).not.toHaveBeenCalled();

    const horizontal = wheelEvent({ deltaX: 10, deltaY: 1 }, 10);
    act(() => horizontalScrollport.dispatchEvent(horizontal));
    expect(bodyScrollport.scrollLeft).toBe(20);
    expect(horizontalScrollport.scrollLeft).toBe(20);
    const vertical = wheelEvent({ deltaY: 84 }, 20);
    act(() => horizontalScrollport.dispatchEvent(vertical));
    expect(bodyScrollport.scrollLeft).toBe(20);
    expect(horizontalScrollport.scrollLeft).toBe(20);
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 3 }),
    );
    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(0));
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 3 }),
    );
  });

  it("preserves tiny logical wheel progress across readback and parent renders", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const onViewportChange = vi.fn();
    const initialProps = props({
      rowCount: 1_000_000_000,
      onViewportChange,
      measurementPort: measurementPort(420, 84, 1_000_000),
    });
    const { container, rerender } = render(<ViewdaGrid {...initialProps} />);
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    frames.length = 0;
    onViewportChange.mockClear();

    let timeStamp = 0;
    const dispatchWheel = () =>
      scrollport.dispatchEvent(wheelEvent({ deltaY: 0.1 }, timeStamp++));
    act(() => {
      dispatchWheel();
      frames.shift()?.(0);
    });
    expect(scrollport.scrollTop).toBe(0);
    rerender(<ViewdaGrid {...initialProps} contentRevision={1} />);
    act(() => {
      for (let index = 1; index < 280; index += 1) {
        dispatchWheel();
        frames.shift()?.(0);
      }
    });

    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: expect.any(Number) }),
    );
    const lastRowStart = onViewportChange.mock.calls.at(-1)?.[0].rowStart ?? 0;
    expect(lastRowStart).toBe(1);
  });

  it("keeps a compressed row boundary after whole-pixel scroll read-back", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid
        {...props({
          rowCount: 3_514_000,
          onViewportChange,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    let quantizedScrollTop = Math.floor(scrollport.scrollTop);
    Object.defineProperty(scrollport, "scrollTop", {
      configurable: true,
      get: () => quantizedScrollTop,
      set: (value: number) => {
        quantizedScrollTop = Math.floor(value);
      },
    });
    frames.length = 0;
    onViewportChange.mockClear();

    const wheel = wheelEvent({ deltaY: 56 }, 0);
    act(() => scrollport.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(true);
    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(0));

    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 2 }),
    );
    const firstVisibleRow = screen
      .getByRole("rowheader", { name: "3" })
      .closest<HTMLElement>(".viewda-grid-row");
    const rowLayer = container.querySelector<HTMLElement>(
      ".viewda-grid-visible-rows",
    );
    expect(firstVisibleRow).not.toBeNull();
    expect(transformY(rowLayer) + transformY(firstVisibleRow)).toBe(
      quantizedScrollTop,
    );
  });

  it("keeps overlapping compressed rows stable through a bounded coordinate anchor", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const ref = createRef<ViewdaGridHandle>();
    const getCellContent = vi.fn(props().getCellContent);
    const { container } = render(
      <ViewdaGrid
        ref={ref}
        {...props({
          rowCount: 3_514_000,
          getCellContent,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    act(() => ref.current?.scrollToRow(100));
    act(() => frames.shift()?.(0));
    const stableRow = container.querySelector<HTMLElement>(
      '.viewda-grid-row[aria-rowindex="102"]',
    );
    const initialTransform = stableRow?.style.transform;
    const rowLayer = container.querySelector<HTMLElement>(
      ".viewda-grid-visible-rows",
    );
    const firstVisibleRow = screen
      .getByRole("rowheader", { name: "101" })
      .closest<HTMLElement>(".viewda-grid-row");
    expect(transformY(rowLayer) + transformY(firstVisibleRow)).toBeCloseTo(
      scrollport.scrollTop,
      5,
    );
    expect(Number.isInteger(transformY(rowLayer))).toBe(false);
    expect(Math.abs(transformY(rowLayer))).toBeLessThan(4_000);
    frames.length = 0;
    getCellContent.mockClear();

    for (let step = 0; step < 3; step += 1) {
      act(() =>
        scrollport.dispatchEvent(wheelEvent({ deltaY: 28 }, step * 16)),
      );
      act(() => frames.shift()?.(step * 16));
      expect(getCellContent).toHaveBeenCalledTimes((step + 1) * 8);
    }

    expect(
      container.querySelector('.viewda-grid-row[aria-rowindex="102"]'),
    ).toBe(stableRow);
    expect(stableRow?.style.transform).toBe(initialTransform);

    act(() => ref.current?.scrollToRow(3_513_997));
    act(() => frames.shift()?.(64));
    expect(
      container.querySelectorAll(".viewda-grid-row").length,
    ).toBeGreaterThan(0);
    expect(Math.abs(transformY(rowLayer))).toBeLessThanOrEqual(1_000_000);
  });

  it("preserves a compressed scrollToRow command through resize readback", () => {
    const frames: FrameRequestCallback[] = [];
    let resize: (() => void) | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const port: GridMeasurementPort = {
      ...measurementPort(420, 84, 1_000_000),
      observe: (_element, callback) => {
        resize = callback;
        return () => undefined;
      },
    };
    const ref = createRef<ViewdaGridHandle>();
    const onViewportChange = vi.fn();
    const { container } = render(
      <ViewdaGrid
        ref={ref}
        {...props({
          rowCount: 1_000_000_000,
          onViewportChange,
          measurementPort: port,
        })}
      />,
    );
    frames.length = 0;
    onViewportChange.mockClear();

    act(() => ref.current?.scrollToRow(1));
    resize?.();
    expect(frames).toHaveLength(1);
    act(() => frames.shift()?.(0));

    expect(screen.getByRole("rowheader", { name: "2" })).toBeInTheDocument();
    const firstRow = container.querySelector<HTMLElement>(
      '.viewda-grid-row[aria-rowindex="2"]',
    );
    const rowLayer = container.querySelector<HTMLElement>(
      ".viewda-grid-visible-rows",
    );
    expect(transformY(rowLayer) + transformY(firstRow)).toBeCloseTo(-28, 2);
    expect(onViewportChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowStart: 1 }),
    );
  });

  it("steps native wheel events by logical rows over every body zone", () => {
    const columns = [column(0, true), column(1), column(2)];
    const { container } = render(
      <ViewdaGrid
        {...props({
          columns,
          rowCount: 1_000,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    let timeStamp = 1;
    for (let index = 0; index < 3; index += 1) {
      const target =
        index === 0
          ? screen.getByRole("rowheader", { name: String(index * 3 + 1) })
          : index === 1
            ? (container.querySelector(
                ".viewda-grid-cell.is-pinned",
              ) as HTMLElement)
            : (container.querySelector(
                ".viewda-grid-cell:not(.is-pinned)",
              ) as HTMLElement);
      const wheel = wheelEvent(
        { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE },
        timeStamp,
      );
      timeStamp += 10;
      act(() => target.dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(true);
      expect(scrollport.scrollTop).toBeCloseTo((index + 1) * 84, 10);
    }

    const headerWheel = wheelEvent(
      { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE },
      timeStamp,
    );
    act(() =>
      (
        container.querySelector(".viewda-grid-header") as HTMLElement
      ).dispatchEvent(headerWheel),
    );
    expect(headerWheel.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBeCloseTo(336, 10);

    const zoom = wheelEvent({ deltaY: 84, ctrlKey: true }, 40);
    act(() => scrollport.dispatchEvent(zoom));
    expect(zoom.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop).toBeCloseTo(336, 10);
  });

  it("yields a downward wheel at the bottom and resets the gesture", () => {
    const ref = createRef<ViewdaGridHandle>();
    const { container } = render(
      <ViewdaGrid
        ref={ref}
        {...props({
          rowCount: 1_000,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    act(() => ref.current?.scrollToRow(1_000));
    const maximum = scrollport.scrollTop;

    const wheel = wheelEvent({ deltaY: 84 }, 1);
    act(() => scrollport.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop).toBe(maximum);

    const inward = wheelEvent({ deltaY: -28 }, 2);
    act(() => scrollport.dispatchEvent(inward));
    expect(inward.defaultPrevented).toBe(true);
    expect(scrollport.scrollTop).toBeLessThan(maximum);
  });

  it("resolves a sustained interior diagonal tie to vertical movement", () => {
    const { container } = render(
      <ViewdaGrid
        {...props({
          columns: Array.from({ length: 20 }, (_, index) => column(index)),
          rowCount: 100,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const wheels = [1, 2, 3].map((timeStamp) =>
      wheelEvent({ deltaX: 10, deltaY: 10 }, timeStamp),
    );

    act(() => scrollport.dispatchEvent(wheels[0]!));
    act(() => scrollport.dispatchEvent(wheels[1]!));
    expect(scrollport.scrollTop).toBe(0);
    expect(scrollport.scrollLeft).toBe(0);

    act(() => scrollport.dispatchEvent(wheels[2]!));

    expect(wheels.every((wheel) => wheel.defaultPrevented)).toBe(true);
    expect(scrollport.scrollTop).toBe(28);
    expect(scrollport.scrollLeft).toBe(0);
  });

  it("repeatedly yields a vertical diagonal tie at a row boundary", () => {
    const ref = createRef<ViewdaGridHandle>();
    const { container } = render(
      <ViewdaGrid
        ref={ref}
        {...props({
          rowCount: 1_000,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    act(() => ref.current?.scrollToRow(1_000));
    const maximum = scrollport.scrollTop;
    const horizontalStart = scrollport.scrollLeft;

    const first = wheelEvent({ deltaY: 10, deltaX: 10 }, 1);
    act(() => scrollport.dispatchEvent(first));
    const repeated = wheelEvent({ deltaY: 10, deltaX: 10 }, 2);
    act(() => scrollport.dispatchEvent(repeated));

    expect(first.defaultPrevented).toBe(false);
    expect(repeated.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop).toBe(maximum);
    expect(scrollport.scrollLeft).toBe(horizontalStart);

    act(() => ref.current?.scrollToRow(0));
    const upward = wheelEvent({ deltaY: -10, deltaX: 10 }, 3);
    act(() => scrollport.dispatchEvent(upward));
    expect(upward.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop).toBe(0);
    expect(scrollport.scrollLeft).toBe(horizontalStart);
  });

  it("never traps a vertical wheel when there is no row extent", () => {
    const outerWheel = vi.fn<(event: Event) => void>();
    const { container } = render(
      <div>
        <ViewdaGrid
          {...props({
            rowCount: 1,
            measurementPort: measurementPort(420, 84, 1_000_000),
          })}
        />
      </div>,
    );
    container.firstElementChild?.addEventListener("wheel", outerWheel);
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    const wheel = wheelEvent({ deltaY: 28 }, 1);
    act(() => scrollport.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(false);
    expect(outerWheel).toHaveBeenCalledOnce();
    expect(outerWheel.mock.calls[0]?.[0].defaultPrevented).toBe(false);
  });

  it("yields an upward wheel at the top", () => {
    const { container } = render(
      <ViewdaGrid
        {...props({
          rowCount: 100,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    const wheel = wheelEvent({ deltaY: -28 }, 1);
    act(() => scrollport.dispatchEvent(wheel));

    expect(wheel.defaultPrevented).toBe(false);
    expect(scrollport.scrollTop).toBe(0);
  });

  it("consumes interior movement and sub-row accumulation", () => {
    const { container } = render(
      <ViewdaGrid
        {...props({
          rowCount: 100,
          measurementPort: measurementPort(420, 84, 1_000_000),
        })}
      />,
    );
    const scrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;

    for (let index = 0; index < 4; index += 1) {
      const wheel = wheelEvent({ deltaY: 7 }, index + 1);
      act(() => scrollport.dispatchEvent(wheel));
      expect(wheel.defaultPrevented).toBe(true);
    }
    expect(scrollport.scrollTop).toBe(28);
  });

  it("re-reads bounded cells when content revision changes", () => {
    let value = "loading";
    const getCellContent = vi.fn(() => ({
      kind: "text" as const,
      displayData: value,
      copyData: value,
      alignment: "left" as const,
      faded: false,
    }));
    const initialProps = props({ getCellContent });
    const { rerender } = render(<ViewdaGrid {...initialProps} />);
    const firstReadCount = getCellContent.mock.calls.length;
    const renderedCellCount = screen.getAllByRole("gridcell").length;

    value = "loaded";
    rerender(<ViewdaGrid {...initialProps} contentRevision={1} />);

    expect(getCellContent.mock.calls.length).toBeGreaterThan(firstReadCount);
    expect(screen.getAllByRole("gridcell", { name: "loaded" })).toHaveLength(
      renderedCellCount,
    );
  });

  it("supports keyboard navigation without moving DOM focus into a cell", () => {
    const onSelectionChange = vi.fn();
    render(<ViewdaGrid {...props({ onSelectionChange })} />);

    const grid = screen.getByRole("grid");
    grid.focus();
    fireEvent.keyDown(grid, { key: "ArrowDown" });

    expect(document.activeElement).toBe(grid);
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ cell: { row: 1, column: 0 } }),
      }),
    );
  });

  it("routes column commands and keyboard visibility through the body scrollport", () => {
    const ref = createRef<ViewdaGridHandle>();
    const selection = selectCell(
      emptyGridSelection(),
      { row: 0, column: 0 },
      false,
      false,
    );
    const onSelectionChange = vi.fn();
    const { container } = render(
      <ViewdaGrid ref={ref} {...props({ selection, onSelectionChange })} />,
    );
    const bodyScrollport = container.querySelector(
      ".viewda-grid-body-scrollport",
    ) as HTMLElement;
    const horizontalScrollport = container.querySelector(
      ".viewda-grid-horizontal-scrollport",
    ) as HTMLElement;
    const scrollingHeaders = container.querySelector(
      ".viewda-grid-scrolling-headers",
    ) as HTMLElement;

    act(() => ref.current?.scrollToColumn(11, 8));

    expect(bodyScrollport.scrollLeft).toBe(841);
    expect(horizontalScrollport.scrollLeft).toBe(841);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-841px)" });

    bodyScrollport.scrollLeft = 0;
    fireEvent.scroll(bodyScrollport);
    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "ArrowRight",
      ctrlKey: true,
    });

    expect(onSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ cell: { row: 0, column: 11 } }),
      }),
    );
    expect(bodyScrollport.scrollLeft).toBe(841);
    expect(horizontalScrollport.scrollLeft).toBe(841);
    expect(scrollingHeaders).toHaveStyle({ transform: "translateX(-841px)" });
  });

  it.each([
    ["Home", {}, { row: 5, column: 0 }],
    ["End", {}, { row: 5, column: 11 }],
    ["ArrowUp", { ctrlKey: true }, { row: 0, column: 3 }],
    ["ArrowDown", { ctrlKey: true }, { row: 999, column: 3 }],
    ["ArrowLeft", { ctrlKey: true }, { row: 5, column: 0 }],
    ["ArrowRight", { ctrlKey: true }, { row: 5, column: 11 }],
    ["Home", { ctrlKey: true }, { row: 0, column: 0 }],
    ["End", { ctrlKey: true }, { row: 999, column: 11 }],
    ["PageUp", {}, { row: 2, column: 3 }],
    ["PageDown", {}, { row: 8, column: 3 }],
  ] as const)(
    "maps %s with %o to the baseline destination",
    (key, modifiers, destination) => {
      const selection = selectCell(
        emptyGridSelection(),
        { row: 5, column: 3 },
        false,
        false,
      );
      const onSelectionChange = vi.fn();
      render(
        <ViewdaGrid
          {...props({ selection, onSelectionChange, rowCount: 1_000 })}
        />,
      );

      fireEvent.keyDown(screen.getByRole("grid"), { key, ...modifiers });

      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          current: expect.objectContaining({ cell: destination }),
        }),
      );
    },
  );

  it.each([
    ["Home", {}, { x: 0, y: 5, width: 4, height: 1 }],
    ["End", {}, { x: 3, y: 5, width: 9, height: 1 }],
    ["ArrowUp", { ctrlKey: true }, { x: 3, y: 0, width: 1, height: 6 }],
    ["ArrowDown", { ctrlKey: true }, { x: 3, y: 5, width: 1, height: 995 }],
    ["ArrowLeft", { ctrlKey: true }, { x: 0, y: 5, width: 4, height: 1 }],
    ["ArrowRight", { ctrlKey: true }, { x: 3, y: 5, width: 9, height: 1 }],
    ["Home", { ctrlKey: true }, { x: 0, y: 0, width: 4, height: 6 }],
    ["End", { ctrlKey: true }, { x: 3, y: 5, width: 9, height: 995 }],
    ["PageUp", {}, { x: 3, y: 2, width: 1, height: 4 }],
    ["PageDown", {}, { x: 3, y: 5, width: 1, height: 4 }],
  ] as const)(
    "extends selection through the %s destination",
    (key, modifiers, range) => {
      const selection = selectCell(
        emptyGridSelection(),
        { row: 5, column: 3 },
        false,
        false,
      );
      const onSelectionChange = vi.fn();
      render(
        <ViewdaGrid
          {...props({ selection, onSelectionChange, rowCount: 1_000 })}
        />,
      );

      fireEvent.keyDown(screen.getByRole("grid"), {
        key,
        ...modifiers,
        shiftKey: true,
      });

      expect(onSelectionChange).toHaveBeenCalledWith(
        expect.objectContaining({
          current: expect.objectContaining({ range }),
        }),
      );
    },
  );

  it("treats Command as the primary modifier", () => {
    const selection = selectCell(
      emptyGridSelection(),
      { row: 5, column: 3 },
      false,
      false,
    );
    const onSelectionChange = vi.fn();
    render(<ViewdaGrid {...props({ selection, onSelectionChange })} />);

    fireEvent.keyDown(screen.getByRole("grid"), {
      key: "End",
      metaKey: true,
    });

    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          cell: { row: 999, column: 11 },
        }),
      }),
    );
  });

  it.each([{ ctrlKey: true }, { metaKey: true }])(
    "selects every non-empty cell with the primary A shortcut and forwards copy",
    (modifier) => {
      const onSelectionChange = vi.fn();
      const onCopy = vi.fn();
      const initial = props({ onSelectionChange, onCopy, rowCount: 1_000 });
      const { rerender } = render(<ViewdaGrid {...initial} />);
      const grid = screen.getByRole("grid");

      fireEvent.keyDown(grid, { key: "a", ...modifier });

      const next = onSelectionChange.mock.calls[0]?.[0];
      expect(next).toEqual({
        columns: initial.selection.columns,
        rows: initial.selection.rows,
        current: {
          cell: { row: 0, column: 0 },
          range: { x: 0, y: 0, width: 12, height: 1_000 },
          rangeStack: [],
        },
      });
      if (next === undefined) {
        throw new Error("Select all did not produce a selection.");
      }
      rerender(<ViewdaGrid {...initial} selection={next} />);
      fireEvent.copy(grid);
      expect(onCopy).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { columns: [] as GridColumn[], rowCount: 1_000 },
    { columns: [column(0)], rowCount: 0 },
  ])("ignores grid navigation when no logical cell exists", (emptyView) => {
    const onSelectionChange = vi.fn();
    const onEscape = vi.fn();
    render(
      <ViewdaGrid {...props({ ...emptyView, onSelectionChange, onEscape })} />,
    );
    const grid = screen.getByRole("grid");

    for (const event of [
      { key: "ArrowDown" },
      { key: "Home" },
      { key: "End", ctrlKey: true },
      { key: "a", ctrlKey: true },
    ]) {
      fireEvent.keyDown(grid, event);
    }
    fireEvent.keyDown(grid, { key: "Escape" });

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(onEscape).toHaveBeenCalledOnce();
    expect(grid).not.toHaveAttribute("aria-activedescendant");
  });
});
