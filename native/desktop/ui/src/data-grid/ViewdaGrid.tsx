import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  advanceWheelGesture,
  applyLogicalScroll,
  applyPhysicalScroll,
  clampScrollState,
  columnOffsets,
  deriveVerticalLayout,
  GRID_INITIAL_COLUMNS,
  GRID_INITIAL_ROWS,
  GRID_OVERSCAN_COLUMNS,
  GRID_OVERSCAN_ROWS,
  GRID_ROW_HEIGHT,
  hystereticColumnWindow,
  logicalToPhysical,
  logicalTopAfterRowSteps,
  normalizeWheelDelta,
  rowMarkerWidth,
  samePosition,
  visibleRowRange,
  type GridMeasurements,
  type GridSize,
  type ColumnWindow,
  type VerticalScrollState,
  type WheelGestureState,
} from "./grid-layout";
import {
  cellIsSelected,
  moveSelection,
  selectCell,
  selectColumn,
  selectRow,
} from "./grid-selection";
import type {
  GridAddress,
  GridCell,
  GridColumn,
  GridSelection,
  Rectangle,
} from "./grid-model";
const PROBE_TRIGGER_HEIGHT = 1_000_000;
const OVERSIZED_PROBE_EXTENT = 1_000_000_000;
const DRAG_AUTO_SCROLL_EDGE = GRID_ROW_HEIGHT * 2;

export interface GridViewport {
  rowStart: number;
  rowCount: number;
  columnIndices: readonly number[];
  mountedRowStart: number;
  mountedRowCount: number;
  mountedColumnIndices: readonly number[];
}

export interface GridMeasurementPort {
  read(scrollport: HTMLElement): GridMeasurements;
  observe(element: HTMLElement, onResize: () => void): () => void;
  bounds(element: HTMLElement): Rectangle;
  probeScrollExtent(): {
    vertical: number;
    horizontal: number;
  };
}

export interface ViewdaGridHandle {
  focus(): void;
  scrollToRow(row: number): void;
  scrollToColumn(column: number, padding?: number): void;
}

export interface ViewdaGridProps {
  columns: readonly GridColumn[];
  rowCount: number;
  selection: GridSelection;
  contentRevision: number;
  getCellContent(address: GridAddress): GridCell;
  onSelectionChange(selection: GridSelection): void;
  onViewportChange(viewport: GridViewport): void;
  onColumnResize(column: number, width: number): void;
  onColumnAutoFit(column: number): void;
  onSort(column: number, additive: boolean): void;
  onFilter(column: number, bounds: Rectangle): void;
  onHeaderContextMenu(column: number, bounds: Rectangle): void;
  onCellContextMenu(address: GridAddress, bounds: Rectangle): void;
  onCopy(event: ClipboardEvent): void;
  onHorizontalExtentChange(
    exceeded: boolean,
    totalWidth: number,
    safeExtent: number,
  ): void;
  onEscape?(): void;
  measurementPort?: GridMeasurementPort;
}

interface ResizeGesture {
  pointerId: number;
  captureTarget: HTMLElement;
  column: number;
  originX: number;
  originWidth: number;
  moved: boolean;
}

interface SelectionDrag {
  pointerId: number;
  captureTarget: HTMLElement;
  kind: "cell" | "row";
  selection: GridSelection;
  lastRow: number;
  lastColumn: number;
  additive: boolean;
  clientX: number;
  clientY: number;
}

function dragAutoScrollDirection(
  position: number,
  start: number,
  size: number,
): -1 | 0 | 1 {
  const relativePosition = position - start;
  const edge = Math.min(DRAG_AUTO_SCROLL_EDGE, size / 4);
  if (relativePosition < edge) {
    return -1;
  }
  if (relativePosition > size - edge) {
    return 1;
  }
  return 0;
}

const cachedScrollExtents = new WeakMap<
  GridMeasurementPort,
  ReturnType<GridMeasurementPort["probeScrollExtent"]>
>();

export const ViewdaGrid = forwardRef<ViewdaGridHandle, ViewdaGridProps>(
  function ViewdaGrid(
    {
      columns,
      rowCount,
      selection,
      contentRevision,
      getCellContent,
      onSelectionChange,
      onViewportChange,
      onColumnResize,
      onColumnAutoFit,
      onSort,
      onFilter,
      onHeaderContextMenu,
      onCellContextMenu,
      onCopy,
      onHorizontalExtentChange,
      onEscape,
      measurementPort = browserMeasurementPort,
    },
    forwardedRef,
  ) {
    const instanceId = useId().replaceAll(":", "");
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollportRef = useRef<HTMLDivElement>(null);
    const horizontalTrackRef = useRef<HTMLDivElement>(null);
    const scrollingHeadersRef = useRef<HTMLDivElement>(null);
    const resizeGestureRef = useRef<ResizeGesture | null>(null);
    const selectionDragRef = useRef<SelectionDrag | null>(null);
    const autoScrollFrameRef = useRef<number | null>(null);
    const suppressClickRef = useRef(false);
    const expectedPhysicalTopRef = useRef<number | null>(null);
    const wheelGestureRef = useRef<WheelGestureState | null>(null);
    const frameRef = useRef<number | null>(null);
    const initialViewportRef = useRef<GridViewport | null>(null);
    const didSendInitialViewportRef = useRef(false);
    const onViewportChangeRef = useRef(onViewportChange);
    onViewportChangeRef.current = onViewportChange;
    const [geometry, setGeometry] = useState<
      GridSize & { devicePixelRatio: number }
    >({
      width: 0,
      height: 0,
      devicePixelRatio: 1,
    });
    const [columnWindow, setColumnWindow] = useState<ColumnWindow | null>(null);
    const [safeExtent, setSafeExtent] = useState<{
      vertical: number;
      horizontal: number;
    } | null>(() => cachedScrollExtents.get(measurementPort) ?? null);
    const [scrollState, setScrollState] = useState<VerticalScrollState>({
      logicalTop: 0,
      physicalTop: 0,
    });
    const scrollStateRef = useRef(scrollState);
    const onHorizontalExtentChangeRef = useRef(onHorizontalExtentChange);
    onHorizontalExtentChangeRef.current = onHorizontalExtentChange;

    const markerWidth = rowMarkerWidth(rowCount);
    const pinnedIndices = useMemo(
      () => columns.flatMap((column, index) => (column.pinned ? [index] : [])),
      [columns],
    );
    const scrollingIndices = useMemo(
      () => columns.flatMap((column, index) => (column.pinned ? [] : [index])),
      [columns],
    );
    const pinnedWidth = pinnedIndices.reduce(
      (width, index) => width + (columns[index]?.width ?? 0),
      0,
    );
    const scrollingOffsets = useMemo(
      () =>
        columnOffsets(
          scrollingIndices.map((index) => columns[index]?.width ?? 0),
        ),
      [columns, scrollingIndices],
    );
    const scrollingWidth = scrollingOffsets.at(-1) ?? 0;
    const totalWidth = markerWidth + pinnedWidth + scrollingWidth;
    const logicalHeight = rowCount * GRID_ROW_HEIGHT;
    const extent = safeExtent ?? {
      vertical: logicalHeight,
      horizontal: totalWidth,
    };
    const layout = useMemo(
      () =>
        deriveVerticalLayout(
          rowCount,
          GRID_ROW_HEIGHT,
          geometry.height,
          extent.vertical,
        ),
      [extent.vertical, geometry.height, rowCount],
    );
    const committedLayoutRef = useRef(layout);
    const layoutChanged =
      committedLayoutRef.current.logicalMax !== layout.logicalMax ||
      committedLayoutRef.current.physicalMax !== layout.physicalMax;
    const effectiveScrollState =
      layoutChanged ||
      scrollState.logicalTop < 0 ||
      scrollState.logicalTop > layout.logicalMax
        ? clampScrollState(scrollState, layout)
        : scrollState;

    if (initialViewportRef.current === null) {
      const initialColumns = [
        ...new Set([
          ...pinnedIndices,
          ...scrollingIndices.slice(0, GRID_INITIAL_COLUMNS),
        ]),
      ];
      const initialRowCount = Math.min(rowCount, GRID_INITIAL_ROWS);
      initialViewportRef.current = {
        rowStart: 0,
        rowCount: initialRowCount,
        columnIndices: initialColumns,
        mountedRowStart: 0,
        mountedRowCount: initialRowCount,
        mountedColumnIndices: initialColumns,
      };
    }

    useLayoutEffect(() => {
      if (didSendInitialViewportRef.current) {
        return;
      }
      didSendInitialViewportRef.current = true;
      const initial = initialViewportRef.current;
      if (initial !== null) {
        onViewportChangeRef.current(initial);
      }
    }, []);

    useLayoutEffect(() => {
      if (
        safeExtent !== null ||
        (logicalHeight < PROBE_TRIGGER_HEIGHT &&
          totalWidth < PROBE_TRIGGER_HEIGHT)
      ) {
        return;
      }
      const measured = measurementPort.probeScrollExtent();
      cachedScrollExtents.set(measurementPort, measured);
      setSafeExtent(measured);
    }, [logicalHeight, measurementPort, safeExtent, totalWidth]);

    useEffect(() => {
      if (safeExtent !== null) {
        onHorizontalExtentChangeRef.current(
          totalWidth > safeExtent.horizontal,
          totalWidth,
          safeExtent.horizontal,
        );
      }
    }, [safeExtent, totalWidth]);

    const commitScrollState = useCallback((next: VerticalScrollState) => {
      if (sameScrollState(scrollStateRef.current, next)) {
        return;
      }
      scrollStateRef.current = next;
      setScrollState(next);
    }, []);

    const writePhysicalTop = useCallback((physicalTop: number) => {
      const scrollport = scrollportRef.current;
      if (scrollport === null) {
        return;
      }
      expectedPhysicalTopRef.current = physicalTop;
      if (!samePosition(scrollport.scrollTop, physicalTop)) {
        scrollport.scrollTop = physicalTop;
      }
    }, []);

    const syncHorizontalScroll = useCallback((requestedLeft?: number) => {
      const scrollport = scrollportRef.current;
      const horizontalTrack = horizontalTrackRef.current;
      if (scrollport === null || horizontalTrack === null) {
        return null;
      }
      if (
        requestedLeft !== undefined &&
        positionsDiffer(scrollport.scrollLeft, requestedLeft)
      ) {
        scrollport.scrollLeft = requestedLeft;
      }
      const actualLeft = scrollport.scrollLeft;
      if (!samePosition(horizontalTrack.scrollLeft, actualLeft)) {
        horizontalTrack.scrollLeft = actualLeft;
      }
      const scrollingHeaders = scrollingHeadersRef.current;
      if (scrollingHeaders !== null) {
        const transform = `translateX(${-actualLeft}px)`;
        if (scrollingHeaders.style.transform !== transform) {
          scrollingHeaders.style.transform = transform;
        }
      }
      return actualLeft;
    }, []);

    useLayoutEffect(() => {
      const clamped = clampScrollState(scrollStateRef.current, layout);
      committedLayoutRef.current = layout;
      commitScrollState(clamped);
      writePhysicalTop(clamped.physicalTop);
    }, [
      commitScrollState,
      layout.logicalMax,
      layout.physicalMax,
      writePhysicalTop,
    ]);

    const scheduleMeasurement = useCallback(() => {
      if (frameRef.current !== null) {
        return;
      }
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const scrollport = scrollportRef.current;
        const horizontalTrack = horizontalTrackRef.current;
        if (scrollport !== null && horizontalTrack !== null) {
          syncHorizontalScroll();
          const read = measurementPort.read(scrollport);
          const expected = expectedPhysicalTopRef.current;
          const ownWrite =
            expected !== null && samePosition(expected, read.scrollTop);
          expectedPhysicalTopRef.current = null;
          const next =
            layout.mode === "native"
              ? {
                  logicalTop: read.scrollTop,
                  physicalTop: read.scrollTop,
                }
              : applyPhysicalScroll(
                  scrollStateRef.current,
                  read.scrollTop,
                  layout,
                  ownWrite,
                );
          commitScrollState(next);
          setGeometry((current) =>
            sameGeometry(current, read)
              ? current
              : {
                  width: read.width,
                  height: read.height,
                  devicePixelRatio: read.devicePixelRatio,
                },
          );
          setColumnWindow((current) =>
            hystereticColumnWindow(
              scrollingOffsets,
              read.scrollLeft,
              Math.max(0, read.width - markerWidth - pinnedWidth),
              GRID_OVERSCAN_COLUMNS,
              current,
            ),
          );
        }
      });
    }, [
      commitScrollState,
      layout,
      markerWidth,
      measurementPort,
      pinnedWidth,
      scrollingOffsets,
      syncHorizontalScroll,
    ]);

    useLayoutEffect(() => {
      const scrollport = scrollportRef.current;
      const horizontalTrack = horizontalTrackRef.current;
      if (scrollport === null || horizontalTrack === null) {
        return;
      }
      syncHorizontalScroll();
      const read = measurementPort.read(scrollport);
      setGeometry((current) =>
        sameGeometry(current, read)
          ? current
          : {
              width: read.width,
              height: read.height,
              devicePixelRatio: read.devicePixelRatio,
            },
      );
      setColumnWindow((current) =>
        hystereticColumnWindow(
          scrollingOffsets,
          read.scrollLeft,
          Math.max(0, read.width - markerWidth - pinnedWidth),
          GRID_OVERSCAN_COLUMNS,
          current,
        ),
      );
      const disconnect = measurementPort.observe(
        scrollport,
        scheduleMeasurement,
      );
      return () => {
        disconnect();
        if (frameRef.current !== null) {
          window.cancelAnimationFrame(frameRef.current);
          frameRef.current = null;
        }
      };
    }, [
      markerWidth,
      measurementPort,
      pinnedWidth,
      scheduleMeasurement,
      scrollingOffsets,
      syncHorizontalScroll,
    ]);

    const scrollingViewportWidth = Math.max(
      0,
      geometry.width - markerWidth - pinnedWidth,
    );
    const hasHorizontalOverflow =
      scrollingViewportWidth > 0 && scrollingWidth > scrollingViewportWidth;
    const effectiveColumnWindow =
      columnWindow ??
      hystereticColumnWindow(
        scrollingOffsets,
        0,
        scrollingViewportWidth,
        GRID_OVERSCAN_COLUMNS,
        null,
      );
    const renderedScrollingRange = effectiveColumnWindow.mounted;
    const visibleScrollingRange = effectiveColumnWindow.visible;
    const visibleScrollingIndices = useMemo(
      () =>
        scrollingIndices.slice(
          renderedScrollingRange.start,
          renderedScrollingRange.end,
        ),
      [
        renderedScrollingRange.end,
        renderedScrollingRange.start,
        scrollingIndices,
      ],
    );
    const viewportScrollingIndices = useMemo(
      () =>
        scrollingIndices.slice(
          visibleScrollingRange.start,
          visibleScrollingRange.end,
        ),
      [
        scrollingIndices,
        visibleScrollingRange.end,
        visibleScrollingRange.start,
      ],
    );
    const renderedColumnIndices = useMemo(
      () => [...pinnedIndices, ...visibleScrollingIndices],
      [pinnedIndices, visibleScrollingIndices],
    );
    const viewportColumnIndices = useMemo(
      () => [...pinnedIndices, ...viewportScrollingIndices],
      [pinnedIndices, viewportScrollingIndices],
    );
    const renderedColumnSet = useMemo(
      () => new Set(renderedColumnIndices),
      [renderedColumnIndices],
    );
    const renderedRows = visibleRowRange(
      effectiveScrollState.logicalTop,
      geometry.height,
      GRID_ROW_HEIGHT,
      rowCount,
      GRID_OVERSCAN_ROWS,
    );
    const visibleRows = visibleRowRange(
      effectiveScrollState.logicalTop,
      geometry.height,
      GRID_ROW_HEIGHT,
      rowCount,
      0,
    );

    useEffect(() => {
      onViewportChangeRef.current({
        rowStart: visibleRows.start,
        rowCount: visibleRows.end - visibleRows.start,
        columnIndices: viewportColumnIndices,
        mountedRowStart: renderedRows.start,
        mountedRowCount: renderedRows.end - renderedRows.start,
        mountedColumnIndices: renderedColumnIndices,
      });
    }, [
      geometry,
      renderedColumnIndices,
      renderedRows.end,
      renderedRows.start,
      viewportColumnIndices,
      visibleRows.end,
      visibleRows.start,
    ]);

    const applyLogicalDelta = useCallback(
      (delta: number) => {
        const current = scrollStateRef.current;
        const next = applyLogicalScroll(current, delta, layout);
        if (!positionsDiffer(current.logicalTop, next.logicalTop)) {
          return false;
        }
        commitScrollState(next);
        writePhysicalTop(next.physicalTop);
        scheduleMeasurement();
        return true;
      },
      [commitScrollState, layout, scheduleMeasurement, writePhysicalTop],
    );

    useEffect(() => {
      const root = rootRef.current;
      if (root === null) {
        return;
      }
      const handleWheel = (event: WheelEvent) => {
        if (event.ctrlKey) {
          return;
        }
        const shiftedHorizontalDelta = event.shiftKey
          ? event.deltaX !== 0
            ? event.deltaX
            : event.deltaY
          : event.deltaX;
        const verticalDelta = normalizeWheelDelta(
          event.shiftKey ? 0 : event.deltaY,
          event.deltaMode,
          GRID_ROW_HEIGHT,
          geometry.height,
        );
        const horizontalDelta = normalizeWheelDelta(
          shiftedHorizontalDelta,
          event.deltaMode,
          GRID_ROW_HEIGHT,
          geometry.width,
        );
        const scrollport = scrollportRef.current;
        const horizontalTrack = horizontalTrackRef.current;
        if (
          scrollport === null ||
          horizontalTrack === null ||
          (verticalDelta === 0 && horizontalDelta === 0)
        ) {
          return;
        }
        event.preventDefault();
        const advance = advanceWheelGesture(
          wheelGestureRef.current,
          horizontalDelta,
          verticalDelta,
          event.timeStamp,
          GRID_ROW_HEIGHT,
        );
        wheelGestureRef.current = advance.state;
        if (advance.horizontalDelta !== 0) {
          const previousLeft = scrollport.scrollLeft;
          const actualLeft = syncHorizontalScroll(
            previousLeft + advance.horizontalDelta,
          );
          if (
            actualLeft !== null &&
            positionsDiffer(previousLeft, actualLeft)
          ) {
            scheduleMeasurement();
          }
        } else if (advance.rowSteps !== 0) {
          const logicalTop = scrollStateRef.current.logicalTop;
          const target = logicalTopAfterRowSteps(
            logicalTop,
            advance.rowSteps,
            GRID_ROW_HEIGHT,
            layout.logicalMax,
          );
          applyLogicalDelta(target - logicalTop);
        }
      };
      root.addEventListener("wheel", handleWheel, { passive: false });
      return () => root.removeEventListener("wheel", handleWheel);
    }, [
      applyLogicalDelta,
      layout.logicalMax,
      geometry.height,
      geometry.width,
      scheduleMeasurement,
      syncHorizontalScroll,
    ]);

    const handleScroll = useCallback(() => {
      syncHorizontalScroll();
      scheduleMeasurement();
    }, [scheduleMeasurement, syncHorizontalScroll]);

    const handleHorizontalTrackScroll = useCallback(() => {
      const scrollport = scrollportRef.current;
      const horizontalTrack = horizontalTrackRef.current;
      if (scrollport === null || horizontalTrack === null) {
        return;
      }
      const previousLeft = scrollport.scrollLeft;
      const actualLeft = syncHorizontalScroll(horizontalTrack.scrollLeft);
      if (actualLeft !== null && positionsDiffer(previousLeft, actualLeft)) {
        scheduleMeasurement();
      }
    }, [scheduleMeasurement, syncHorizontalScroll]);

    const scrollToRow = useCallback(
      (row: number) => {
        const logicalTop = Math.min(
          layout.logicalMax,
          Math.max(0, row * GRID_ROW_HEIGHT),
        );
        const next = {
          logicalTop,
          physicalTop: logicalToPhysical(logicalTop, layout),
        };
        commitScrollState(next);
        writePhysicalTop(next.physicalTop);
        scheduleMeasurement();
      },
      [commitScrollState, layout, scheduleMeasurement, writePhysicalTop],
    );

    const scrollToColumn = useCallback(
      (column: number, padding = 0) => {
        if (pinnedIndices.includes(column)) {
          return;
        }
        const scrollingIndex = scrollingIndices.indexOf(column);
        const scrollport = scrollportRef.current;
        if (scrollingIndex < 0 || scrollport === null) {
          return;
        }
        const start = scrollingOffsets[scrollingIndex] ?? 0;
        const end = scrollingOffsets[scrollingIndex + 1] ?? start;
        const viewportStart = scrollport.scrollLeft;
        const viewportEnd = viewportStart + scrollingViewportWidth;
        let targetLeft = viewportStart;
        if (start - padding < viewportStart) {
          targetLeft = Math.max(0, start - padding);
        } else if (end + padding > viewportEnd) {
          targetLeft = end + padding - scrollingViewportWidth;
        }
        const actualLeft = syncHorizontalScroll(targetLeft);
        if (actualLeft !== null && positionsDiffer(viewportStart, actualLeft)) {
          scheduleMeasurement();
        }
      },
      [
        pinnedIndices,
        scrollingIndices,
        scrollingOffsets,
        scrollingViewportWidth,
        scheduleMeasurement,
        syncHorizontalScroll,
      ],
    );

    useImperativeHandle(
      forwardedRef,
      () => ({
        focus: () => rootRef.current?.focus(),
        scrollToRow,
        scrollToColumn,
      }),
      [scrollToColumn, scrollToRow],
    );

    const ensureCellVisible = useCallback(
      (cell: GridAddress) => {
        if (cell.row * GRID_ROW_HEIGHT < scrollStateRef.current.logicalTop) {
          scrollToRow(cell.row);
        } else if (
          (cell.row + 1) * GRID_ROW_HEIGHT >
          scrollStateRef.current.logicalTop + geometry.height
        ) {
          scrollToRow(
            Math.max(
              0,
              cell.row - Math.floor(geometry.height / GRID_ROW_HEIGHT) + 1,
            ),
          );
        }
        scrollToColumn(cell.column, 8);
      },
      [geometry.height, scrollToColumn, scrollToRow],
    );

    const updateCellSelection = useCallback(
      (cell: GridAddress, extend: boolean, additive: boolean) => {
        const next = selectCell(selection, cell, extend, additive);
        onSelectionChange(next);
        ensureCellVisible(cell);
      },
      [ensureCellVisible, onSelectionChange, selection],
    );

    const handleClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-grid-kind]",
        );
        if (target === null) {
          return;
        }
        const column = parseIndex(target.dataset.column);
        const row = parseIndex(target.dataset.row);
        const additive = event.metaKey || event.ctrlKey;
        if (target.dataset.action === "resize") {
          rootRef.current?.focus();
          return;
        }
        if (target.dataset.action === "sort" && column !== null) {
          onSort(column, additive || event.shiftKey);
          rootRef.current?.focus();
          return;
        }
        if (target.dataset.action === "filter" && column !== null) {
          onFilter(column, measurementPort.bounds(target));
          rootRef.current?.focus();
          return;
        }
        if (
          target.dataset.gridKind === "cell" &&
          column !== null &&
          row !== null
        ) {
          updateCellSelection({ column, row }, event.shiftKey, additive);
        } else if (target.dataset.gridKind === "row" && row !== null) {
          onSelectionChange(
            selectRow(selection, row, event.shiftKey, additive),
          );
        } else if (target.dataset.gridKind === "header" && column !== null) {
          onSelectionChange(
            selectColumn(selection, column, event.shiftKey, additive),
          );
        }
        rootRef.current?.focus();
      },
      [
        measurementPort,
        onFilter,
        onSelectionChange,
        onSort,
        selection,
        updateCellSelection,
      ],
    );

    const handleContextMenu = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-grid-kind]",
        );
        if (target === null) {
          return;
        }
        const column = parseIndex(target.dataset.column);
        const row = parseIndex(target.dataset.row);
        if (target.dataset.gridKind === "header" && column !== null) {
          event.preventDefault();
          onHeaderContextMenu(column, measurementPort.bounds(target));
          rootRef.current?.focus();
        } else if (
          target.dataset.gridKind === "cell" &&
          column !== null &&
          row !== null
        ) {
          event.preventDefault();
          onCellContextMenu({ column, row }, measurementPort.bounds(target));
        }
      },
      [measurementPort, onCellContextMenu, onHeaderContextMenu],
    );

    const handlePointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const handle = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-action="resize"]',
        );
        const column = parseIndex(handle?.dataset.column);
        if (handle !== null && column !== null) {
          const gridColumn = columns[column];
          if (gridColumn === undefined) {
            return;
          }
          event.preventDefault();
          const captureTarget = rootRef.current;
          if (captureTarget === null) {
            return;
          }
          captureTarget.setPointerCapture(event.pointerId);
          resizeGestureRef.current = {
            pointerId: event.pointerId,
            captureTarget,
            column,
            originX: event.clientX,
            originWidth: gridColumn.width,
            moved: false,
          };
          return;
        }
        if (event.button !== 0) {
          return;
        }
        const target = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-grid-kind="cell"], [data-grid-kind="row"]',
        );
        const row = parseIndex(target?.dataset.row);
        const cellColumn = parseIndex(target?.dataset.column);
        if (target === null || row === null) {
          return;
        }
        event.preventDefault();
        const captureTarget = rootRef.current;
        if (captureTarget === null) {
          return;
        }
        captureTarget.setPointerCapture(event.pointerId);
        captureTarget.focus();
        suppressClickRef.current = true;
        const additive = event.metaKey || event.ctrlKey;
        const next =
          target.dataset.gridKind === "cell" && cellColumn !== null
            ? selectCell(
                selection,
                { row, column: cellColumn },
                event.shiftKey,
                additive,
              )
            : selectRow(selection, row, event.shiftKey, additive);
        onSelectionChange(next);
        selectionDragRef.current = {
          pointerId: event.pointerId,
          captureTarget,
          kind: target.dataset.gridKind === "cell" ? "cell" : "row",
          selection: next,
          lastRow: row,
          lastColumn: cellColumn ?? 0,
          additive,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      },
      [columns, onSelectionChange, selection],
    );

    const finishResize = useCallback(
      (pointerId?: number, suppressFollowingClick = false) => {
        const gesture = resizeGestureRef.current;
        resizeGestureRef.current = null;
        if (gesture !== null) {
          suppressClickRef.current = gesture.moved && suppressFollowingClick;
        }
        const capturedPointerId = pointerId ?? gesture?.pointerId;
        const captureTarget = gesture?.captureTarget ?? rootRef.current;
        if (
          capturedPointerId !== undefined &&
          captureTarget?.hasPointerCapture(capturedPointerId)
        ) {
          captureTarget.releasePointerCapture(capturedPointerId);
        }
      },
      [],
    );

    const finishSelectionDrag = useCallback(
      (pointerId?: number, suppressFollowingClick = false) => {
        const drag = selectionDragRef.current;
        selectionDragRef.current = null;
        if (drag !== null) {
          suppressClickRef.current = suppressFollowingClick;
        }
        if (autoScrollFrameRef.current !== null) {
          window.cancelAnimationFrame(autoScrollFrameRef.current);
          autoScrollFrameRef.current = null;
        }
        const capturedPointerId = pointerId ?? drag?.pointerId;
        const captureTarget = drag?.captureTarget ?? rootRef.current;
        if (
          capturedPointerId !== undefined &&
          captureTarget?.hasPointerCapture(capturedPointerId)
        ) {
          captureTarget.releasePointerCapture(capturedPointerId);
        }
      },
      [],
    );

    const extendSelectionDrag = useCallback(
      (drag: SelectionDrag, row: number, column: number) => {
        if (rowCount === 0 || columns.length === 0) {
          return;
        }
        const clampedRow = Math.max(0, Math.min(rowCount - 1, row));
        const clampedColumn = Math.max(0, Math.min(columns.length - 1, column));
        if (
          clampedRow === drag.lastRow &&
          (drag.kind === "row" || clampedColumn === drag.lastColumn)
        ) {
          return;
        }
        drag.lastRow = clampedRow;
        drag.lastColumn = clampedColumn;
        onSelectionChange(
          drag.kind === "cell"
            ? selectCell(
                drag.selection,
                { row: clampedRow, column: clampedColumn },
                true,
                false,
              )
            : selectRow(drag.selection, clampedRow, true, drag.additive),
        );
      },
      [columns.length, onSelectionChange, rowCount],
    );

    const scheduleDragAutoScroll = useCallback(() => {
      if (autoScrollFrameRef.current !== null) {
        return;
      }
      const step = () => {
        autoScrollFrameRef.current = null;
        const drag = selectionDragRef.current;
        const scrollport = scrollportRef.current;
        if (drag === null || scrollport === null) {
          return;
        }
        const bounds = measurementPort.bounds(scrollport);
        const verticalDirection = dragAutoScrollDirection(
          drag.clientY,
          bounds.y,
          bounds.height,
        );
        const horizontalDirection = dragAutoScrollDirection(
          drag.clientX,
          bounds.x,
          bounds.width,
        );
        let progressed = false;
        if (verticalDirection !== 0) {
          progressed =
            applyLogicalDelta(verticalDirection * GRID_ROW_HEIGHT) ||
            progressed;
          const previousRow = drag.lastRow;
          extendSelectionDrag(
            drag,
            drag.lastRow + verticalDirection,
            drag.lastColumn,
          );
          progressed = drag.lastRow !== previousRow || progressed;
        }
        if (horizontalDirection !== 0 && drag.kind === "cell") {
          const previousLeft = scrollport.scrollLeft;
          const actualLeft = syncHorizontalScroll(
            previousLeft + horizontalDirection * GRID_ROW_HEIGHT,
          );
          if (
            actualLeft !== null &&
            positionsDiffer(previousLeft, actualLeft)
          ) {
            scheduleMeasurement();
            progressed = true;
          }
          const previousColumn = drag.lastColumn;
          extendSelectionDrag(
            drag,
            drag.lastRow,
            drag.lastColumn + horizontalDirection,
          );
          progressed = drag.lastColumn !== previousColumn || progressed;
        }
        if (progressed && selectionDragRef.current === drag) {
          autoScrollFrameRef.current = window.requestAnimationFrame(step);
        }
      };
      autoScrollFrameRef.current = window.requestAnimationFrame(step);
    }, [
      applyLogicalDelta,
      extendSelectionDrag,
      measurementPort,
      scheduleMeasurement,
      syncHorizontalScroll,
    ]);

    const handlePointerMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const gesture = resizeGestureRef.current;
        if (gesture !== null) {
          const delta = event.clientX - gesture.originX;
          if (delta !== 0) {
            gesture.moved = true;
            onColumnResize(gesture.column, gesture.originWidth + delta);
          }
          return;
        }
        const drag = selectionDragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) {
          return;
        }
        drag.clientX = event.clientX;
        drag.clientY = event.clientY;
        const target = document
          .elementFromPoint?.(event.clientX, event.clientY)
          ?.closest<HTMLElement>(
            '[data-grid-kind="cell"], [data-grid-kind="row"]',
          );
        const row = parseIndex(target?.dataset.row);
        const column = parseIndex(target?.dataset.column);
        if (
          target != null &&
          row !== null &&
          ((drag.kind === "cell" && column !== null) ||
            (drag.kind === "row" && target.dataset.gridKind === "row"))
        ) {
          extendSelectionDrag(drag, row, column ?? drag.lastColumn);
        }
        scheduleDragAutoScroll();
      },
      [extendSelectionDrag, onColumnResize, scheduleDragAutoScroll],
    );

    useEffect(
      () => () => {
        finishResize();
        finishSelectionDrag();
      },
      [finishResize, finishSelectionDrag],
    );

    const handleDoubleClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const handle = (event.target as HTMLElement).closest<HTMLElement>(
          '[data-action="resize"]',
        );
        const column = parseIndex(handle?.dataset.column);
        if (column !== null) {
          event.preventDefault();
          finishResize();
          onColumnAutoFit(column);
        }
      },
      [finishResize, onColumnAutoFit],
    );

    const handleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          onEscape?.();
          return;
        }
        if (rowCount === 0 || columns.length === 0) {
          return;
        }
        const pageRows = Math.max(
          1,
          Math.floor(geometry.height / GRID_ROW_HEIGHT),
        );
        const currentCell = selection.current?.cell ?? { row: 0, column: 0 };
        const primaryModifier = event.metaKey || event.ctrlKey;
        const selectDestination = (row: number, column: number) =>
          selectCell(selection, { row, column }, event.shiftKey, false);
        let next: GridSelection;
        if (event.key === "ArrowUp" && primaryModifier) {
          next = selectDestination(0, currentCell.column);
        } else if (event.key === "ArrowDown" && primaryModifier) {
          next = selectDestination(
            Math.max(0, rowCount - 1),
            currentCell.column,
          );
        } else if (event.key === "ArrowLeft" && primaryModifier) {
          next = selectDestination(currentCell.row, 0);
        } else if (event.key === "ArrowRight" && primaryModifier) {
          next = selectDestination(
            currentCell.row,
            Math.max(0, columns.length - 1),
          );
        } else if (event.key === "ArrowUp") {
          next = moveSelection(
            selection,
            -1,
            0,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "ArrowDown") {
          next = moveSelection(
            selection,
            1,
            0,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "ArrowLeft") {
          next = moveSelection(
            selection,
            0,
            -1,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "ArrowRight") {
          next = moveSelection(
            selection,
            0,
            1,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "PageUp") {
          next = moveSelection(
            selection,
            -pageRows,
            0,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "PageDown") {
          next = moveSelection(
            selection,
            pageRows,
            0,
            rowCount,
            columns.length,
            event.shiftKey,
          );
        } else if (event.key === "Home") {
          next = primaryModifier
            ? selectDestination(0, 0)
            : selectDestination(currentCell.row, 0);
        } else if (event.key === "End") {
          next = primaryModifier
            ? selectDestination(
                Math.max(0, rowCount - 1),
                Math.max(0, columns.length - 1),
              )
            : selectDestination(
                currentCell.row,
                Math.max(0, columns.length - 1),
              );
        } else if (
          primaryModifier &&
          !event.altKey &&
          event.key.toLowerCase() === "a"
        ) {
          event.preventDefault();
          onSelectionChange({
            columns: selection.columns,
            rows: selection.rows,
            current: {
              cell: { row: 0, column: 0 },
              range: {
                x: 0,
                y: 0,
                width: columns.length,
                height: rowCount,
              },
              rangeStack: [],
            },
          });
          return;
        } else {
          return;
        }
        event.preventDefault();
        onSelectionChange(next);
        const active = next.current?.cell;
        if (active !== undefined) {
          ensureCellVisible(active);
        }
      },
      [
        columns.length,
        ensureCellVisible,
        geometry.height,
        onEscape,
        onSelectionChange,
        rowCount,
        selection,
      ],
    );

    const activeCell = selection.current?.cell;
    const activeMounted =
      activeCell !== undefined &&
      activeCell.row >= renderedRows.start &&
      activeCell.row < renderedRows.end &&
      renderedColumnSet.has(activeCell.column);
    const activeDescendant = activeMounted
      ? cellId(instanceId, activeCell)
      : undefined;
    const pinnedLeftByColumn = useMemo(() => {
      const leftByColumn = new Map<number, number>();
      let left = markerWidth;
      for (const index of pinnedIndices) {
        leftByColumn.set(index, left);
        left += columns[index]?.width ?? 0;
      }
      return leftByColumn;
    }, [columns, markerWidth, pinnedIndices]);
    const ariaColumnByColumn = useMemo(
      () =>
        new Map(
          [...pinnedIndices, ...scrollingIndices].map((column, index) => [
            column,
            index + 2,
          ]),
        ),
      [pinnedIndices, scrollingIndices],
    );

    const rows = [];
    for (let row = renderedRows.start; row < renderedRows.end; row += 1) {
      rows.push(
        <GridRow
          key={row}
          instanceId={instanceId}
          row={row}
          columns={columns}
          pinnedIndices={pinnedIndices}
          visibleScrollingIndices={visibleScrollingIndices}
          visibleScrollingStart={
            scrollingOffsets[renderedScrollingRange.start] ?? 0
          }
          markerWidth={markerWidth}
          pinnedLeftByColumn={pinnedLeftByColumn}
          ariaColumnByColumn={ariaColumnByColumn}
          physicalTop={
            effectiveScrollState.physicalTop +
            row * GRID_ROW_HEIGHT -
            effectiveScrollState.logicalTop
          }
          selection={selection}
          contentRevision={contentRevision}
          getCellContent={getCellContent}
          activeCell={activeCell}
        />,
      );
    }

    return (
      <div
        ref={rootRef}
        className="viewda-grid"
        role="grid"
        aria-label="Data grid"
        tabIndex={0}
        aria-rowcount={rowCount + 1}
        aria-colcount={columns.length + 1}
        aria-multiselectable="true"
        aria-activedescendant={activeDescendant}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onCopy={(event) => onCopy(event.nativeEvent)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          finishResize(event.pointerId, true);
          finishSelectionDrag(event.pointerId, true);
        }}
        onPointerCancel={(event) => {
          finishResize(event.pointerId);
          finishSelectionDrag(event.pointerId);
        }}
        onBlur={() => {
          finishResize();
          finishSelectionDrag();
        }}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        <div className="viewda-grid-header" role="row" aria-rowindex={1}>
          <div
            className="viewda-grid-corner"
            role="columnheader"
            aria-label="Row numbers"
            aria-colindex={1}
            style={{ width: markerWidth }}
          />
          {pinnedIndices.map((column) => (
            <GridHeader
              key={columns[column]?.id}
              column={column}
              ariaColumnIndex={ariaColumnByColumn.get(column) ?? column + 2}
              details={columns[column]}
              left={pinnedLeftByColumn.get(column) ?? markerWidth}
              pinned
            />
          ))}
          <div
            ref={scrollingHeadersRef}
            className="viewda-grid-scrolling-headers"
            role="presentation"
          >
            {visibleScrollingIndices.map((column, visibleIndex) => {
              const scrollingIndex =
                renderedScrollingRange.start + visibleIndex;
              return (
                <GridHeader
                  key={columns[column]?.id}
                  column={column}
                  ariaColumnIndex={ariaColumnByColumn.get(column) ?? column + 2}
                  details={columns[column]}
                  left={
                    markerWidth +
                    pinnedWidth +
                    (scrollingOffsets[scrollingIndex] ?? 0)
                  }
                  pinned={false}
                />
              );
            })}
          </div>
        </div>
        <div
          ref={scrollportRef}
          className="viewda-grid-body-scrollport"
          onScroll={handleScroll}
        >
          <div
            className="viewda-grid-spacer"
            style={{ width: totalWidth, height: layout.physicalHeight }}
          />
          <div
            className="viewda-grid-visible-rows"
            style={{ width: totalWidth }}
          >
            {rows}
          </div>
        </div>
        <div
          ref={horizontalTrackRef}
          className="viewda-grid-horizontal-scrollport"
          aria-label="Horizontal grid scroll"
          hidden={!hasHorizontalOverflow}
          onScroll={handleHorizontalTrackScroll}
          style={{
            marginLeft: markerWidth + pinnedWidth,
            width: scrollingViewportWidth,
          }}
        >
          <div
            className="viewda-grid-horizontal-spacer"
            aria-hidden="true"
            style={{ width: scrollingWidth }}
          />
        </div>
      </div>
    );
  },
);

const GridRow = memo(function GridRow({
  instanceId,
  row,
  columns,
  pinnedIndices,
  visibleScrollingIndices,
  visibleScrollingStart,
  markerWidth,
  pinnedLeftByColumn,
  ariaColumnByColumn,
  physicalTop,
  selection,
  contentRevision,
  getCellContent,
  activeCell,
}: {
  instanceId: string;
  row: number;
  columns: readonly GridColumn[];
  pinnedIndices: readonly number[];
  visibleScrollingIndices: readonly number[];
  visibleScrollingStart: number;
  markerWidth: number;
  pinnedLeftByColumn: ReadonlyMap<number, number>;
  ariaColumnByColumn: ReadonlyMap<number, number>;
  physicalTop: number;
  selection: GridSelection;
  contentRevision: number;
  getCellContent(address: GridAddress): GridCell;
  activeCell?: GridAddress;
}) {
  return (
    <div
      className="viewda-grid-row"
      role="row"
      aria-rowindex={row + 2}
      style={{
        width: "100%",
        minWidth: "100%",
        transform: `translateY(${physicalTop}px)`,
      }}
    >
      <div
        className={`viewda-grid-row-marker${selection.rows.hasIndex(row) ? " is-selected" : ""}`}
        role="rowheader"
        aria-label={String(row + 1)}
        aria-rowindex={row + 2}
        aria-colindex={1}
        aria-selected={selection.rows.hasIndex(row)}
        data-grid-kind="row"
        data-row={row}
        style={{ width: markerWidth, left: 0 }}
      >
        {row + 1}
      </div>
      {pinnedIndices.map((column) => (
        <GridCellView
          key={columns[column]?.id}
          instanceId={instanceId}
          row={row}
          column={column}
          ariaColumnIndex={ariaColumnByColumn.get(column) ?? column + 2}
          details={columns[column]}
          getCellContent={getCellContent}
          selected={cellIsSelected(selection, row, column)}
          active={activeCell?.row === row && activeCell.column === column}
          pinnedLeft={pinnedLeftByColumn.get(column) ?? markerWidth}
          contentRevision={contentRevision}
        />
      ))}
      <div className="viewda-grid-row-scrolling-cells" role="presentation">
        <div
          className="viewda-grid-row-scroll-offset"
          aria-hidden="true"
          style={{ width: visibleScrollingStart }}
        />
        {visibleScrollingIndices.map((column) => (
          <GridCellView
            key={columns[column]?.id}
            instanceId={instanceId}
            row={row}
            column={column}
            ariaColumnIndex={ariaColumnByColumn.get(column) ?? column + 2}
            details={columns[column]}
            getCellContent={getCellContent}
            selected={cellIsSelected(selection, row, column)}
            active={activeCell?.row === row && activeCell.column === column}
            contentRevision={contentRevision}
          />
        ))}
      </div>
    </div>
  );
});

const GridCellView = memo(function GridCellView({
  instanceId,
  row,
  column,
  ariaColumnIndex,
  details,
  getCellContent,
  selected,
  active,
  pinnedLeft,
  contentRevision: _contentRevision,
}: {
  instanceId: string;
  row: number;
  column: number;
  ariaColumnIndex: number;
  details?: GridColumn;
  getCellContent(address: GridAddress): GridCell;
  selected: boolean;
  active: boolean;
  pinnedLeft?: number;
  contentRevision: number;
}) {
  // This prop participates in React.memo equality so a new data window
  // re-reads this bounded cell even when its address and provider are stable.
  void _contentRevision;
  const cell = getCellContent({ row, column });
  return (
    <div
      id={cellId(instanceId, { row, column })}
      className={[
        "viewda-grid-cell",
        details?.monospace ? "is-monospace" : "",
        cell.kind === "text" ? `is-${cell.alignment}` : "",
        cell.kind === "text" && cell.faded ? "is-faded" : "",
        cell.kind === "loading" ? "is-loading" : "",
        selected ? "is-selected" : "",
        active ? "is-active" : "",
        details?.pinned ? "is-pinned" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="gridcell"
      aria-rowindex={row + 2}
      aria-colindex={ariaColumnIndex}
      aria-selected={selected}
      aria-busy={cell.kind === "loading" || undefined}
      data-grid-kind="cell"
      data-row={row}
      data-column={column}
      style={
        pinnedLeft === undefined
          ? { width: details?.width ?? 0 }
          : {
              position: "sticky",
              left: pinnedLeft,
              zIndex: 2,
              width: details?.width ?? 0,
            }
      }
    >
      {cell.kind === "text" ? cell.displayData : ""}
    </div>
  );
});

function GridHeader({
  column,
  ariaColumnIndex,
  details,
  left,
  pinned,
}: {
  column: number;
  ariaColumnIndex: number;
  details?: GridColumn;
  left: number;
  pinned: boolean;
}) {
  if (details === undefined) {
    return null;
  }
  const sortLabel =
    details.sort.direction === "ascending"
      ? `${details.title} sorted ascending`
      : details.sort.direction === "descending"
        ? `${details.title} sorted descending`
        : `Sort ${details.title}`;
  return (
    <div
      className={`viewda-grid-column-header${pinned ? " is-pinned" : ""}${details.pending ? " is-pending" : ""}`}
      role="columnheader"
      aria-label={details.title}
      aria-colindex={ariaColumnIndex}
      aria-sort={
        details.sort.direction === "neutral" ? "none" : details.sort.direction
      }
      data-grid-kind="header"
      data-column={column}
      style={{ left, width: details.width }}
    >
      <button
        className={`viewda-grid-sort is-${details.sort.direction}`}
        type="button"
        tabIndex={-1}
        aria-label={sortLabel}
        data-grid-kind="header"
        data-action="sort"
        data-column={column}
      >
        <SortGlyph direction={details.sort.direction} />
        {details.sort.priority === undefined ? null : (
          <span className="viewda-grid-sort-priority">
            {details.sort.priority}
          </span>
        )}
      </button>
      <span className="viewda-grid-header-title">{details.title}</span>
      <button
        className="viewda-grid-filter"
        type="button"
        tabIndex={-1}
        aria-label={`Filter ${details.title}`}
        data-grid-kind="header"
        data-action="filter"
        data-column={column}
      >
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
          <path d="M1.5 2h9L7 6v3L5 10V6z" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <span
        className="viewda-grid-resize-handle"
        data-grid-kind="header"
        data-action="resize"
        data-column={column}
      />
    </div>
  );
}

function SortGlyph({
  direction,
}: {
  direction: GridColumn["sort"]["direction"];
}) {
  const path =
    direction === "ascending"
      ? "M3 5 6 2l3 3M6 2v8"
      : direction === "descending"
        ? "M3 7l3 3 3-3M6 2v8"
        : "M3 4 6 1.5 9 4M6 1.5v9M3 8l3 2.5L9 8";
  return (
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12">
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const browserMeasurementPort: GridMeasurementPort = {
  read(scrollport) {
    return {
      width: scrollport.clientWidth,
      height: scrollport.clientHeight,
      scrollTop: scrollport.scrollTop,
      scrollLeft: scrollport.scrollLeft,
      devicePixelRatio: window.devicePixelRatio,
    };
  },
  observe(element, onResize) {
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }
    const observer = new ResizeObserver(onResize);
    observer.observe(element);
    return () => observer.disconnect();
  },
  bounds(element) {
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  },
  probeScrollExtent() {
    const scrollport = document.createElement("div");
    const spacer = document.createElement("div");
    scrollport.style.cssText =
      "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;overflow:scroll;";
    spacer.style.width = `${OVERSIZED_PROBE_EXTENT}px`;
    spacer.style.height = `${OVERSIZED_PROBE_EXTENT}px`;
    scrollport.append(spacer);
    try {
      document.body.append(scrollport);
      return {
        vertical: reachableScrollExtent(
          scrollport,
          "scrollTop",
          "scrollHeight",
          "clientHeight",
        ),
        horizontal: reachableScrollExtent(
          scrollport,
          "scrollLeft",
          "scrollWidth",
          "clientWidth",
        ),
      };
    } finally {
      scrollport.remove();
    }
  },
};

type ScrollPosition = "scrollTop" | "scrollLeft";
type ScrollExtent = "scrollHeight" | "scrollWidth";
type ClientExtent = "clientHeight" | "clientWidth";

function reachableScrollExtent(
  scrollport: HTMLElement,
  position: ScrollPosition,
  extent: ScrollExtent,
  client: ClientExtent,
): number {
  const reportedExtent = scrollport[extent];
  const clientExtent = scrollport[client];
  scrollport[position] = OVERSIZED_PROBE_EXTENT;
  const oversizedReadback = scrollport[position];
  if (oversizedReadback > 0) {
    return boundedScrollExtent(reportedExtent, oversizedReadback, clientExtent);
  }

  let successfulAssignment = 0;
  let failedAssignment = 1;
  let reached = 0;
  while (failedAssignment < OVERSIZED_PROBE_EXTENT) {
    scrollport[position] = failedAssignment;
    const readback = scrollport[position];
    if (readback <= 0) {
      break;
    }
    reached = Math.max(reached, readback);
    if (readback < failedAssignment) {
      return boundedScrollExtent(reportedExtent, reached, clientExtent);
    }
    successfulAssignment = failedAssignment;
    failedAssignment = Math.min(OVERSIZED_PROBE_EXTENT, failedAssignment * 2);
  }

  while (failedAssignment - successfulAssignment > 1) {
    const candidate = Math.floor((successfulAssignment + failedAssignment) / 2);
    scrollport[position] = candidate;
    const readback = scrollport[position];
    if (readback > 0) {
      successfulAssignment = candidate;
      reached = Math.max(reached, readback);
    } else {
      failedAssignment = candidate;
    }
  }
  return boundedScrollExtent(reportedExtent, reached, clientExtent);
}

function boundedScrollExtent(
  reportedExtent: number,
  reachedPosition: number,
  clientExtent: number,
): number {
  return Math.max(
    clientExtent,
    Math.min(reportedExtent, reachedPosition + clientExtent),
  );
}

function cellId(instanceId: string, address: GridAddress): string {
  return `viewda-grid-${instanceId}-r${address.row}-c${address.column}`;
}

function parseIndex(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function sameScrollState(
  left: VerticalScrollState,
  right: VerticalScrollState,
): boolean {
  return (
    left.logicalTop === right.logicalTop &&
    left.physicalTop === right.physicalTop
  );
}

function positionsDiffer(left: number, right: number): boolean {
  return Math.abs(left - right) > Number.EPSILON;
}

function sameGeometry(
  left: GridSize & { devicePixelRatio: number },
  right: GridSize & { devicePixelRatio: number },
): boolean {
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.devicePixelRatio === right.devicePixelRatio
  );
}
