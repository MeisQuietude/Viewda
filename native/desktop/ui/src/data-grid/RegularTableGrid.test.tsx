import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import type { RegularTableElement } from "regular-table";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  RegularTableGrid,
  type RegularTableGridProps,
  type RegularTableGridRef,
} from "./RegularTableGrid";
import {
  CompactSelection,
  GridCellKind,
  type GridCell,
  type GridColumn,
} from "./grid-model";
import {
  GRID_HEADER_HEIGHT,
  GRID_HEADER_SIDE_RESERVED_SPACE,
  GRID_ROW_HEIGHT,
} from "./grid-layout";

class TestStyleSheet {
  readonly cssRules = [{ style: document.documentElement.style }];

  replaceSync() {}
}

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

const columns: GridColumn[] = Array.from({ length: 6 }, (_, index) => ({
  title: `column_${index}`,
  width: 120,
  monospace: index === 1,
  sort:
    index === 2
      ? { direction: "ascending", priority: 1 }
      : { direction: "neutral" },
}));

function textCell(column: number, row: number): GridCell {
  return {
    kind: GridCellKind.Text,
    displayData: `${column}:${row}`,
    copyData: `${column}:${row}`,
    contentAlign: column === 1 ? "right" : "left",
    style: row === 3 ? "faded" : "normal",
  };
}

function createProps(
  overrides: Partial<RegularTableGridProps> = {},
): RegularTableGridProps {
  return {
    columns,
    rows: 2_000_000_000,
    freezeColumns: 2,
    minColumnWidth: 112,
    maxColumnWidth: 500,
    gridSelection: {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
    },
    getCellContent: ([column, row]) => textCell(column, row),
    getCellsForSelection: async (rectangle) =>
      Array.from({ length: rectangle.height }, (_, row) =>
        Array.from({ length: rectangle.width }, (_, column) =>
          textCell(rectangle.x + column, rectangle.y + row),
        ),
      ),
    onGridSelectionChange: vi.fn(),
    onCellContextMenu: vi.fn(),
    onHeaderClicked: vi.fn(),
    onVisibleRegionChanged: vi.fn(),
    onColumnResize: vi.fn(),
    onColumnResizeStart: vi.fn(),
    onColumnResizeEnd: vi.fn(),
    onColumnAutoFit: vi.fn().mockResolvedValue(undefined),
    onHeaderMenuClick: vi.fn(),
    ...overrides,
  };
}

function mockHorizontalScrollRange(table: RegularTableElement): void {
  Object.defineProperty(table, "scrollWidth", {
    configurable: true,
    value: table.clientWidth + 1_000,
  });
}

afterAll(() => {
  document.body.replaceChildren();
});

beforeEach(() => {
  vi.stubGlobal("CSSStyleSheet", TestStyleSheet);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.tagName === "TH" ? GRID_HEADER_HEIGHT : GRID_ROW_HEIGHT;
    },
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    function (this: Element) {
      const height =
        this.tagName === "TH" ? GRID_HEADER_HEIGHT : GRID_ROW_HEIGHT;
      return {
        x: 0,
        y: 0,
        top: 0,
        right: 120,
        bottom: height,
        left: 0,
        width: 120,
        height,
        toJSON: () => ({}),
      };
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RegularTableGrid", () => {
  it("renders a bounded viewport with pinned columns in one semantic table", async () => {
    const props = createProps();
    const { container } = render(<RegularTableGrid {...props} />);

    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    expect(
      regularTable.style.getPropertyValue("--viewda-grid-header-height"),
    ).toBe(`${GRID_HEADER_HEIGHT}px`);
    expect(
      regularTable.style.getPropertyValue("--viewda-grid-header-side-reserve"),
    ).toBe(`${GRID_HEADER_SIDE_RESERVED_SPACE}px`);
    const table = regularTable.querySelector("table");
    expect(regularTable).toHaveAttribute("role", "grid");
    expect(regularTable).toHaveAttribute("aria-rowcount", "2000000001");
    expect(regularTable).toHaveAttribute("aria-colcount", "7");
    expect(table).toHaveAttribute("role", "presentation");
    expect(container.querySelectorAll("tbody tr").length).toBeLessThan(30);
    expect(regularTable.saveColumnSizes()[0]).toBe(97);
    const virtualPanel =
      regularTable.shadowRoot?.querySelector<HTMLElement>(".rt-virtual-panel");
    const contentWidth = Object.values(regularTable.saveColumnSizes()).reduce(
      (total, width) => total + width,
      0,
    );
    expect(virtualPanel?.style.width).toBe(`${contentWidth}px`);
    expect(virtualPanel?.style.minWidth).toBe(`${contentWidth}px`);
    expect(virtualPanel?.style.maxWidth).toBe(`${contentWidth}px`);
    expect(table?.querySelector("tbody tr")).toHaveAttribute(
      "aria-rowindex",
      "2",
    );

    expect(props.onVisibleRegionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 2 }),
      {
        freezeRegions: [expect.objectContaining({ x: 0, width: 2 })],
      },
    );
    expect(
      table?.querySelector('[role="gridcell"][aria-colindex="2"]'),
    ).toHaveTextContent("0:0");
    expect(
      table?.querySelector('[role="gridcell"][aria-colindex="3"]'),
    ).toHaveTextContent("1:0");
    expect(
      table?.querySelector('[role="columnheader"][aria-colindex="4"]'),
    ).toMatchObject({
      title: "column_2",
      dataset: expect.objectContaining({
        sortDirection: "ascending",
      }),
    });
    expect(
      table?.querySelector('[role="columnheader"][aria-colindex="4"]'),
    ).not.toHaveAttribute("data-sort-priority");
    expect(
      table?.querySelector('[role="gridcell"][aria-colindex="3"]'),
    ).toHaveClass("viewda-grid-monospace", "viewda-grid-align-right");
  });

  it("maps mouse, keyboard and header menu interactions to logical cells", async () => {
    const selectionChanged = vi.fn();
    const headerMenu = vi.fn();
    const navigationColumns = Array.from({ length: 20 }, (_, index) => ({
      ...columns[index % columns.length]!,
      title: `column_${index}`,
    }));
    const props = createProps({
      columns: navigationColumns,
      rows: 100,
      onGridSelectionChange: selectionChanged,
      onHeaderMenuClick: headerMenu,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    const bodyCell = await waitFor(() => {
      const cell = regularTable.querySelector(
        '[role="gridcell"][aria-colindex="4"][aria-rowindex="2"]',
      );
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    await regularTable.flush();
    vi.mocked(props.onVisibleRegionChanged).mockClear();
    fireEvent.mouseDown(bodyCell, { button: 0 });
    expect(selectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          cell: [2, 0],
          range: { x: 2, y: 0, width: 1, height: 1 },
        }),
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(props.onVisibleRegionChanged).not.toHaveBeenCalled();

    fireEvent.keyDown(regularTable, { key: "ArrowDown", shiftKey: true });
    expect(selectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          cell: [2, 0],
          range: { x: 2, y: 0, width: 1, height: 2 },
        }),
      }),
    );
    expect(regularTable.scrollTop).toBe(0);

    fireEvent.keyDown(regularTable, { key: "ArrowRight" });
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(regularTable.scrollLeft).toBe(0);
    expect(regularTable.scrollTop).toBe(0);

    const menu = regularTable.querySelector(
      'th[aria-colindex="4"] .viewda-grid-header-menu',
    );
    expect(menu).toBeInstanceOf(HTMLButtonElement);
    fireEvent.click(menu!);
    expect(headerMenu).toHaveBeenCalledWith(2, expect.any(Object));

    fireEvent.keyDown(regularTable, { key: "End", ctrlKey: true });
    await waitFor(() => expect(regularTable.scrollLeft).toBeGreaterThan(0));
  });

  it("supports keyboard movement, range growth and native focus escape", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      2_832,
    );
    const selectionChanged = vi.fn();
    const navigationColumns = Array.from({ length: 20 }, (_, index) => ({
      ...columns[index % columns.length]!,
      title: `column_${index}`,
    }));
    const props = createProps({
      columns: navigationColumns,
      rows: 100,
      freezeColumns: 0,
      onGridSelectionChange: selectionChanged,
    });
    render(
      <>
        <button type="button">Data</button>
        <RegularTableGrid {...props} />
      </>,
    );

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    const firstCell = await waitFor(() => {
      const cell = regularTable.querySelector(
        '[role="gridcell"][aria-colindex="2"][aria-rowindex="2"]',
      );
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    fireEvent.mouseDown(firstCell, { button: 0 });
    selectionChanged.mockClear();

    expect(
      fireEvent.keyDown(regularTable, { key: "Enter", ctrlKey: true }),
    ).toBe(false);
    expect(selectionChanged).not.toHaveBeenCalled();

    fireEvent.keyDown(regularTable, { key: "Enter" });
    expect(selectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ cell: [0, 1] }),
      }),
    );
    fireEvent.mouseDown(firstCell, { button: 0 });
    selectionChanged.mockClear();

    fireEvent.keyDown(regularTable, { key: "ArrowDown", shiftKey: true });
    expect(selectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          cell: [0, 0],
          range: { x: 0, y: 0, width: 1, height: 2 },
        }),
      }),
    );

    fireEvent.keyDown(regularTable, { key: "ArrowRight", altKey: true });
    expect(selectionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({
          cell: [1, 0],
          range: { x: 1, y: 0, width: 1, height: 1 },
          rangeStack: [{ x: 0, y: 0, width: 1, height: 2 }],
        }),
      }),
    );

    fireEvent.keyDown(regularTable, { key: "End", ctrlKey: true });
    await waitFor(() =>
      expect(
        regularTable.querySelector(
          '[role="gridcell"][aria-colindex="21"][aria-rowindex="101"]',
        ),
      ).toHaveClass("viewda-grid-active"),
    );
    const finalRange = vi
      .mocked(props.onVisibleRegionChanged)
      .mock.calls.at(-1)?.[0];
    expect(finalRange?.x).toBeLessThanOrEqual(19);
    expect((finalRange?.x ?? 0) + (finalRange?.width ?? 0)).toBeGreaterThan(19);
    expect(finalRange?.y).toBeLessThanOrEqual(99);
    expect((finalRange?.y ?? 0) + (finalRange?.height ?? 0)).toBeGreaterThan(
      99,
    );
    selectionChanged.mockClear();
    expect(fireEvent.keyDown(regularTable, { key: "Tab" })).toBe(true);
    expect(regularTable).toHaveFocus();
    expect(selectionChanged).not.toHaveBeenCalled();
    expect(
      regularTable.querySelector(".viewda-grid-header-menu"),
    ).toHaveAttribute("tabindex", "-1");
  });

  it("renders the focused cell when keyboard movement crosses the viewport", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      10_000_000,
    );
    const props = createProps({ rows: 3_514_000, freezeColumns: 0 });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    const lastFullyVisibleCell = await waitFor(() => {
      const cell = regularTable.querySelector(
        '[role="gridcell"][aria-colindex="2"][aria-rowindex="11"]',
      );
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    fireEvent.mouseDown(lastFullyVisibleCell, { button: 0 });
    fireEvent.keyDown(regularTable, { key: "ArrowDown" });

    await waitFor(() =>
      expect(
        regularTable.querySelector(
          '[role="gridcell"][aria-colindex="2"][aria-rowindex="12"]',
        ),
      ).toHaveClass("viewda-grid-active"),
    );
    expect(regularTable.scrollTop).toBe(3);
  });

  it("keeps the last row inside the viewport at the scroll limit", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      2_832,
    );
    const ref = createRef<RegularTableGridRef>();
    const props = createProps({ rows: 100, freezeColumns: 0 });
    render(<RegularTableGrid ref={ref} {...props} />);

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
      function (this: Element) {
        const isLastMarker = this.matches(
          '[role="rowheader"][aria-rowindex="101"]',
        );
        const verticalOffset = Number.parseFloat(
          regularTable.style.getPropertyValue("--viewda-grid-transform-y"),
        );
        const height = this === regularTable ? 320 : isLastMarker ? 28 : 32;
        const top = isLastMarker ? 299 + (verticalOffset || 0) : 0;
        return {
          x: 0,
          y: top,
          top,
          right: 120,
          bottom: top + height,
          left: 0,
          width: 120,
          height,
          toJSON: () => ({}),
        };
      },
    );

    ref.current?.scrollToRow(99, "end");

    await waitFor(() => {
      const lastMarker = regularTable.querySelector(
        '[role="rowheader"][aria-rowindex="101"]',
      );
      expect(lastMarker).toBeInstanceOf(HTMLTableCellElement);
      expect(lastMarker!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        regularTable.getBoundingClientRect().top + regularTable.clientHeight,
      );
    });
  });

  it("toggles all rows from the unadorned row-number corner", async () => {
    const selectionChanged = vi.fn();
    const props = createProps({
      rows: 100,
      onGridSelectionChange: selectionChanged,
    });
    render(<RegularTableGrid {...props} />);

    const markerHeader = await waitFor(() => {
      const cell = screen
        .getByTestId("regular-table-grid")
        .querySelector('[role="columnheader"][aria-colindex="1"]');
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    fireEvent.mouseDown(markerHeader, { button: 0 });
    expect(selectionChanged).toHaveBeenLastCalledWith({
      columns: expect.any(CompactSelection),
      rows: expect.objectContaining({ length: 100 }),
    });
    expect(markerHeader).toHaveAttribute("aria-label", "Clear row selection");
    expect(markerHeader).toHaveAttribute("aria-selected", "true");

    fireEvent.mouseDown(markerHeader, { button: 0 });
    expect(selectionChanged).toHaveBeenLastCalledWith({
      columns: expect.any(CompactSelection),
      rows: expect.objectContaining({ length: 0 }),
    });
    expect(markerHeader).toHaveAttribute("aria-label", "Select all rows");
    expect(markerHeader).toHaveAttribute("aria-selected", "false");
  });

  it("keeps the dominant axis for the whole wheel gesture", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      2_832,
    );
    const props = createProps({ rows: 100 });
    const firstGrid = render(<RegularTableGrid {...props} />);
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    mockHorizontalScrollRange(regularTable);

    expect(fireEvent.wheel(regularTable, { deltaX: 24, deltaY: 6 })).toBe(true);
    regularTable.scrollLeft = 24;
    regularTable.scrollTop = 6;
    fireEvent.scroll(regularTable);
    expect(regularTable.scrollLeft).toBe(24);
    expect(regularTable.scrollTop).toBe(0);

    expect(fireEvent.wheel(regularTable, { deltaX: 5, deltaY: 18 })).toBe(true);
    regularTable.scrollLeft = 29;
    regularTable.scrollTop = 18;
    fireEvent.scroll(regularTable);
    expect(regularTable.scrollLeft).toBe(29);
    expect(regularTable.scrollTop).toBe(0);

    firstGrid.unmount();
    const verticalProps = createProps({ rows: 100 });
    render(<RegularTableGrid {...verticalProps} />);
    const verticalTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(verticalProps.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    mockHorizontalScrollRange(verticalTable);

    expect(fireEvent.wheel(verticalTable, { deltaX: 5, deltaY: 18 })).toBe(
      true,
    );
    verticalTable.scrollLeft = 5;
    verticalTable.scrollTop = 18;
    fireEvent.scroll(verticalTable);
    expect(verticalTable.scrollLeft).toBe(0);
    expect(verticalTable.scrollTop).toBe(18);
  });

  it("hands a wheel gesture to the other axis at a scroll edge", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      2_832,
    );
    const firstProps = createProps({ rows: 100 });
    const firstGrid = render(<RegularTableGrid {...firstProps} />);
    const verticalTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(firstProps.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    mockHorizontalScrollRange(verticalTable);

    verticalTable.scrollTop = 20;
    fireEvent.wheel(verticalTable, { deltaX: 5, deltaY: -18 });
    verticalTable.scrollLeft = 5;
    verticalTable.scrollTop = 2;
    fireEvent.scroll(verticalTable);
    expect(verticalTable.scrollLeft).toBe(0);

    fireEvent.wheel(verticalTable, { deltaX: 5, deltaY: -18 });
    verticalTable.scrollLeft = 5;
    verticalTable.scrollTop = 0;
    fireEvent.scroll(verticalTable);
    expect(verticalTable.scrollLeft).toBe(0);

    fireEvent.wheel(verticalTable, { deltaX: 5, deltaY: -18 });
    verticalTable.scrollLeft = 5;
    fireEvent.scroll(verticalTable);
    expect(verticalTable.scrollLeft).toBe(5);
    expect(verticalTable.scrollTop).toBe(0);

    firstGrid.unmount();
    const secondProps = createProps({ rows: 100 });
    render(<RegularTableGrid {...secondProps} />);
    const horizontalTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(secondProps.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    mockHorizontalScrollRange(horizontalTable);

    horizontalTable.scrollLeft = 20;
    fireEvent.wheel(horizontalTable, { deltaX: -18, deltaY: 5 });
    horizontalTable.scrollLeft = 2;
    horizontalTable.scrollTop = 5;
    fireEvent.scroll(horizontalTable);
    expect(horizontalTable.scrollTop).toBe(0);

    fireEvent.wheel(horizontalTable, { deltaX: -18, deltaY: 5 });
    horizontalTable.scrollLeft = 0;
    horizontalTable.scrollTop = 5;
    fireEvent.scroll(horizontalTable);
    expect(horizontalTable.scrollTop).toBe(0);

    fireEvent.wheel(horizontalTable, { deltaX: -18, deltaY: 5 });
    horizontalTable.scrollTop = 5;
    fireEvent.scroll(horizontalTable);
    expect(horizontalTable.scrollLeft).toBe(0);
    expect(horizontalTable.scrollTop).toBe(5);
  });

  it("keeps pixel movement continuous across a column boundary", async () => {
    const freezeColumns = 2;
    const targetColumn = 10;
    const variedColumns = Array.from({ length: 20 }, (_, index) => ({
      ...columns[index % columns.length]!,
      title: `column_${index}`,
      width: 80 + (index % 4) * 24,
    }));
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        const sizeClass = Array.from(this.classList).find((name) =>
          /^rt-col-\d+$/.test(name),
        );
        const sizeKey = Number(sizeClass?.slice("rt-col-".length));
        return sizeKey > 0 ? (variedColumns[sizeKey - 1]?.width ?? 120) : 120;
      },
    );
    const props = createProps({
      columns: variedColumns,
      freezeColumns,
    });
    render(<RegularTableGrid {...props} />);
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );

    const boundary = variedColumns
      .slice(freezeColumns, targetColumn)
      .reduce((total, column) => total + column.width, 0);
    const previousWidth = variedColumns[targetColumn - 1]!.width;

    regularTable.scrollLeft = boundary - 4;
    fireEvent.scroll(regularTable);
    await regularTable.flush();
    await waitFor(() =>
      expect(
        regularTable.style.getPropertyValue("--viewda-grid-transform-x"),
      ).toBe(`${-(previousWidth - 4)}px`),
    );

    regularTable.scrollLeft = boundary + 4;
    fireEvent.scroll(regularTable);
    expect(
      regularTable.style.getPropertyValue("--viewda-grid-transform-x"),
    ).toBe(`${-(previousWidth + 4)}px`);

    await regularTable.flush();
    await waitFor(() =>
      expect(
        regularTable.style.getPropertyValue("--viewda-grid-transform-x"),
      ).toBe(`${-(previousWidth + 4)}px`),
    );
    expect(regularTable.style.getPropertyValue("--viewda-grid-clip-x")).toBe(
      `${previousWidth + 4}px`,
    );
  });

  it("does not scroll past the exact right edge of the columns", async () => {
    const props = createProps({ rows: 100, freezeColumns: 0 });
    render(<RegularTableGrid {...props} />);
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );

    Object.defineProperty(regularTable, "scrollWidth", {
      configurable: true,
      value: 778,
    });
    regularTable.scrollLeft = 140;
    fireEvent.scroll(regularTable);

    expect(regularTable.scrollLeft).toBe(
      regularTable.scrollWidth - regularTable.clientWidth,
    );
  });

  it("keeps the final row visible at the native scroll limit", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      2_832,
    );
    const props = createProps({ rows: 100, freezeColumns: 0 });
    render(<RegularTableGrid {...props} />);
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );

    regularTable.scrollTop =
      regularTable.scrollHeight - regularTable.clientHeight;
    fireEvent.scroll(regularTable);
    await regularTable.flush();

    expect(
      regularTable.style.getPropertyValue("--viewda-grid-transform-y"),
    ).toBe(`${GRID_ROW_HEIGHT - GRID_HEADER_HEIGHT}px`);
    const visible = vi
      .mocked(props.onVisibleRegionChanged)
      .mock.calls.at(-1)?.[0];
    expect(visible).toBeDefined();
    expect(visible!.y + visible!.height).toBe(100);
  });

  it("allows single-digit wheel movement across a 35-million-row file", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      10_000_000,
    );
    const rowCount = 35_000_000;
    const props = createProps({ rows: rowCount });
    render(<RegularTableGrid {...props} />);
    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    let integerScrollTop = 0;
    Object.defineProperty(regularTable, "scrollTop", {
      configurable: true,
      get: () => integerScrollTop,
      set: (value: number) => {
        integerScrollTop = Math.trunc(value);
      },
    });

    vi.mocked(props.onVisibleRegionChanged).mockClear();
    for (let event = 0; event < 10; event += 1) {
      expect(fireEvent.wheel(regularTable, { deltaY: 14 })).toBe(false);
    }

    const physicalRange = regularTable.scrollHeight - regularTable.clientHeight;
    const logicalRows = rowCount - 10;
    const movedRows = (regularTable.scrollTop / physicalRange) * logicalRows;
    expect(movedRows).toBeGreaterThan(3);
    expect(movedRows).toBeLessThan(4);

    fireEvent.scroll(regularTable);
    await regularTable.flush();
    const visibleRow = vi
      .mocked(props.onVisibleRegionChanged)
      .mock.calls.at(-1)?.[0].y;
    expect(visibleRow).toBeGreaterThan(0);
    expect(visibleRow).toBeLessThan(5);
  });

  it("does not let regular-table apply Safari trackpad deltas a second time", async () => {
    Object.defineProperty(window, "safari", {
      configurable: true,
      value: {},
    });
    try {
      const props = createProps({ rows: 100 });
      render(<RegularTableGrid {...props} />);
      const regularTable = screen.getByTestId("regular-table-grid");
      await waitFor(() =>
        expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
      );

      fireEvent(
        regularTable,
        new WheelEvent("mousewheel", {
          bubbles: true,
          cancelable: true,
          deltaY: 12,
        }),
      );

      expect(regularTable.scrollTop).toBe(0);
    } finally {
      Reflect.deleteProperty(window, "safari");
    }
  });

  it("continues a drag beyond the viewport and always releases it", async () => {
    const selectionChanged = vi.fn();
    const props = createProps({
      columns: Array.from({ length: 20 }, (_, index) => ({
        ...columns[index % columns.length]!,
      })),
      rows: 100,
      freezeColumns: 0,
      onGridSelectionChange: selectionChanged,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    const firstCell = await waitFor(() => {
      const cell = regularTable.querySelector('[role="gridcell"]');
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    fireEvent.mouseDown(firstCell, { button: 0 });
    fireEvent.mouseMove(document, {
      buttons: 1,
      clientX: 700,
      clientY: 10,
    });

    await waitFor(() => expect(regularTable.scrollLeft).toBeGreaterThan(0));
    fireEvent.mouseUp(document);
    const releasedCallCount = selectionChanged.mock.calls.length;
    await new Promise((resolve) => window.setTimeout(resolve, 30));
    expect(selectionChanged).toHaveBeenCalledTimes(releasedCallCount);
  });

  it("preserves existing ranges during additive row and cell selection", async () => {
    const selectionChanged = vi.fn();
    const props = createProps({
      rows: 100,
      gridSelection: {
        columns: CompactSelection.empty(),
        rows: CompactSelection.fromSingleSelection(4),
      },
      onGridSelectionChange: selectionChanged,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    const firstMarker = await waitFor(() => {
      const cell = regularTable.querySelector(
        '[role="rowheader"][aria-rowindex="2"]',
      );
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    const secondMarker = regularTable.querySelector(
      '[role="rowheader"][aria-rowindex="3"]',
    );
    expect(secondMarker).toBeInstanceOf(HTMLTableCellElement);

    fireEvent.mouseDown(firstMarker, { button: 0, ctrlKey: true });
    fireEvent.mouseMove(secondMarker!, { buttons: 1, ctrlKey: true });
    const rowSelection = selectionChanged.mock.calls.at(-1)?.[0];
    expect(rowSelection?.rows.hasIndex(0)).toBe(true);
    expect(rowSelection?.rows.hasIndex(1)).toBe(true);
    expect(rowSelection?.rows.hasIndex(4)).toBe(true);

    const firstCell = regularTable.querySelector(
      '[role="gridcell"][aria-colindex="4"][aria-rowindex="2"]',
    );
    const secondCell = regularTable.querySelector(
      '[role="gridcell"][aria-colindex="5"][aria-rowindex="3"]',
    );
    expect(firstCell).toBeInstanceOf(HTMLTableCellElement);
    expect(secondCell).toBeInstanceOf(HTMLTableCellElement);
    fireEvent.mouseDown(firstCell!, { button: 0 });
    fireEvent.mouseDown(secondCell!, { button: 0, metaKey: true });
    const cellSelection = selectionChanged.mock.calls.at(-1)?.[0];
    expect(cellSelection?.current?.range).toEqual({
      x: 3,
      y: 1,
      width: 1,
      height: 1,
    });
    expect(cellSelection?.current?.rangeStack).toEqual([
      { x: 2, y: 0, width: 1, height: 1 },
    ]);

    fireEvent.mouseDown(firstCell!, { button: 0, shiftKey: true });
    const extendedSelection = selectionChanged.mock.calls.at(-1)?.[0];
    expect(extendedSelection?.current?.cell).toEqual([3, 1]);
    expect(extendedSelection?.current?.range).toEqual({
      x: 2,
      y: 0,
      width: 2,
      height: 2,
    });
  });

  it("clears selection from empty table space", async () => {
    const selectionChanged = vi.fn();
    const props = createProps({
      rows: 1,
      columns: columns.slice(0, 1),
      gridSelection: {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [0, 0],
          range: { x: 0, y: 0, width: 1, height: 1 },
          rangeStack: [],
        },
      },
      onGridSelectionChange: selectionChanged,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    await waitFor(() =>
      expect(regularTable).toHaveAttribute("aria-activedescendant"),
    );
    fireEvent.mouseDown(regularTable, {
      button: 0,
      clientX: 100,
      clientY: 100,
    });

    expect(selectionChanged).toHaveBeenLastCalledWith({
      columns: expect.any(CompactSelection),
      rows: expect.any(CompactSelection),
    });
    await waitFor(() =>
      expect(regularTable).not.toHaveAttribute("aria-activedescendant"),
    );
  });

  it("forwards sort, context-menu, resize and auto-fit gestures", async () => {
    const onHeaderClicked = vi.fn();
    const onCellContextMenu = vi.fn();
    const onColumnResize = vi.fn();
    const onColumnResizeStart = vi.fn();
    const onColumnResizeEnd = vi.fn();
    const onColumnAutoFit = vi.fn().mockResolvedValue(undefined);
    const props = createProps({
      rows: 10,
      onHeaderClicked,
      onCellContextMenu,
      onColumnResize,
      onColumnResizeStart,
      onColumnResizeEnd,
      onColumnAutoFit,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId(
      "regular-table-grid",
    ) as RegularTableElement;
    const header = await waitFor(() => {
      const cell = regularTable.querySelector(
        '[role="columnheader"][aria-colindex="4"]',
      );
      expect(cell).toBeInstanceOf(HTMLTableCellElement);
      return cell as HTMLTableCellElement;
    });
    fireEvent.mouseDown(header, { button: 0, clientX: 12 });
    fireEvent.click(header, { button: 0, clientX: 12 });
    expect(onHeaderClicked).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ localEventX: 12 }),
    );

    const bodyCell = regularTable.querySelector(
      '[role="gridcell"][aria-colindex="5"][aria-rowindex="2"]',
    );
    expect(bodyCell).toBeInstanceOf(HTMLTableCellElement);
    fireEvent.contextMenu(bodyCell!, { clientX: 20, clientY: 14 });
    expect(onCellContextMenu).toHaveBeenCalledWith(
      [3, 0],
      expect.objectContaining({ localEventX: 20, localEventY: 14 }),
    );
    expect(props.onGridSelectionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ cell: [3, 0] }),
      }),
    );

    const resizeHandle = header.querySelector(".rt-column-resize");
    expect(resizeHandle).toBeInstanceOf(HTMLSpanElement);
    fireEvent.mouseDown(resizeHandle!, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 140 });
    fireEvent.mouseUp(document);
    expect(onColumnResizeStart).toHaveBeenCalledWith(2);
    expect(onColumnResize).toHaveBeenCalledWith(160, 2);
    expect(onColumnResizeEnd).toHaveBeenCalledWith(160, 2);
    expect(regularTable.saveColumnSizes()[3]).toBe(120);

    fireEvent.mouseDown(resizeHandle!, { button: 0, clientX: 100 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(resizeHandle!, { button: 0, clientX: 100 });
    await waitFor(() =>
      expect(onColumnAutoFit).toHaveBeenCalledWith(
        2,
        0,
        10,
        expect.any(AbortSignal),
      ),
    );
  });

  it("does not cancel an active copy when auto-fitting a column", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    let copySignal: AbortSignal | undefined;
    let releaseCopy: ((rows: GridCell[][]) => void) | undefined;
    const copyRows = new Promise<GridCell[][]>((resolve) => {
      releaseCopy = resolve;
    });
    const getCellsForSelection = vi.fn(
      async (_rectangle: { width: number }, signal: AbortSignal) => {
        copySignal = signal;
        return copyRows;
      },
    );
    const onColumnAutoFit = vi.fn().mockResolvedValue(undefined);
    const props = createProps({
      rows: 10,
      gridSelection: {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [1, 0],
          range: { x: 1, y: 0, width: 2, height: 1 },
          rangeStack: [],
        },
      },
      getCellsForSelection,
      onColumnAutoFit,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    const resizeHandle = await waitFor(() => {
      const handle = regularTable.querySelector(
        '[role="columnheader"][aria-colindex="4"] .rt-column-resize',
      );
      expect(handle).toBeInstanceOf(HTMLSpanElement);
      return handle as HTMLSpanElement;
    });
    regularTable.focus();
    fireEvent.copy(regularTable);
    await waitFor(() => expect(copySignal).toBeDefined());

    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 100 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(resizeHandle, { button: 0, clientX: 100 });
    await waitFor(() => expect(onColumnAutoFit).toHaveBeenCalledOnce());
    expect(getCellsForSelection).toHaveBeenCalledOnce();
    expect(copySignal?.aborted).toBe(false);

    releaseCopy?.([[textCell(1, 0), textCell(2, 0)]]);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });

  it("copies raw values asynchronously from an unloaded selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const props = createProps({
      rows: 20,
      gridSelection: {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [1, 5],
          range: { x: 1, y: 5, width: 2, height: 2 },
          rangeStack: [],
        },
      },
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    await waitFor(() =>
      expect(regularTable.querySelector("table")).not.toBeNull(),
    );
    regularTable.focus();
    fireEvent.copy(regularTable);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("1:5\t2:5\n1:6\t2:6"),
    );
  });

  it("starts a rich clipboard write before async selection loading finishes", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { write, writeText },
    });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);
    let releaseRows: ((rows: GridCell[][]) => void) | undefined;
    const rows = new Promise<GridCell[][]>((resolve) => {
      releaseRows = resolve;
    });
    const props = createProps({
      rows: 20,
      gridSelection: {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [1, 5],
          range: { x: 1, y: 5, width: 1, height: 1 },
          rangeStack: [],
        },
      },
      getCellsForSelection: () => rows,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    await waitFor(() =>
      expect(regularTable.querySelector("table")).not.toBeNull(),
    );
    regularTable.focus();
    fireEvent.copy(regularTable);

    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0] as TestClipboardItem;
    expect(Object.keys(item.data).sort()).toEqual(["text/html", "text/plain"]);

    releaseRows?.([[textCell(1, 5)]]);
    await expect(readBlobText(await item.data["text/plain"]!)).resolves.toBe(
      "1:5",
    );
    await expect(readBlobText(await item.data["text/html"]!)).resolves.toBe(
      "<table><tbody><tr><td>1:5</td></tr></tbody></table>",
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("auto-fits only the rendered row sample", async () => {
    const onColumnAutoFit = vi.fn().mockResolvedValue(undefined);
    const props = createProps({
      rows: 1_000_000,
      onColumnAutoFit,
    });
    render(<RegularTableGrid {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    const resizeHandle = await waitFor(() => {
      const handle = regularTable.querySelector(
        '[role="columnheader"][aria-colindex="4"] .rt-column-resize',
      );
      expect(handle).toBeInstanceOf(HTMLSpanElement);
      return handle as HTMLSpanElement;
    });
    fireEvent.mouseDown(resizeHandle, { button: 0 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(resizeHandle, { button: 0 });

    await waitFor(() => expect(onColumnAutoFit).toHaveBeenCalled());
    const [, rowStart, rowCount] = onColumnAutoFit.mock.calls.at(-1) ?? [];
    expect(rowStart).toBe(0);
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(100);
  });

  it("maps deep jumps proportionally across the bounded browser scroll range", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
      10_000_000,
    );
    const ref = createRef<RegularTableGridRef>();
    const props = createProps();
    render(<RegularTableGrid ref={ref} {...props} />);

    const regularTable = screen.getByTestId("regular-table-grid");
    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    ref.current?.scrollToRow(1_000_000_000);

    await waitFor(() =>
      expect(regularTable.scrollTop).toBeGreaterThan(4_900_000),
    );
    expect(regularTable.scrollTop).toBeLessThan(5_100_000);
  });

  it("keeps a 10,000-column table on a small visible projection", async () => {
    const wideColumns = Array.from({ length: 10_000 }, (_, index) => ({
      ...columns[index % columns.length]!,
      title: `wide_${index}`,
    }));
    const props = createProps({
      columns: wideColumns,
      rows: 100,
      freezeColumns: 1,
    });
    const { container } = render(<RegularTableGrid {...props} />);

    await waitFor(() =>
      expect(props.onVisibleRegionChanged).toHaveBeenCalled(),
    );
    const lastRange = vi
      .mocked(props.onVisibleRegionChanged)
      .mock.calls.at(-1)?.[0];
    expect(lastRange?.width).toBeLessThan(20);
    expect(container.querySelectorAll("tbody td").length).toBeLessThan(300);
  });
});

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });
}
