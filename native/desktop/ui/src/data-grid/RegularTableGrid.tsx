import "regular-table";
import type { RegularTableElement } from "regular-table";
import {
  forwardRef,
  createElement,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type DetailedHTMLProps,
  type CSSProperties,
  type HTMLAttributes,
  type Ref,
} from "react";

import { writeClipboardContents } from "./clipboard";
import {
  CompactSelection,
  GridCellKind,
  getCopyBufferContents,
  type CellArray,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Rectangle,
} from "./grid-model";
import {
  GRID_CELL_BORDER_WIDTH,
  GRID_CELL_HORIZONTAL_PADDING,
  GRID_ESTIMATED_CHARACTER_WIDTH,
  GRID_FONT_SIZE,
  GRID_HEADER_CONTROL_GAP,
  GRID_HEADER_FONT_WEIGHT,
  GRID_HEADER_HEIGHT,
  GRID_HEADER_MENU_RIGHT,
  GRID_HEADER_MENU_WIDTH,
  GRID_HEADER_SIDE_RESERVED_SPACE,
  GRID_MIN_ROW_MARKER_WIDTH,
  GRID_ROW_HEIGHT,
  GRID_ROW_MARKER_HORIZONTAL_PADDING,
  GRID_SORT_ICON_LEFT,
  GRID_SORT_ICON_WIDTH,
} from "./grid-layout";

const DRAG_SCROLL_STEP_PX = 18;
const RESIZE_DOUBLE_CLICK_WINDOW_MS = 500;
const WHEEL_GESTURE_IDLE_MS = 200;
const WHEEL_AXIS_LOCK_THRESHOLD_PX = 3;
const ARIA_DATA_INDEX_OFFSET = 2;
const PAGE_NAVIGATION_OVERLAP_ROWS = 4;

const GRID_LAYOUT_STYLE = {
  "--viewda-grid-row-height": `${GRID_ROW_HEIGHT}px`,
  "--viewda-grid-header-height": `${GRID_HEADER_HEIGHT}px`,
  "--viewda-grid-font-size": `${GRID_FONT_SIZE}px`,
  "--viewda-grid-header-font-weight": String(GRID_HEADER_FONT_WEIGHT),
  "--viewda-grid-cell-horizontal-padding": `${GRID_CELL_HORIZONTAL_PADDING}px`,
  "--viewda-grid-cell-border-width": `${GRID_CELL_BORDER_WIDTH}px`,
  "--viewda-grid-row-marker-horizontal-padding": `${GRID_ROW_MARKER_HORIZONTAL_PADDING}px`,
  "--viewda-grid-header-side-reserve": `${GRID_HEADER_SIDE_RESERVED_SPACE}px`,
  "--viewda-grid-sort-icon-left": `${GRID_SORT_ICON_LEFT}px`,
  "--viewda-grid-sort-icon-width": `${GRID_SORT_ICON_WIDTH}px`,
  "--viewda-grid-header-control-gap": `${GRID_HEADER_CONTROL_GAP}px`,
  "--viewda-grid-header-menu-right": `${GRID_HEADER_MENU_RIGHT}px`,
  "--viewda-grid-header-menu-width": `${GRID_HEADER_MENU_WIDTH}px`,
} as CSSProperties;

type SelectionGrowth = "start" | -1 | 0 | 1 | "end";

interface RegularTableResponse {
  data: (string | number | boolean | null)[][];
  num_columns: number;
  num_rows: number;
  row_height: number;
  row_headers: (string | number | boolean | null)[][];
  column_headers: (string | number | boolean | null)[][];
  num_row_headers: number;
  num_column_headers: number;
  merge_headers: "both" | "row" | "column";
}

export interface HeaderPointerEvent {
  localEventX: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface CellContextMenuEvent {
  bounds: Rectangle;
  localEventX: number;
  localEventY: number;
  preventDefault(): void;
}

export interface VisibleRegionExtras {
  freezeRegions?: readonly Rectangle[];
}

export interface RegularTableGridProps {
  columns: readonly GridColumn[];
  rows: number;
  freezeColumns: number;
  minColumnWidth: number;
  maxColumnWidth: number;
  gridSelection: GridSelection;
  getCellContent(cell: readonly [number, number]): GridCell;
  getCellsForSelection(
    rectangle: Rectangle,
    abortSignal: AbortSignal,
  ): Promise<CellArray>;
  onGridSelectionChange(selection: GridSelection): void;
  onCellContextMenu(
    cell: readonly [number, number],
    event: CellContextMenuEvent,
  ): void;
  onHeaderClicked(column: number, event: HeaderPointerEvent): void;
  onVisibleRegionChanged(range: Rectangle, extras: VisibleRegionExtras): void;
  onColumnResize(width: number, index: number): void;
  onColumnResizeStart(index: number): void;
  onColumnResizeEnd(width: number, index: number): void;
  onColumnAutoFit(
    index: number,
    rowStart: number,
    rowCount: number,
    abortSignal: AbortSignal,
  ): Promise<void>;
  onHeaderMenuClick(column: number, bounds: Rectangle): void;
}

export interface RegularTableGridRef {
  scrollToColumn(column: number, padding?: number): void;
  scrollToRow(row: number, alignment?: "start" | "center" | "end"): void;
  refresh(): void;
}

interface ResizeGesture {
  column: number;
  startX: number;
  startWidth: number;
  currentWidth: number;
}

interface ScrollAlignment {
  horizontal: "start" | "end";
  vertical: "start" | "center" | "end";
}

interface VerticalOffsetState {
  scrollTop: number;
}

interface HorizontalOffsetState {
  boundary: number;
  offset: number;
}

interface VerticalWheelState {
  remainder: number;
  scrollTop: number;
}

interface WheelGestureState {
  active: boolean;
  axis: "horizontal" | "vertical" | null;
  deltaX: number;
  deltaY: number;
  scrollLeft: number;
  scrollTop: number;
  idleTimer: number | null;
}

type DragSelection =
  | {
      kind: "cell";
      anchor: readonly [number, number];
      stack: Rectangle[];
    }
  | {
      kind: "row" | "column";
      anchor: readonly [number, number];
      base: CompactSelection;
    };

export const RegularTableGrid = forwardRef(function RegularTableGrid(
  props: RegularTableGridProps,
  forwardedRef: Ref<RegularTableGridRef>,
) {
  const tableRef = useRef<RegularTableElement | null>(null);
  const propsRef = useRef(props);
  const selectionRef = useRef(props.gridSelection);
  const rowAnchorRef = useRef<number | null>(null);
  const columnAnchorRef = useRef<number | null>(null);
  const focusCellRef = useRef<readonly [number, number] | null>(null);
  const visibleRangeRef = useRef<Rectangle>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const verticalOffsetRef = useRef<VerticalOffsetState>({
    scrollTop: 0,
  });
  const horizontalOffsetRef = useRef<HorizontalOffsetState>({
    boundary: 0,
    offset: Number.NaN,
  });
  const verticalWheelRef = useRef<VerticalWheelState>({
    remainder: 0,
    scrollTop: 0,
  });
  const dragRef = useRef<DragSelection | null>(null);
  const resizeRef = useRef<ResizeGesture | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const lastResizeClickRef = useRef<{ column: number; time: number } | null>(
    null,
  );
  const copyAbortRef = useRef<AbortController | null>(null);
  const fitAbortRef = useRef<AbortController | null>(null);
  const configuredRef = useRef(false);
  const instanceId = useId().replaceAll(":", "");

  propsRef.current = props;
  selectionRef.current = props.gridSelection;
  focusCellRef.current = props.gridSelection.current?.cell ?? null;

  const emitSelection = (selection: GridSelection) => {
    selectionRef.current = selection;
    focusCellRef.current = selection.current?.cell ?? null;
    propsRef.current.onGridSelectionChange(selection);
    const table = tableRef.current;
    if (table !== null) {
      styleRenderedTable(
        table,
        propsRef.current,
        selection,
        focusCellRef.current,
        instanceId,
      );
    }
  };

  useImperativeHandle(
    forwardedRef,
    () => ({
      scrollToColumn(column, padding = 0) {
        void scrollToCell(
          tableRef.current,
          propsRef.current,
          verticalOffsetRef.current,
          column,
          0,
          "horizontal",
          padding,
          {
            horizontal: "start",
            vertical: "start",
          },
        );
      },
      scrollToRow(row, alignment = "start") {
        void scrollToCell(
          tableRef.current,
          propsRef.current,
          verticalOffsetRef.current,
          0,
          row,
          "vertical",
          0,
          { horizontal: "start", vertical: alignment },
        );
      },
      refresh() {
        const table = tableRef.current;
        if (table !== null) {
          void refreshTable(table, propsRef.current);
        }
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (table === null) {
      return;
    }
    restoreColumnWidths(table, props);
    if (configuredRef.current) {
      void refreshTable(table, props);
    }
  }, [props.columns, props.freezeColumns, props.rows]);

  useEffect(() => {
    const table = tableRef.current;
    if (table === null) {
      return;
    }
    const wheelGesture: WheelGestureState = {
      active: false,
      axis: null,
      deltaX: 0,
      deltaY: 0,
      scrollLeft: 0,
      scrollTop: 0,
      idleTimer: null,
    };

    const dataListener = async (
      x0: number,
      y0: number,
      x1: number,
      y1: number,
    ): Promise<RegularTableResponse> => {
      const current = propsRef.current;
      const frozen = frozenColumnCount(current);
      const rowStart = clamp(Math.floor(y0), 0, current.rows);
      const rowEnd = clamp(Math.ceil(y1), rowStart, current.rows);
      const bodyColumnCount = current.columns.length - frozen;
      const bodyStart = clamp(Math.floor(x0), 0, bodyColumnCount);
      const bodyEnd = clamp(Math.ceil(x1), bodyStart, bodyColumnCount);
      const range = {
        x: frozen + bodyStart,
        y: rowStart,
        width: bodyEnd - bodyStart,
        height: rowEnd - rowStart,
      };
      const freezeRegions =
        frozen === 0
          ? []
          : [{ x: 0, y: rowStart, width: frozen, height: rowEnd - rowStart }];
      visibleRangeRef.current = {
        ...range,
        height: Math.min(range.height, fullyVisibleRowCount(table)),
      };
      current.onVisibleRegionChanged(range, { freezeRegions });

      return {
        num_rows: current.rows,
        num_columns: bodyColumnCount,
        num_row_headers: frozen + 1,
        num_column_headers: 1,
        row_height: GRID_ROW_HEIGHT,
        merge_headers: "column",
        row_headers: rangeOf(rowStart, rowEnd).map((row) => [
          row + 1,
          ...rangeOf(0, frozen).map((column) =>
            displayCell(current.getCellContent([column, row])),
          ),
        ]),
        column_headers: rangeOf(bodyStart, bodyEnd).map((bodyColumn) => [
          current.columns[frozen + bodyColumn]?.title ?? "",
        ]),
        data: rangeOf(bodyStart, bodyEnd).map((bodyColumn) =>
          rangeOf(rowStart, rowEnd).map((row) =>
            displayCell(current.getCellContent([frozen + bodyColumn, row])),
          ),
        ),
      };
    };

    const style = () => {
      styleRenderedTable(
        table,
        propsRef.current,
        selectionRef.current,
        focusCellRef.current,
        instanceId,
      );
      syncHorizontalRender(
        table,
        propsRef.current,
        horizontalOffsetRef.current,
      );
    };
    const unsubscribeStyle = table.addStyleListener(style);

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.closest(".viewda-grid-header-menu") !== null) {
        return;
      }
      const cell = target.closest("td, th");
      if (!(cell instanceof HTMLTableCellElement) || !table.contains(cell)) {
        const bounds = table.getBoundingClientRect();
        if (
          event.clientX >= bounds.left &&
          event.clientX < bounds.left + table.clientWidth &&
          event.clientY >= bounds.top &&
          event.clientY < bounds.top + table.clientHeight
        ) {
          table.focus({ preventScroll: true });
          rowAnchorRef.current = null;
          columnAnchorRef.current = null;
          emitSelection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
          });
          event.preventDefault();
        }
        return;
      }
      const coordinate = renderedCoordinate(table, cell, propsRef.current);
      if (coordinate === null) {
        return;
      }
      table.focus({ preventScroll: true });
      if (coordinate.kind === "marker-header") {
        const current = propsRef.current;
        const allRowsSelected =
          current.rows > 0 && selectionRef.current.rows.length === current.rows;
        rowAnchorRef.current = null;
        emitSelection({
          columns: CompactSelection.empty(),
          rows: allRowsSelected
            ? CompactSelection.empty()
            : CompactSelection.fromSingleSelection([0, current.rows]),
        });
        event.preventDefault();
        return;
      }
      if (coordinate.kind === "header") {
        const previous = selectionRef.current.columns;
        if (!target.classList.contains("rt-column-resize")) {
          selectColumn(coordinate.column, event);
          dragRef.current = {
            kind: "column",
            anchor: [columnAnchorRef.current ?? coordinate.column, 0],
            base:
              event.ctrlKey || event.metaKey
                ? previous
                : CompactSelection.empty(),
          };
          event.preventDefault();
        }
        return;
      }
      if (coordinate.kind === "marker") {
        const previous = selectionRef.current.rows;
        selectRow(coordinate.row, event);
        dragRef.current = {
          kind: "row",
          anchor: [0, rowAnchorRef.current ?? coordinate.row],
          base:
            event.ctrlKey || event.metaKey
              ? previous
              : CompactSelection.empty(),
        };
        event.preventDefault();
        return;
      }
      selectCell([coordinate.column, coordinate.row], event);
      const current = selectionRef.current.current;
      dragRef.current = {
        kind: "cell",
        anchor: current?.cell ?? [coordinate.column, coordinate.row],
        stack: current?.rangeStack ?? [],
      };
      event.preventDefault();
    };

    let dragFrame: number | null = null;
    let dragDirection: readonly [number, number] = [0, 0];

    const updateDragSelection = (
      drag: DragSelection,
      coordinate: RenderedCoordinate,
    ) => {
      if (drag.kind === "cell" && coordinate.kind === "cell") {
        emitSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: {
            cell: drag.anchor,
            range: rectangleBetween(drag.anchor, [
              coordinate.column,
              coordinate.row,
            ]),
            rangeStack: drag.stack,
          },
        });
      } else if (drag.kind === "row" && coordinate.kind === "marker") {
        const start = Math.min(drag.anchor[1], coordinate.row);
        const end = Math.max(drag.anchor[1], coordinate.row) + 1;
        emitSelection({
          columns: CompactSelection.empty(),
          rows: drag.base.add([start, end]),
        });
      } else if (drag.kind === "column" && coordinate.kind === "header") {
        const start = Math.min(drag.anchor[0], coordinate.column);
        const end = Math.max(drag.anchor[0], coordinate.column) + 1;
        emitSelection({
          columns: drag.base.add([start, end]),
          rows: CompactSelection.empty(),
        });
      }
    };

    const stopDragScroll = () => {
      dragDirection = [0, 0];
      if (dragFrame !== null) {
        window.cancelAnimationFrame(dragFrame);
        dragFrame = null;
      }
    };

    const runDragScroll = () => {
      const drag = dragRef.current;
      const [horizontal, vertical] = dragDirection;
      if (drag === null || (horizontal === 0 && vertical === 0)) {
        dragFrame = null;
        return;
      }
      if (drag.kind !== "row") {
        table.scrollLeft += horizontal * DRAG_SCROLL_STEP_PX;
      }
      if (drag.kind !== "column") {
        table.scrollTop += vertical * DRAG_SCROLL_STEP_PX;
      }
      const visible = visibleRangeRef.current;
      if (visible.width > 0 && visible.height > 0) {
        const column = clamp(
          horizontal < 0
            ? visible.x
            : horizontal > 0
              ? visible.x + visible.width - 1
              : (focusCellRef.current?.[0] ?? visible.x),
          0,
          propsRef.current.columns.length - 1,
        );
        const row = clamp(
          vertical < 0
            ? visible.y
            : vertical > 0
              ? visible.y + visible.height - 1
              : (focusCellRef.current?.[1] ?? visible.y),
          0,
          propsRef.current.rows - 1,
        );
        updateDragSelection(
          drag,
          drag.kind === "row"
            ? { kind: "marker", row }
            : drag.kind === "column"
              ? { kind: "header", column }
              : { kind: "cell", column, row },
        );
      }
      dragFrame = window.requestAnimationFrame(runDragScroll);
    };

    const updateDragScroll = (event: MouseEvent, drag: DragSelection) => {
      const bounds = table.getBoundingClientRect();
      const nextDirection: readonly [number, number] = [
        drag.kind === "row"
          ? 0
          : event.clientX < bounds.left
            ? -1
            : event.clientX >= bounds.right
              ? 1
              : 0,
        drag.kind === "column"
          ? 0
          : event.clientY < bounds.top
            ? -1
            : event.clientY >= bounds.bottom
              ? 1
              : 0,
      ];
      dragDirection = nextDirection;
      if (
        (nextDirection[0] !== 0 || nextDirection[1] !== 0) &&
        dragFrame === null
      ) {
        dragFrame = window.requestAnimationFrame(runDragScroll);
      } else if (nextDirection[0] === 0 && nextDirection[1] === 0) {
        stopDragScroll();
      }
    };

    const onMouseMove = (event: MouseEvent) => {
      const drag = dragRef.current;
      const target = event.target;
      if (drag === null) {
        return;
      }
      if (event.buttons === 0) {
        dragRef.current = null;
        stopDragScroll();
        return;
      }
      updateDragScroll(event, drag);
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const cell = target.closest("td, th");
      if (!(cell instanceof HTMLTableCellElement) || !table.contains(cell)) {
        return;
      }
      const coordinate = renderedCoordinate(table, cell, propsRef.current);
      if (coordinate === null) {
        return;
      }
      updateDragSelection(drag, coordinate);
    };

    const onMouseUp = () => {
      dragRef.current = null;
      stopDragScroll();
    };

    const selectColumn = (column: number, event: MouseEvent) => {
      const current = selectionRef.current;
      const additive = event.ctrlKey || event.metaKey;
      let columns: CompactSelection;
      if (
        event.shiftKey &&
        columnAnchorRef.current !== null &&
        current.columns.hasIndex(columnAnchorRef.current)
      ) {
        const range = selectionRange(columnAnchorRef.current, column);
        columns = additive ? current.columns.union(range) : range;
      } else if (additive) {
        columns = current.columns.hasIndex(column)
          ? current.columns.remove(column)
          : current.columns.add(column);
        columnAnchorRef.current = column;
      } else {
        columns = CompactSelection.fromSingleSelection(column);
        columnAnchorRef.current = column;
      }
      emitSelection({ columns, rows: CompactSelection.empty() });
    };

    const selectRow = (row: number, event: MouseEvent) => {
      const current = selectionRef.current;
      const additive = event.ctrlKey || event.metaKey;
      let rows: CompactSelection;
      if (
        event.shiftKey &&
        rowAnchorRef.current !== null &&
        current.rows.hasIndex(rowAnchorRef.current)
      ) {
        const range = selectionRange(rowAnchorRef.current, row);
        rows = additive ? current.rows.union(range) : range;
      } else if (additive) {
        rows = current.rows.hasIndex(row)
          ? current.rows.remove(row)
          : current.rows.add(row);
        rowAnchorRef.current = row;
      } else if (current.rows.length === 1 && current.rows.hasIndex(row)) {
        rows = CompactSelection.empty();
        rowAnchorRef.current = null;
      } else {
        rows = CompactSelection.fromSingleSelection(row);
        rowAnchorRef.current = row;
      }
      emitSelection({ columns: CompactSelection.empty(), rows });
    };

    const selectCell = (
      coordinate: readonly [number, number],
      event: MouseEvent,
    ) => {
      const current = selectionRef.current;
      if (
        current.current?.cell[0] === coordinate[0] &&
        current.current.cell[1] === coordinate[1]
      ) {
        focusCellRef.current = coordinate;
        return;
      }
      const additive = event.ctrlKey || event.metaKey;
      const anchor =
        event.shiftKey && current.current !== undefined
          ? current.current.cell
          : coordinate;
      const stack = additive
        ? [
            ...(current.current === undefined
              ? []
              : [current.current.range, ...current.current.rangeStack]),
          ]
        : (current.current?.rangeStack ?? []);
      emitSelection({
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: anchor,
          range: rectangleBetween(anchor, coordinate),
          rangeStack: event.shiftKey ? stack : additive ? stack : [],
        },
      });
    };

    const onContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const cell = target.closest("tbody td, tbody th");
      if (!(cell instanceof HTMLTableCellElement)) {
        return;
      }
      const coordinate = renderedCoordinate(table, cell, propsRef.current);
      if (coordinate?.kind !== "cell") {
        return;
      }
      const bounds = rectangleFromDom(cell.getBoundingClientRect());
      propsRef.current.onCellContextMenu([coordinate.column, coordinate.row], {
        bounds,
        localEventX: event.clientX - bounds.x,
        localEventY: event.clientY - bounds.y,
        preventDefault: () => event.preventDefault(),
      });
      if (
        !selectionContains(
          selectionRef.current,
          coordinate.column,
          coordinate.row,
        )
      ) {
        emitSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
          current: {
            cell: [coordinate.column, coordinate.row],
            range: {
              x: coordinate.column,
              y: coordinate.row,
              width: 1,
              height: 1,
            },
            rangeStack: [],
          },
        });
      }
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const menu = target.closest(".viewda-grid-header-menu");
      const header = target.closest("th");
      if (!(header instanceof HTMLTableCellElement)) {
        return;
      }
      const coordinate = renderedCoordinate(table, header, propsRef.current);
      if (coordinate?.kind !== "header") {
        return;
      }
      const bounds = rectangleFromDom(header.getBoundingClientRect());
      if (!(menu instanceof HTMLButtonElement)) {
        if (target.classList.contains("rt-column-resize")) {
          return;
        }
        propsRef.current.onHeaderClicked(coordinate.column, {
          localEventX: event.clientX - bounds.x,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
        });
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      propsRef.current.onHeaderMenuClick(coordinate.column, bounds);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        emitSelection({
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        });
        event.preventDefault();
        return;
      }
      const primary = event.ctrlKey || event.metaKey;
      if (
        event.key.toLowerCase() === "a" &&
        primary &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const current = propsRef.current;
        if (current.rows > 0 && current.columns.length > 0) {
          emitSelection({
            columns: CompactSelection.empty(),
            rows: CompactSelection.empty(),
            current: {
              cell: selectionRef.current.current?.cell ?? [0, 0],
              range: {
                x: 0,
                y: 0,
                width: current.columns.length,
                height: current.rows,
              },
              rangeStack: [],
            },
          });
        }
        event.preventDefault();
        return;
      }
      const selected = selectionRef.current.current;
      if (selected === undefined) {
        return;
      }
      if (
        event.key === " " &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        const row = selected.cell[1];
        const selectedRows = selectionRef.current.rows;
        rowAnchorRef.current = row;
        emitSelection({
          columns: CompactSelection.empty(),
          rows: selectedRows.hasIndex(row)
            ? selectedRows.remove(row)
            : selectedRows.add(row),
        });
        event.preventDefault();
        return;
      }
      if (
        event.key === " " &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        const column = selected.cell[0];
        const selectedColumns = selectionRef.current.columns;
        columnAnchorRef.current = column;
        emitSelection({
          columns: selectedColumns.hasIndex(column)
            ? selectedColumns.remove(column)
            : selectedColumns.add(column),
          rows: CompactSelection.empty(),
        });
        event.preventDefault();
        return;
      }
      if (
        event.key === "Enter" &&
        primary &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const scroll = keyboardScrollRequest(
          table,
          propsRef.current,
          visibleRangeRef.current,
          selected.cell[0],
          selected.cell[1],
        );
        if (scroll !== null) {
          void scrollToCell(
            table,
            propsRef.current,
            verticalOffsetRef.current,
            selected.cell[0],
            selected.cell[1],
            scroll.direction,
            0,
            scroll.alignment,
          );
        }
        event.preventDefault();
        return;
      }
      if (!primary && !event.altKey && !event.shiftKey && event.key === " ") {
        event.preventDefault();
        return;
      }
      const navigation = keyboardNavigation(
        event,
        selected,
        propsRef.current,
        visibleRangeRef.current,
      );
      if (navigation === null) {
        return;
      }
      emitSelection(navigation.selection);
      const scroll = keyboardScrollRequest(
        table,
        propsRef.current,
        visibleRangeRef.current,
        navigation.scrollTarget[0],
        navigation.scrollTarget[1],
      );
      if (scroll !== null) {
        void scrollToCell(
          table,
          propsRef.current,
          verticalOffsetRef.current,
          navigation.scrollTarget[0],
          navigation.scrollTarget[1],
          scroll.direction,
          0,
          scroll.alignment,
        );
      }
      event.preventDefault();
    };

    const onCopy = (event: ClipboardEvent) => {
      if (
        !table.contains(document.activeElement) &&
        document.activeElement !== table
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      copyAbortRef.current?.abort();
      const controller = new AbortController();
      copyAbortRef.current = controller;
      void writeClipboardContents(
        copySelectionContents(
          propsRef.current,
          selectionRef.current,
          controller.signal,
        ),
      ).catch(() => {});
    };

    const onScroll = () => {
      if (wheelGesture.axis === "horizontal") {
        table.scrollTop = wheelGesture.scrollTop;
      } else if (wheelGesture.axis === "vertical") {
        table.scrollLeft = wheelGesture.scrollLeft;
      }
      clampHorizontalScroll(table);
      syncHorizontalOffset(table, horizontalOffsetRef.current);
      if (table.scrollTop !== verticalOffsetRef.current.scrollTop) {
        setVerticalOffset(
          table,
          verticalOffsetRef.current,
          verticalScrollCorrection(table),
        );
      }
    };

    const onWheel = (event: WheelEvent) => {
      const [deltaX, deltaY] = wheelPixelDelta(event, table);
      const horizontal = Math.abs(deltaX);
      const vertical = Math.abs(deltaY);
      if (horizontal === 0 && vertical === 0) {
        return;
      }

      updateWheelGesture(wheelGesture, table, deltaX, deltaY);
      if (wheelGesture.axis === "horizontal") {
        return;
      }

      const verticalScale = verticalWheelScale(table, propsRef.current.rows);
      if (
        vertical > 0 &&
        verticalScale < 1 &&
        (wheelGesture.axis === "vertical" || vertical >= horizontal)
      ) {
        event.preventDefault();
        scrollCompressedVerticalWheel(
          table,
          verticalWheelRef.current,
          deltaY * verticalScale,
        );
      }
    };

    const onLegacyMouseWheel = (event: Event) => {
      // regular-table adds a second Safari scroll path on top of WebKit's
      // native wheel handling. Keep one owner so trackpad deltas apply once.
      event.stopImmediatePropagation();
    };

    const onResizeMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        event.button !== 0 ||
        !(target instanceof HTMLElement) ||
        !target.classList.contains("rt-column-resize")
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      const header = target.closest("th");
      if (!(header instanceof HTMLTableCellElement)) {
        return;
      }
      const coordinate = renderedCoordinate(table, header, propsRef.current);
      if (coordinate?.kind !== "header") {
        return;
      }
      const column = propsRef.current.columns[coordinate.column];
      if (column === undefined) {
        return;
      }
      const now = performance.now();
      const previous = lastResizeClickRef.current;
      lastResizeClickRef.current = { column: coordinate.column, time: now };
      if (
        previous !== null &&
        previous.column === coordinate.column &&
        now - previous.time < RESIZE_DOUBLE_CLICK_WINDOW_MS
      ) {
        resizeCleanupRef.current?.();
        resizeRef.current = null;
        void fitColumn(coordinate.column);
        return;
      }

      resizeRef.current = {
        column: coordinate.column,
        startX: event.clientX,
        startWidth: column.width,
        currentWidth: column.width,
      };
      propsRef.current.onColumnResizeStart(coordinate.column);
      const move = (moveEvent: MouseEvent) => {
        const gesture = resizeRef.current;
        if (gesture === null) {
          return;
        }
        const currentColumn = propsRef.current.columns[gesture.column];
        if (currentColumn === undefined) {
          return;
        }
        const width = clamp(
          gesture.startWidth + moveEvent.clientX - gesture.startX,
          propsRef.current.minColumnWidth,
          propsRef.current.maxColumnWidth,
        );
        gesture.currentWidth = width;
        propsRef.current.onColumnResize(width, gesture.column);
      };
      const up = () => {
        const gesture = resizeRef.current;
        resizeRef.current = null;
        resizeCleanupRef.current?.();
        if (gesture === null) {
          return;
        }
        const currentColumn = propsRef.current.columns[gesture.column];
        if (currentColumn !== undefined) {
          propsRef.current.onColumnResizeEnd(
            gesture.currentWidth,
            gesture.column,
          );
        }
      };
      document.addEventListener("mousemove", move, true);
      document.addEventListener("mouseup", up, true);
      resizeCleanupRef.current = () => {
        document.removeEventListener("mousemove", move, true);
        document.removeEventListener("mouseup", up, true);
        resizeCleanupRef.current = null;
      };
    };

    const fitColumn = async (column: number) => {
      const current = propsRef.current;
      if (current.columns[column] === undefined || current.rows === 0) {
        return;
      }
      const controller = new AbortController();
      fitAbortRef.current?.abort();
      fitAbortRef.current = controller;
      const visible = visibleRangeRef.current;
      const rowStart = clamp(Math.floor(visible.y), 0, current.rows - 1);
      const rowCount = Math.min(
        Math.max(1, Math.ceil(visible.height)),
        current.rows - rowStart,
      );
      try {
        await current.onColumnAutoFit(
          column,
          rowStart,
          rowCount,
          controller.signal,
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          throw error;
        }
      }
    };

    table.setDataListener(dataListener, { virtual_mode: "both" });
    configuredRef.current = true;
    restoreColumnWidths(table, propsRef.current);
    table.addEventListener("mousedown", onResizeMouseDown, true);
    table.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    table.addEventListener("contextmenu", onContextMenu);
    table.addEventListener("click", onClick);
    table.addEventListener("keydown", onKeyDown);
    table.addEventListener("copy", onCopy);
    table.addEventListener("scroll", onScroll);
    table.addEventListener("wheel", onWheel, { passive: false });
    table.addEventListener("mousewheel", onLegacyMouseWheel, true);

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => void refreshTable(table, propsRef.current));
    resizeObserver?.observe(table);
    void refreshTable(table, propsRef.current);

    return () => {
      configuredRef.current = false;
      copyAbortRef.current?.abort();
      fitAbortRef.current?.abort();
      resizeCleanupRef.current?.();
      stopDragScroll();
      if (wheelGesture.idleTimer !== null) {
        window.clearTimeout(wheelGesture.idleTimer);
      }
      resizeObserver?.disconnect();
      unsubscribeStyle();
      table.removeEventListener("mousedown", onResizeMouseDown, true);
      table.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      table.removeEventListener("contextmenu", onContextMenu);
      table.removeEventListener("click", onClick);
      table.removeEventListener("keydown", onKeyDown);
      table.removeEventListener("copy", onCopy);
      table.removeEventListener("scroll", onScroll);
      table.removeEventListener("wheel", onWheel);
      table.removeEventListener("mousewheel", onLegacyMouseWheel, true);
    };
  }, [instanceId]);

  useEffect(() => {
    const table = tableRef.current;
    if (table !== null) {
      styleRenderedTable(
        table,
        propsRef.current,
        props.gridSelection,
        focusCellRef.current,
        instanceId,
      );
    }
  }, [instanceId, props.gridSelection]);

  return createElement("regular-table", {
    ref: tableRef,
    className: "viewda-regular-table",
    "data-testid": "regular-table-grid",
    role: "grid",
    "aria-label": "Data grid",
    "aria-rowcount": props.rows + 1,
    "aria-colcount": props.columns.length + 1,
    "aria-multiselectable": true,
    style: GRID_LAYOUT_STYLE,
  } as DetailedHTMLProps<
    HTMLAttributes<RegularTableElement>,
    RegularTableElement
  >);
});

interface RegularTableColumnWidths {
  auto: (number | undefined)[];
  indices: (number | undefined)[];
  override: Record<number, number>;
}

function frozenColumnCount(props: RegularTableGridProps): number {
  return clamp(props.freezeColumns, 0, props.columns.length);
}

function restoreColumnWidths(
  table: RegularTableElement,
  props: RegularTableGridProps,
) {
  const widths: Record<number, number> = { 0: rowMarkerWidth(props.rows) };
  for (let column = 0; column < props.columns.length; column += 1) {
    widths[column + 1] = props.columns[column]?.width ?? props.minColumnWidth;
  }
  table.restoreColumnSizes(widths);

  // regular-table 0.8.6 estimates unrendered columns at 60 px when sizing its
  // virtual panel, even when restoreColumnSizes() supplies their exact widths.
  // Mirror the restored values into the measured-width cache until upstream's
  // scroll calculations use the restored overrides.
  const columnWidths = Object.values(table).find(isRegularTableColumnWidths);
  if (columnWidths === undefined) {
    throw new Error("regular-table column width state is unavailable");
  }
  for (const [index, width] of Object.entries(widths)) {
    columnWidths.indices[Number(index)] = width;
  }
  syncVirtualPanelWidth(table, props);
}

function isRegularTableColumnWidths(
  value: unknown,
): value is RegularTableColumnWidths {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RegularTableColumnWidths>;
  return (
    Array.isArray(candidate.auto) &&
    Array.isArray(candidate.indices) &&
    typeof candidate.override === "object" &&
    candidate.override !== null
  );
}

function syncVirtualPanelWidth(
  table: RegularTableElement,
  props: RegularTableGridProps,
): void {
  const virtualPanel =
    table.shadowRoot?.querySelector<HTMLElement>(".rt-virtual-panel");
  if (virtualPanel === null || virtualPanel === undefined) {
    return;
  }
  const contentWidth = props.columns.reduce(
    (total, column) => total + column.width,
    rowMarkerWidth(props.rows),
  );
  const exactWidth = `${contentWidth}px`;
  virtualPanel.style.width = exactWidth;
  virtualPanel.style.minWidth = exactWidth;
  virtualPanel.style.maxWidth = exactWidth;
}

async function refreshTable(
  table: RegularTableElement,
  props: RegularTableGridProps,
): Promise<void> {
  await table.draw({ invalid_viewport: true });
  syncVirtualPanelWidth(table, props);
}

function clampHorizontalScroll(table: RegularTableElement) {
  if (table.scrollWidth <= table.clientWidth) {
    return;
  }
  const maxScrollLeft = Math.max(0, table.scrollWidth - table.clientWidth);
  if (table.scrollLeft > maxScrollLeft) {
    table.scrollLeft = maxScrollLeft;
  }
}

function syncHorizontalRender(
  table: RegularTableElement,
  props: RegularTableGridProps,
  state: HorizontalOffsetState,
): void {
  const renderedColumn = firstRenderedColumn(table, props);
  if (renderedColumn !== null) {
    // Anchor the transform to the rendered slab, including regular-table's
    // leading overscan column. When a draw swaps slabs, the new boundary and
    // offset still describe the same scrollLeft, so the pixels do not jump.
    state.boundary = props.columns
      .slice(frozenColumnCount(props), renderedColumn)
      .reduce((offset, column) => offset + column.width, 0);
  }
  syncHorizontalOffset(table, state);
}

function syncHorizontalOffset(
  table: RegularTableElement,
  state: HorizontalOffsetState,
): void {
  const offset = table.scrollLeft - state.boundary;
  if (offset === state.offset) {
    return;
  }
  state.offset = offset;
  table.style.setProperty("--viewda-grid-transform-x", `${-offset}px`);
  table.style.setProperty("--viewda-grid-clip-x", `${Math.max(0, offset)}px`);
}

function firstRenderedColumn(
  table: RegularTableElement,
  props: RegularTableGridProps,
): number | null {
  const frozen = frozenColumnCount(props);
  for (const cell of table.querySelectorAll("thead th")) {
    if (!(cell instanceof HTMLTableCellElement)) {
      continue;
    }
    const coordinate = renderedCoordinate(table, cell, props);
    if (coordinate?.kind === "header" && coordinate.column >= frozen) {
      return coordinate.column;
    }
  }
  return null;
}

function wheelPixelDelta(
  event: WheelEvent,
  table: RegularTableElement,
): readonly [number, number] {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? GRID_ROW_HEIGHT
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? table.clientHeight
        : 1;
  return [event.deltaX * scale, event.deltaY * scale];
}

function updateWheelGesture(
  state: WheelGestureState,
  table: RegularTableElement,
  deltaX: number,
  deltaY: number,
): void {
  if (!state.active) {
    state.active = true;
    state.axis = null;
    state.deltaX = 0;
    state.deltaY = 0;
    state.scrollLeft = table.scrollLeft;
    state.scrollTop = table.scrollTop;
  }

  state.deltaX += deltaX;
  state.deltaY += deltaY;
  if (
    state.axis === null &&
    Math.max(Math.abs(state.deltaX), Math.abs(state.deltaY)) >=
      WHEEL_AXIS_LOCK_THRESHOLD_PX
  ) {
    state.axis =
      Math.abs(state.deltaX) > Math.abs(state.deltaY)
        ? "horizontal"
        : "vertical";
  }

  const maxScrollLeft = Math.max(0, table.scrollWidth - table.clientWidth);
  const maxScrollTop = Math.max(0, table.scrollHeight - table.clientHeight);
  // Keep one axis during a gesture, but release it at its edge so the other
  // component of a diagonal trackpad gesture is not discarded.
  if (
    state.axis === "horizontal" &&
    !canScroll(table.scrollLeft, maxScrollLeft, deltaX) &&
    canScroll(table.scrollTop, maxScrollTop, deltaY)
  ) {
    state.axis = "vertical";
    state.scrollLeft = table.scrollLeft;
    state.scrollTop = table.scrollTop;
  } else if (
    state.axis === "vertical" &&
    !canScroll(table.scrollTop, maxScrollTop, deltaY) &&
    canScroll(table.scrollLeft, maxScrollLeft, deltaX)
  ) {
    state.axis = "horizontal";
    state.scrollLeft = table.scrollLeft;
    state.scrollTop = table.scrollTop;
  }

  if (state.idleTimer !== null) {
    window.clearTimeout(state.idleTimer);
  }
  state.idleTimer = window.setTimeout(() => {
    state.active = false;
    state.axis = null;
    state.idleTimer = null;
  }, WHEEL_GESTURE_IDLE_MS);
}

function canScroll(position: number, maximum: number, delta: number): boolean {
  return delta < 0 ? position > 0 : delta > 0 && position < maximum;
}

function verticalWheelScale(
  table: RegularTableElement,
  rowCount: number,
): number {
  const physicalHeight = Math.max(0, table.scrollHeight - table.clientHeight);
  const logicalHeight = Math.max(
    0,
    rowCount * GRID_ROW_HEIGHT + GRID_HEADER_HEIGHT - table.clientHeight,
  );
  return logicalHeight === 0 || physicalHeight === 0
    ? 1
    : Math.min(1, physicalHeight / logicalHeight);
}

function scrollCompressedVerticalWheel(
  table: RegularTableElement,
  state: VerticalWheelState,
  delta: number,
) {
  if (table.scrollTop !== state.scrollTop) {
    state.remainder = 0;
    state.scrollTop = table.scrollTop;
  }
  if (
    state.remainder !== 0 &&
    Math.sign(state.remainder) !== Math.sign(delta)
  ) {
    state.remainder = 0;
  }

  const accumulated = state.remainder + delta;
  const wholePixels = Math.trunc(accumulated);
  state.remainder = accumulated - wholePixels;
  if (wholePixels === 0) {
    return;
  }

  const requested = table.scrollTop + wholePixels;
  table.scrollTop = requested;
  state.scrollTop = table.scrollTop;
  if (state.scrollTop !== requested) {
    state.remainder = 0;
  }
}

function styleRenderedTable(
  regularTable: RegularTableElement,
  props: RegularTableGridProps,
  selection: GridSelection,
  focusCell: readonly [number, number] | null,
  instanceId: string,
): void {
  const table = regularTable.querySelector("table");
  if (table !== null) {
    table.setAttribute("role", "presentation");
  }

  for (const row of regularTable.querySelectorAll("thead tr, tbody tr")) {
    row.setAttribute("role", "row");
  }

  for (const cell of regularTable.querySelectorAll("td, th")) {
    if (!(cell instanceof HTMLTableCellElement)) {
      continue;
    }
    const coordinate = renderedCoordinate(regularTable, cell, props);
    cell.classList.remove(
      "viewda-grid-cell",
      "viewda-grid-header",
      "viewda-grid-row-marker",
      "viewda-grid-selected",
      "viewda-grid-active",
      "viewda-grid-faded",
      "viewda-grid-monospace",
      "viewda-grid-align-left",
      "viewda-grid-align-right",
      "viewda-grid-align-center",
      "viewda-grid-loading",
    );
    if (coordinate === null) {
      continue;
    }
    if (coordinate.kind === "marker-header") {
      const allRowsSelected =
        props.rows > 0 && selection.rows.length === props.rows;
      removeHeaderMenu(cell);
      setHeaderLabel(cell, "");
      cell.classList.add("viewda-grid-header", "viewda-grid-row-marker");
      cell.setAttribute("role", "columnheader");
      cell.setAttribute("aria-colindex", "1");
      cell.setAttribute(
        "aria-label",
        allRowsSelected ? "Clear row selection" : "Select all rows",
      );
      cell.setAttribute("aria-selected", String(allRowsSelected));
      cell.parentElement?.setAttribute("aria-rowindex", "1");
      continue;
    }
    if (coordinate.kind === "header") {
      const column = props.columns[coordinate.column];
      if (column === undefined) {
        continue;
      }
      setHeaderLabel(cell, column.title);
      cell.classList.add("viewda-grid-header");
      cell.classList.toggle(
        "viewda-grid-selected",
        selection.columns.hasIndex(coordinate.column),
      );
      cell.setAttribute("role", "columnheader");
      cell.setAttribute(
        "aria-colindex",
        String(coordinate.column + ARIA_DATA_INDEX_OFFSET),
      );
      cell.setAttribute(
        "aria-selected",
        String(selection.columns.hasIndex(coordinate.column)),
      );
      cell.parentElement?.setAttribute("aria-rowindex", "1");
      cell.dataset.sortDirection = column.sort.direction;
      ensureHeaderMenu(cell, column.title);
      continue;
    }
    if (coordinate.kind === "marker") {
      cell.classList.add("viewda-grid-row-marker");
      cell.setAttribute("role", "rowheader");
      cell.setAttribute("aria-colindex", "1");
      cell.setAttribute(
        "aria-rowindex",
        String(coordinate.row + ARIA_DATA_INDEX_OFFSET),
      );
      cell.setAttribute(
        "aria-selected",
        String(selection.rows.hasIndex(coordinate.row)),
      );
      cell.parentElement?.setAttribute(
        "aria-rowindex",
        String(coordinate.row + ARIA_DATA_INDEX_OFFSET),
      );
      cell.classList.toggle(
        "viewda-grid-selected",
        selection.rows.hasIndex(coordinate.row),
      );
      continue;
    }

    const gridCell = props.getCellContent([coordinate.column, coordinate.row]);
    const selected = selectionContains(
      selection,
      coordinate.column,
      coordinate.row,
    );
    const active =
      focusCell?.[0] === coordinate.column && focusCell[1] === coordinate.row;
    cell.id = `${instanceId}-cell-${coordinate.column}-${coordinate.row}`;
    cell.classList.add("viewda-grid-cell");
    cell.classList.toggle("viewda-grid-selected", selected);
    cell.classList.toggle("viewda-grid-active", active);
    cell.setAttribute("role", "gridcell");
    cell.setAttribute(
      "aria-colindex",
      String(coordinate.column + ARIA_DATA_INDEX_OFFSET),
    );
    cell.setAttribute(
      "aria-rowindex",
      String(coordinate.row + ARIA_DATA_INDEX_OFFSET),
    );
    cell.setAttribute("aria-selected", String(selected));
    cell.parentElement?.setAttribute(
      "aria-rowindex",
      String(coordinate.row + ARIA_DATA_INDEX_OFFSET),
    );
    if (gridCell.kind === GridCellKind.Loading) {
      cell.classList.add("viewda-grid-loading");
      cell.setAttribute("aria-busy", "true");
      continue;
    }
    cell.removeAttribute("aria-busy");
    cell.classList.toggle("viewda-grid-faded", gridCell.style === "faded");
    cell.classList.toggle(
      "viewda-grid-monospace",
      props.columns[coordinate.column]?.monospace ?? false,
    );
    cell.classList.add(`viewda-grid-align-${gridCell.contentAlign}`);
  }

  if (focusCell !== null) {
    regularTable.setAttribute(
      "aria-activedescendant",
      `${instanceId}-cell-${focusCell[0]}-${focusCell[1]}`,
    );
  } else {
    regularTable.removeAttribute("aria-activedescendant");
  }
}

function setHeaderLabel(cell: HTMLTableCellElement, title: string) {
  cell.title = title;
  const label = Array.from(cell.children).find(
    (child) =>
      child instanceof HTMLSpanElement &&
      !child.classList.contains("rt-column-resize"),
  );
  if (label instanceof HTMLSpanElement) {
    label.classList.add("viewda-grid-header-label");
    label.textContent = title;
  }
}

function ensureHeaderMenu(cell: HTMLTableCellElement, title: string) {
  let button = Array.from(cell.children).find(
    (child) =>
      child instanceof HTMLButtonElement &&
      child.classList.contains("viewda-grid-header-menu"),
  ) as HTMLButtonElement | undefined;
  if (button === undefined) {
    const created = document.createElement("button");
    created.type = "button";
    created.className = "viewda-grid-header-menu";
    created.textContent = "⋮";
    cell.appendChild(created);
    button = created;
  }
  button.tabIndex = -1;
  button.setAttribute("aria-label", `${title} column menu`);
}

function removeHeaderMenu(cell: HTMLTableCellElement) {
  cell.querySelector(":scope > .viewda-grid-header-menu")?.remove();
}

type RenderedCoordinate =
  | { kind: "marker-header" }
  | { kind: "header"; column: number }
  | { kind: "marker"; row: number }
  | { kind: "cell"; column: number; row: number };

function renderedCoordinate(
  table: RegularTableElement,
  cell: HTMLTableCellElement,
  props: RegularTableGridProps,
): RenderedCoordinate | null {
  const meta = table.getMeta(cell);
  if (meta === undefined) {
    return null;
  }
  const frozen = frozenColumnCount(props);
  if (meta.type === "corner") {
    return meta.row_header_x === 0
      ? { kind: "marker-header" }
      : { kind: "header", column: meta.row_header_x - 1 };
  }
  if (meta.type === "column_header") {
    return { kind: "header", column: frozen + meta.x };
  }
  if (meta.type === "row_header") {
    return meta.row_header_x === 0
      ? { kind: "marker", row: meta.y }
      : { kind: "cell", column: meta.row_header_x - 1, row: meta.y };
  }
  return { kind: "cell", column: frozen + meta.x, row: meta.y };
}

function renderedColumnHeader(
  table: RegularTableElement,
  props: RegularTableGridProps,
  column: number,
): HTMLTableCellElement | null {
  for (const cell of table.querySelectorAll("thead th")) {
    if (!(cell instanceof HTMLTableCellElement)) {
      continue;
    }
    const coordinate = renderedCoordinate(table, cell, props);
    if (coordinate?.kind === "header" && coordinate.column === column) {
      return cell;
    }
  }
  return null;
}

function alignRenderedColumn(
  table: RegularTableElement,
  props: RegularTableGridProps,
  column: number,
  padding: number,
  alignment: "start" | "end",
): boolean {
  const header = renderedColumnHeader(table, props, column);
  if (header === null) {
    return false;
  }
  const tableBounds = table.getBoundingClientRect();
  const headerBounds = header.getBoundingClientRect();
  const frozenWidth = props.columns
    .slice(0, frozenColumnCount(props))
    .reduce((width, item) => width + item.width, rowMarkerWidth(props.rows));
  const desired =
    alignment === "end"
      ? tableBounds.left + table.clientWidth - padding
      : tableBounds.left + frozenWidth + padding;
  const actual = alignment === "end" ? headerBounds.right : headerBounds.left;
  table.scrollLeft = Math.max(0, table.scrollLeft + actual - desired);
  return true;
}

function selectionContains(
  selection: GridSelection,
  column: number,
  row: number,
): boolean {
  if (selection.rows.hasIndex(row) || selection.columns.hasIndex(column)) {
    return true;
  }
  if (selection.current === undefined) {
    return false;
  }
  return [selection.current.range, ...selection.current.rangeStack].some(
    (range) =>
      range.x <= column &&
      column < range.x + range.width &&
      range.y <= row &&
      row < range.y + range.height,
  );
}

interface KeyboardNavigationResult {
  selection: GridSelection & { current: NonNullable<GridSelection["current"]> };
  scrollTarget: readonly [number, number];
}

function keyboardNavigation(
  event: KeyboardEvent,
  current: NonNullable<GridSelection["current"]>,
  props: RegularTableGridProps,
  visible: Rectangle,
): KeyboardNavigationResult | null {
  if (props.columns.length === 0 || props.rows === 0) {
    return null;
  }
  const primary = event.ctrlKey || event.metaKey;
  if (event.shiftKey && !event.altKey && event.key !== "Tab") {
    let direction: readonly [SelectionGrowth, SelectionGrowth] | null = null;
    if (event.key === "ArrowLeft") {
      direction = [primary ? "start" : -1, 0];
    } else if (event.key === "ArrowRight") {
      direction = [primary ? "end" : 1, 0];
    } else if (event.key === "ArrowUp") {
      direction = [0, primary ? "start" : -1];
    } else if (event.key === "ArrowDown") {
      direction = [0, primary ? "end" : 1];
    } else if (primary && event.key === "Home") {
      direction = ["start", "start"];
    } else if (primary && event.key === "End") {
      direction = ["end", "end"];
    }
    return direction === null
      ? null
      : growKeyboardSelection(current, direction, props);
  }

  let [column, row] = current.cell;
  let retainSelection = false;
  const page = Math.max(1, visible.height - PAGE_NAVIGATION_OVERLAP_ROWS);
  const noModifiers = !primary && !event.altKey && !event.shiftKey;
  if (event.altKey && !primary && !event.shiftKey) {
    retainSelection = true;
    if (event.key === "ArrowLeft") {
      column -= 1;
    } else if (event.key === "ArrowRight") {
      column += 1;
    } else if (event.key === "ArrowUp") {
      row -= 1;
    } else if (event.key === "ArrowDown") {
      row += 1;
    } else {
      return null;
    }
  } else if (event.key === "Tab" && !primary && !event.altKey) {
    column += event.shiftKey ? -1 : 1;
  } else if (noModifiers && event.key === "ArrowLeft") {
    column -= 1;
  } else if (noModifiers && event.key === "ArrowRight") {
    column += 1;
  } else if (noModifiers && event.key === "ArrowUp") {
    row -= 1;
  } else if (noModifiers && event.key === "ArrowDown") {
    row += 1;
  } else if (noModifiers && event.key === "Enter") {
    row += 1;
  } else if (noModifiers && event.key === "Home") {
    column = 0;
  } else if (noModifiers && event.key === "End") {
    column = props.columns.length - 1;
  } else if (noModifiers && event.key === "PageUp") {
    row -= page;
  } else if (noModifiers && event.key === "PageDown") {
    row += page;
  } else if (primary && !event.shiftKey && !event.altKey) {
    if (event.key === "ArrowLeft") {
      column = 0;
    } else if (event.key === "ArrowRight") {
      column = props.columns.length - 1;
    } else if (event.key === "ArrowUp") {
      row = 0;
    } else if (event.key === "ArrowDown") {
      row = props.rows - 1;
    } else if (event.key === "Home") {
      column = 0;
      row = 0;
    } else if (event.key === "End") {
      column = props.columns.length - 1;
      row = props.rows - 1;
    } else {
      return null;
    }
  } else {
    return null;
  }

  const target = [
    clamp(column, 0, props.columns.length - 1),
    clamp(row, 0, props.rows - 1),
  ] as const;
  if (target[0] === current.cell[0] && target[1] === current.cell[1]) {
    return null;
  }
  const rangeStack = [...current.rangeStack];
  if (
    retainSelection &&
    (current.range.width > 1 || current.range.height > 1)
  ) {
    rangeStack.push(current.range);
  }
  return {
    selection: {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: target,
        range: { x: target[0], y: target[1], width: 1, height: 1 },
        rangeStack: retainSelection ? rangeStack : [],
      },
    },
    scrollTarget: target,
  };
}

function growKeyboardSelection(
  current: NonNullable<GridSelection["current"]>,
  direction: readonly [SelectionGrowth, SelectionGrowth],
  props: RegularTableGridProps,
): KeyboardNavigationResult | null {
  const [anchorColumn, anchorRow] = current.cell;
  let left = current.range.x;
  let right = current.range.x + current.range.width;
  let top = current.range.y;
  let bottom = current.range.y + current.range.height;
  const [horizontal, vertical] = direction;

  if (vertical === "start") {
    top = 0;
    bottom = anchorRow + 1;
  } else if (vertical === "end") {
    top = anchorRow;
    bottom = props.rows;
  } else if (vertical === -1) {
    if (bottom > anchorRow + 1) {
      bottom -= 1;
    } else {
      top = Math.max(0, top - 1);
    }
  } else if (vertical === 1) {
    if (top < anchorRow) {
      top += 1;
    } else {
      bottom = Math.min(props.rows, bottom + 1);
    }
  }

  if (horizontal === "start") {
    left = 0;
    right = anchorColumn + 1;
  } else if (horizontal === "end") {
    left = anchorColumn;
    right = props.columns.length;
  } else if (horizontal === -1) {
    if (right > anchorColumn + 1) {
      right -= 1;
    } else {
      left = Math.max(0, left - 1);
    }
  } else if (horizontal === 1) {
    if (left < anchorColumn) {
      left += 1;
    } else {
      right = Math.min(props.columns.length, right + 1);
    }
  }

  const range = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  if (
    range.x === current.range.x &&
    range.y === current.range.y &&
    range.width === current.range.width &&
    range.height === current.range.height
  ) {
    return null;
  }
  return {
    selection: {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: { ...current, range },
    },
    scrollTarget: [
      growthTarget(horizontal, left, right, anchorColumn),
      growthTarget(vertical, top, bottom, anchorRow),
    ],
  };
}

function growthTarget(
  growth: SelectionGrowth,
  start: number,
  end: number,
  anchor: number,
): number {
  if (growth === "start" || growth === -1) {
    return start;
  }
  if (growth === "end" || growth === 1) {
    return end - 1;
  }
  return anchor;
}

async function copySelectionContents(
  props: RegularTableGridProps,
  selection: GridSelection,
  signal: AbortSignal,
): Promise<ReturnType<typeof getCopyBufferContents> | null> {
  let rows: CellArray = [];
  let columnIndices: number[] = [];
  if (selection.current !== undefined) {
    const rectangle = selection.current.range;
    rows = await props.getCellsForSelection(rectangle, signal);
    columnIndices = rangeOf(0, rectangle.width);
  } else if (selection.rows.length > 0) {
    columnIndices = rangeOf(0, props.columns.length);
    for (const range of compactRanges(selection.rows)) {
      const chunk = await props.getCellsForSelection(
        {
          x: 0,
          y: range.start,
          width: props.columns.length,
          height: range.end - range.start,
        },
        signal,
      );
      rows.push(...chunk);
    }
  } else if (selection.columns.length > 0) {
    const columns = [...selection.columns];
    const columnData = await Promise.all(
      columns.map((column) =>
        props.getCellsForSelection(
          { x: column, y: 0, width: 1, height: props.rows },
          signal,
        ),
      ),
    );
    const rowCount = Math.max(0, ...columnData.map((column) => column.length));
    rows = rangeOf(0, rowCount).map((row) =>
      columnData.map(
        (column) =>
          column[row]?.[0] ?? {
            kind: GridCellKind.Loading,
          },
      ),
    );
    columnIndices = rangeOf(0, columns.length);
  }
  return !signal.aborted && rows.length > 0 && columnIndices.length > 0
    ? getCopyBufferContents(rows, columnIndices)
    : null;
}

async function scrollToCell(
  table: RegularTableElement | null,
  props: RegularTableGridProps,
  verticalOffset: VerticalOffsetState,
  column: number,
  row: number,
  direction: "horizontal" | "vertical" | "both",
  paddingX: number,
  alignment: ScrollAlignment,
) {
  if (table === null) {
    return;
  }
  await table.draw({ invalid_viewport: false, cache: true });
  const frozen = frozenColumnCount(props);
  if (direction === "vertical" || direction === "both") {
    setVerticalOffset(table, verticalOffset, 0);
    const visibleRows = fullyVisibleRowCount(table);
    const alignedRow =
      alignment.vertical === "center"
        ? row - Math.floor(visibleRows / 2)
        : alignment.vertical === "end"
          ? row - visibleRows + 1
          : row;
    const maxLogicalRow = Math.max(0, props.rows - visibleRows);
    const maxScrollTop = Math.max(0, table.scrollHeight - table.clientHeight);
    table.scrollTop =
      maxLogicalRow === 0
        ? 0
        : Math.ceil(
            (clamp(alignedRow, 0, maxLogicalRow) / maxLogicalRow) *
              maxScrollTop,
          );
    verticalOffset.scrollTop = table.scrollTop;
  }
  if (
    (direction === "horizontal" || direction === "both") &&
    column >= frozen
  ) {
    // Distant columns may need another public jump after the viewport measures
    // widths that were previously estimated by the virtual table.
    let previousScrollLeft = -1;
    const jumpColumn =
      alignment.horizontal === "end"
        ? firstColumnForEndAlignment(table, props, column, paddingX)
        : column;
    while (
      renderedColumnHeader(table, props, column) === null &&
      table.scrollLeft !== previousScrollLeft
    ) {
      previousScrollLeft = table.scrollLeft;
      const scrollTop = table.scrollTop;
      const jump = table.scrollToCell(jumpColumn - frozen, 0);
      table.scrollTop = scrollTop;
      await jump;
      table.scrollTop = scrollTop;
      await drawScrolledTable(table);
    }
  }
  await drawScrolledTable(table);
  if (
    (direction === "horizontal" || direction === "both") &&
    column >= frozen
  ) {
    let previousScrollLeft: number;
    do {
      previousScrollLeft = table.scrollLeft;
      if (
        !alignRenderedColumn(
          table,
          props,
          column,
          paddingX,
          alignment.horizontal,
        )
      ) {
        break;
      }
      await drawScrolledTable(table);
    } while (
      renderedColumnPosition(table, props, column) !== "inside" &&
      table.scrollLeft !== previousScrollLeft
    );
  }
  if (direction === "vertical" || direction === "both") {
    alignRenderedRow(table, props, row, verticalOffset);
  }
}

function alignRenderedRow(
  table: RegularTableElement,
  props: RegularTableGridProps,
  row: number,
  state: VerticalOffsetState,
) {
  const marker = Array.from(
    table.querySelectorAll<HTMLTableCellElement>("tbody th"),
  ).find((cell) => {
    const coordinate = renderedCoordinate(table, cell, props);
    return coordinate?.kind === "marker" && coordinate.row === row;
  });
  if (marker === undefined) {
    return;
  }
  const tableBounds = table.getBoundingClientRect();
  const markerBounds = marker.getBoundingClientRect();
  const viewportTop = tableBounds.top + GRID_HEADER_HEIGHT;
  const viewportBottom = tableBounds.top + table.clientHeight;
  const offset =
    markerBounds.top < viewportTop
      ? viewportTop - markerBounds.top
      : markerBounds.bottom > viewportBottom
        ? viewportBottom - markerBounds.bottom
        : 0;
  setVerticalOffset(table, state, offset);
}

function setVerticalOffset(
  table: RegularTableElement,
  state: VerticalOffsetState,
  offset: number,
) {
  state.scrollTop = table.scrollTop;
  table.style.setProperty("--viewda-grid-transform-y", `${offset}px`);
}

function verticalScrollCorrection(table: RegularTableElement): number {
  const maximum = Math.max(0, table.scrollHeight - table.clientHeight);
  // regular-table budgets one body-row height for its header. Viewda's taller
  // header needs the difference back at the bottom edge to reveal the last row.
  return maximum > 0 && table.scrollTop >= maximum
    ? Math.min(0, GRID_ROW_HEIGHT - GRID_HEADER_HEIGHT)
    : 0;
}

function firstColumnForEndAlignment(
  table: RegularTableElement,
  props: RegularTableGridProps,
  target: number,
  padding: number,
): number {
  const frozen = frozenColumnCount(props);
  const frozenWidth = props.columns
    .slice(0, frozen)
    .reduce(
      (width, column) => width + column.width,
      rowMarkerWidth(props.rows),
    );
  const availableWidth = Math.max(0, table.clientWidth - frozenWidth - padding);
  let first = target;
  let width = props.columns[target]?.width ?? props.minColumnWidth;
  while (first > frozen) {
    const previousWidth = props.columns[first - 1]?.width;
    if (previousWidth === undefined || width + previousWidth > availableWidth) {
      break;
    }
    first -= 1;
    width += previousWidth;
  }
  return first;
}

function keyboardScrollRequest(
  table: RegularTableElement,
  props: RegularTableGridProps,
  visible: Rectangle,
  column: number,
  row: number,
): {
  direction: "horizontal" | "vertical" | "both";
  alignment: ScrollAlignment;
} | null {
  const columnPosition = visibleColumnPosition(table, props, visible, column);
  const beforeColumns = columnPosition === "before";
  const afterColumns = columnPosition === "after";
  const beforeRows = row < visible.y;
  const afterRows = row >= visible.y + visible.height;
  const horizontal = beforeColumns || afterColumns;
  const vertical = beforeRows || afterRows;
  if (!horizontal && !vertical) {
    return null;
  }
  return {
    direction:
      horizontal && vertical ? "both" : horizontal ? "horizontal" : "vertical",
    alignment: {
      horizontal: afterColumns ? "end" : "start",
      vertical: afterRows ? "end" : "start",
    },
  };
}

function visibleColumnPosition(
  table: RegularTableElement,
  props: RegularTableGridProps,
  visible: Rectangle,
  column: number,
): "before" | "inside" | "after" {
  const frozen = frozenColumnCount(props);
  if (column < frozen) {
    return "inside";
  }
  const rendered = renderedColumnPosition(table, props, column);
  if (rendered === null) {
    return column < visible.x ? "before" : "after";
  }
  return rendered;
}

function renderedColumnPosition(
  table: RegularTableElement,
  props: RegularTableGridProps,
  column: number,
): "before" | "inside" | "after" | null {
  const header = renderedColumnHeader(table, props, column);
  if (header === null) {
    return null;
  }
  const tableBounds = table.getBoundingClientRect();
  const headerBounds = header.getBoundingClientRect();
  const frozenWidth = props.columns
    .slice(0, frozenColumnCount(props))
    .reduce((width, item) => width + item.width, rowMarkerWidth(props.rows));
  if (headerBounds.left < tableBounds.left + frozenWidth) {
    return "before";
  }
  return headerBounds.right > tableBounds.left + table.clientWidth
    ? "after"
    : "inside";
}

function fullyVisibleRowCount(table: RegularTableElement): number {
  return Math.max(
    1,
    Math.floor((table.clientHeight - GRID_HEADER_HEIGHT) / GRID_ROW_HEIGHT),
  );
}

function rowMarkerWidth(rowCount: number): number {
  const digits = String(Math.max(1, rowCount)).length;
  const contentWidth = digits * GRID_ESTIMATED_CHARACTER_WIDTH;
  const horizontalChrome =
    GRID_ROW_MARKER_HORIZONTAL_PADDING * 2 + GRID_CELL_BORDER_WIDTH;
  return Math.max(GRID_MIN_ROW_MARKER_WIDTH, contentWidth + horizontalChrome);
}

function displayCell(cell: GridCell): string {
  return cell.kind === GridCellKind.Text ? cell.displayData : "";
}

function selectionRange(start: number, end: number): CompactSelection {
  return CompactSelection.fromSingleSelection([
    Math.min(start, end),
    Math.max(start, end) + 1,
  ]);
}

function rectangleBetween(
  start: readonly [number, number],
  end: readonly [number, number],
): Rectangle {
  return {
    x: Math.min(start[0], end[0]),
    y: Math.min(start[1], end[1]),
    width: Math.abs(start[0] - end[0]) + 1,
    height: Math.abs(start[1] - end[1]) + 1,
  };
}

function compactRanges(
  selection: CompactSelection,
): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  for (const index of selection) {
    const previous = ranges.at(-1);
    if (previous?.end === index) {
      previous.end += 1;
    } else {
      ranges.push({ start: index, end: index + 1 });
    }
  }
  return ranges;
}

function rectangleFromDom(rectangle: DOMRect): Rectangle {
  return {
    x: rectangle.x,
    y: rectangle.y,
    width: rectangle.width,
    height: rectangle.height,
  };
}

function rangeOf(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, index) =>
    Math.floor(start + index),
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function drawScrolledTable(table: RegularTableElement): Promise<void> {
  await nextAnimationFrame();
  await table.draw({ invalid_viewport: false, cache: true });
  await table.flush();
}
