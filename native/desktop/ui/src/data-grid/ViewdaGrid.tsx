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
  hystereticRowAnchor,
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
import {
  gridDiagnosticsNoopSink,
  type GridDiagnosticsSink,
  type GridReactCommitSource,
  type GridWheelOutcome,
} from "./grid-performance-report";

// Small grids fit every supported webview, so probing below one million CSS
// pixels only adds layout work. Lower this if a supported webview clamps sooner.
const PROBE_TRIGGER_HEIGHT = 1_000_000;

// The probe writes an unreachable scroll position and reads the clamp back.
// This sentinel only needs to exceed every supported webview's native extent.
const OVERSIZED_PROBE_EXTENT = 1_000_000_000;

// Selection starts auto-scroll within two row heights of an edge. Small
// viewports cap the zone at one quarter of their height. Settings can offer slow
// and fast drag presets if users need control.
const DRAG_AUTO_SCROLL_EDGE = GRID_ROW_HEIGHT * 2;

const HORIZONTAL_SCROLLBAR_MIN_THUMB_WIDTH = 28;

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
  label?: string;
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
  onCellPeek?(
    address: GridAddress,
    bounds: Rectangle,
    behavior?: "toggle" | "open",
  ): void;
  onActiveCellBoundsChange?(address: GridAddress, bounds: Rectangle): void;
  onPeekFocus?(): void;
  onScrollInteraction?(): void;
  onCellActivate?(address: GridAddress): void;
  onCopy(event: ClipboardEvent): void;
  onHorizontalExtentChange(
    exceeded: boolean,
    totalWidth: number,
    safeExtent: number,
  ): void;
  onEscape?(): void;
  measurementPort?: GridMeasurementPort;
  diagnostics?: GridDiagnosticsSink;
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
  moved: boolean;
  additive: boolean;
  clientX: number;
  clientY: number;
}

interface HorizontalScrollbarDrag {
  pointerId: number;
  captureTarget: HTMLElement;
  grabRatio: number;
}

interface HorizontalThumbGeometry {
  left: number;
  width: number;
  travel: number;
  maximumScrollLeft: number;
}

function horizontalThumbGeometry(
  trackWidth: number,
  viewportWidth: number,
  contentWidth: number,
  scrollLeft: number,
): HorizontalThumbGeometry {
  const safeTrackWidth = Math.max(0, trackWidth);
  const maximumScrollLeft = Math.max(0, contentWidth - viewportWidth);
  const width = Math.min(
    safeTrackWidth,
    Math.max(
      HORIZONTAL_SCROLLBAR_MIN_THUMB_WIDTH,
      contentWidth > 0
        ? (safeTrackWidth * viewportWidth) / contentWidth
        : safeTrackWidth,
    ),
  );
  const travel = Math.max(0, safeTrackWidth - width);
  const clampedScrollLeft = Math.max(
    0,
    Math.min(maximumScrollLeft, scrollLeft),
  );
  return {
    left:
      maximumScrollLeft > 0
        ? (clampedScrollLeft / maximumScrollLeft) * travel
        : 0,
    width,
    travel,
    maximumScrollLeft,
  };
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

/**
 * Browser-coupled rendering and input boundary for the Data view.
 *
 * Logical vertical coordinates remain authoritative for wheel, keyboard, and
 * programmatic navigation. The browser owns physical coordinates only when a
 * user moves the native thumb; read-back of our own write must not replace the
 * logical position in compressed mode. Horizontally, the body scrollport owns
 * `scrollLeft`; the visible scrollbar and header mirror that value immediately.
 * Scroll and ResizeObserver notifications share one measurement rAF so each
 * frame reads one coherent geometry snapshot before publishing React state.
 */
export const ViewdaGrid = forwardRef<ViewdaGridHandle, ViewdaGridProps>(
  function ViewdaGrid(
    {
      label = "Data grid",
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
      onCellPeek,
      onActiveCellBoundsChange,
      onPeekFocus,
      onScrollInteraction,
      onCellActivate,
      onCopy,
      onHorizontalExtentChange,
      onEscape,
      measurementPort = browserMeasurementPort,
      diagnostics = gridDiagnosticsNoopSink,
    },
    forwardedRef,
  ) {
    const instanceId = useId().replaceAll(":", "");
    const rootRef = useRef<HTMLDivElement>(null);
    const scrollportRef = useRef<HTMLDivElement>(null);
    const horizontalScrollbarRef = useRef<HTMLDivElement>(null);
    const horizontalTrackRef = useRef<HTMLDivElement>(null);
    const horizontalThumbRef = useRef<HTMLDivElement>(null);
    const scrollingHeadersRef = useRef<HTMLDivElement>(null);
    const resizeGestureRef = useRef<ResizeGesture | null>(null);
    const selectionDragRef = useRef<SelectionDrag | null>(null);
    const horizontalScrollbarDragRef = useRef<HorizontalScrollbarDrag | null>(
      null,
    );
    const autoScrollFrameRef = useRef<number | null>(null);
    const suppressClickRef = useRef(false);
    // Distinguishes quantized read-back of our logical command from external
    // physical input such as a compressed scrollbar-thumb drag.
    const expectedPhysicalTopRef = useRef<number | null>(null);
    const pendingPhysicalScrollRef = useRef<{
      physicalTop: number;
      ownWrite: boolean;
    } | null>(null);
    const pendingHorizontalScrollLeftRef = useRef<number | null>(null);
    const hiddenScrollportRef = useRef(false);
    const horizontalScrollLeftRef = useRef(0);
    const wheelGestureRef = useRef<WheelGestureState | null>(null);
    const frameRef = useRef<number | null>(null);
    const diagnosticFrameRefs = useRef<{
      input: Set<number>;
      measurement: Set<number>;
    }>({ input: new Set(), measurement: new Set() });
    const diagnosticAnimationFramesRef = useRef(new Set<number>());
    const recordCurrentGridSnapshotRef = useRef<
      (
        geometry: GridSize & { devicePixelRatio: number },
        frameId?: number | null,
        columnWindow?: ColumnWindow,
      ) => void
    >(() => undefined);
    const publishViewportRef = useRef<
      (
        logicalTop: number,
        viewportHeight: number,
        columnWindow: ColumnWindow,
      ) => void
    >(() => undefined);
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
    const geometryRef = useRef(geometry);
    const [mountedColumnRange, setMountedColumnRange] = useState<
      ColumnWindow["mounted"] | null
    >(null);
    const columnWindowRef = useRef<ColumnWindow | null>(null);
    const [rowAnchor, setRowAnchor] = useState<number | null>(null);
    const [pendingPeek, setPendingPeek] = useState<GridAddress | null>(null);
    useEffect(() => {
      const active = selection.current?.cell;
      if (
        pendingPeek !== null &&
        (active === undefined ||
          active.row !== pendingPeek.row ||
          active.column !== pendingPeek.column)
      ) {
        setPendingPeek(null);
      }
    }, [pendingPeek, selection.current?.cell]);
    const rowAnchorRef = useRef<number | null>(null);
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
        return false;
      }
      scrollStateRef.current = next;
      setScrollState(next);
      return true;
    }, []);

    const commitGeometry = useCallback(
      (next: GridSize & { devicePixelRatio: number }) => {
        if (sameGeometry(geometryRef.current, next)) {
          return false;
        }
        geometryRef.current = next;
        setGeometry(next);
        return true;
      },
      [],
    );

    const commitColumnWindow = useCallback((next: ColumnWindow) => {
      const mountedChanged = !sameRange(
        columnWindowRef.current?.mounted ?? null,
        next.mounted,
      );
      columnWindowRef.current = next;
      if (mountedChanged) setMountedColumnRange(next.mounted);
      return mountedChanged;
    }, []);

    const commitRowAnchor = useCallback(
      (logicalTop: number, viewportHeight: number) => {
        const mounted = visibleRowRange(
          logicalTop,
          viewportHeight,
          GRID_ROW_HEIGHT,
          rowCount,
          GRID_OVERSCAN_ROWS,
        );
        const next = hystereticRowAnchor(mounted, rowAnchorRef.current);
        if (rowAnchorRef.current === next) return false;
        rowAnchorRef.current = next;
        setRowAnchor(next);
        return true;
      },
      [rowCount],
    );

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

    const syncHorizontalScroll = useCallback(
      (requestedLeft?: number, liveViewportWidth?: number) => {
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
        if (requestedLeft !== undefined) {
          horizontalScrollLeftRef.current = actualLeft;
        }
        // Browser-clamped body scrollLeft is authoritative. Mirror it before the
        // measurement rAF so header, cells, and the exposed track move together.
        if (!samePosition(horizontalTrack.scrollLeft, actualLeft)) {
          horizontalTrack.scrollLeft = actualLeft;
        }
        const horizontalScrollbar = horizontalScrollbarRef.current;
        const horizontalThumb = horizontalThumbRef.current;
        if (horizontalScrollbar !== null && horizontalThumb !== null) {
          const viewportWidth =
            liveViewportWidth ??
            Math.max(0, geometryRef.current.width - markerWidth - pinnedWidth);
          const trackWidth = horizontalScrollbar.clientWidth || viewportWidth;
          const thumb = horizontalThumbGeometry(
            trackWidth,
            viewportWidth,
            scrollingWidth,
            actualLeft,
          );
          horizontalThumb.style.width = `${thumb.width}px`;
          horizontalThumb.style.transform = `translateX(${thumb.left}px)`;
          horizontalScrollbar.setAttribute(
            "aria-valuemax",
            String(Math.round(thumb.maximumScrollLeft)),
          );
          horizontalScrollbar.setAttribute(
            "aria-valuenow",
            String(Math.round(actualLeft)),
          );
        }
        const scrollingHeaders = scrollingHeadersRef.current;
        if (scrollingHeaders !== null) {
          const transform = `translateX(${-actualLeft}px)`;
          if (scrollingHeaders.style.transform !== transform) {
            scrollingHeaders.style.transform = transform;
          }
        }
        return actualLeft;
      },
      [markerWidth, pinnedWidth, scrollingWidth],
    );

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
      frameRef.current = window.requestAnimationFrame((timeStamp) => {
        frameRef.current = null;
        const diagnosticFrame = diagnostics.measurementStart(timeStamp);
        const scrollport = scrollportRef.current;
        const horizontalTrack = horizontalTrackRef.current;
        let reactWorkScheduled = false;
        if (scrollport !== null && horizontalTrack !== null) {
          const read = measurementPort.read(scrollport);
          const expected = expectedPhysicalTopRef.current;
          const ownWrite =
            expected !== null && samePosition(expected, read.scrollTop);
          expectedPhysicalTopRef.current = null;
          const pendingPhysicalScroll = pendingPhysicalScrollRef.current;
          pendingPhysicalScrollRef.current = null;
          const pendingHorizontalScrollLeft =
            pendingHorizontalScrollLeftRef.current;
          pendingHorizontalScrollLeftRef.current = null;
          // A grid inside a `hidden` panel has no scroll box: the browser reports
          // a zero viewport and drops scrollTop. The retained position stays
          // authoritative across the hidden phase and is written back on return,
          // so switching panels keeps the reader on the same rows.
          const hidden = read.width === 0 || read.height === 0;
          const restored = !hidden && hiddenScrollportRef.current;
          hiddenScrollportRef.current = hidden;
          const scrollLeft = hidden
            ? (pendingHorizontalScrollLeft ?? horizontalScrollLeftRef.current)
            : (syncHorizontalScroll(
                restored ? horizontalScrollLeftRef.current : read.scrollLeft,
              ) ?? read.scrollLeft);
          if (!hidden || pendingHorizontalScrollLeft !== null) {
            horizontalScrollLeftRef.current = scrollLeft;
          }
          const next =
            pendingPhysicalScroll !== null
              ? applyPhysicalScroll(
                  scrollStateRef.current,
                  pendingPhysicalScroll.physicalTop,
                  layout,
                  pendingPhysicalScroll.ownWrite,
                )
              : hidden || restored || expected === null
                ? scrollStateRef.current
                : applyPhysicalScroll(
                    scrollStateRef.current,
                    read.scrollTop,
                    layout,
                    ownWrite,
                  );
          if (restored) {
            writePhysicalTop(next.physicalTop);
          }
          reactWorkScheduled = commitScrollState(next);
          reactWorkScheduled =
            commitGeometry({
              width: read.width,
              height: read.height,
              devicePixelRatio: read.devicePixelRatio,
            }) || reactWorkScheduled;
          reactWorkScheduled =
            commitRowAnchor(next.logicalTop, read.height) || reactWorkScheduled;
          const previousColumnWindow = columnWindowRef.current;
          const nextColumnWindow = hystereticColumnWindow(
            scrollingOffsets,
            scrollLeft,
            Math.max(0, read.width - markerWidth - pinnedWidth),
            GRID_OVERSCAN_COLUMNS,
            previousColumnWindow,
          );
          const visibleColumnChanged = !sameRange(
            previousColumnWindow?.visible ?? null,
            nextColumnWindow.visible,
          );
          const mountedColumnChanged = commitColumnWindow(nextColumnWindow);
          reactWorkScheduled = mountedColumnChanged || reactWorkScheduled;
          if (visibleColumnChanged && !mountedColumnChanged) {
            publishViewportRef.current(
              next.logicalTop,
              read.height,
              nextColumnWindow,
            );
          }
          if (diagnosticFrame !== null && !reactWorkScheduled) {
            recordCurrentGridSnapshotRef.current(
              read,
              diagnosticFrame,
              nextColumnWindow,
            );
          }
        }
        if (diagnosticFrame !== null) {
          if (reactWorkScheduled && diagnosticFrame !== null) {
            diagnosticFrameRefs.current.measurement.add(diagnosticFrame);
          }
          diagnostics.measurementEnd(
            diagnosticFrame,
            performance.now(),
            reactWorkScheduled ||
              (diagnosticFrame !== null &&
                diagnosticFrameRefs.current.input.has(diagnosticFrame)),
          );
        }
      });
    }, [
      commitScrollState,
      commitColumnWindow,
      commitGeometry,
      commitRowAnchor,
      diagnostics,
      layout,
      markerWidth,
      measurementPort,
      pinnedWidth,
      scrollingOffsets,
      syncHorizontalScroll,
      writePhysicalTop,
    ]);

    useLayoutEffect(() => {
      const scrollport = scrollportRef.current;
      const horizontalTrack = horizontalTrackRef.current;
      if (scrollport === null || horizontalTrack === null) {
        return;
      }
      syncHorizontalScroll();
      const read = measurementPort.read(scrollport);
      commitGeometry({
        width: read.width,
        height: read.height,
        devicePixelRatio: read.devicePixelRatio,
      });
      commitRowAnchor(scrollStateRef.current.logicalTop, read.height);
      commitColumnWindow(
        hystereticColumnWindow(
          scrollingOffsets,
          read.scrollLeft,
          Math.max(0, read.width - markerWidth - pinnedWidth),
          GRID_OVERSCAN_COLUMNS,
          columnWindowRef.current,
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
      commitColumnWindow,
      commitGeometry,
      commitRowAnchor,
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
    useLayoutEffect(() => {
      syncHorizontalScroll();
    }, [scrollingViewportWidth, scrollingWidth, syncHorizontalScroll]);
    const initialColumnWindow = hystereticColumnWindow(
      scrollingOffsets,
      0,
      scrollingViewportWidth,
      GRID_OVERSCAN_COLUMNS,
      null,
    );
    const renderedScrollingRange =
      mountedColumnRange ?? initialColumnWindow.mounted;
    const visibleScrollingRange =
      columnWindowRef.current?.visible ?? initialColumnWindow.visible;
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
    const renderedColumnIndices = useMemo(
      () => [...pinnedIndices, ...visibleScrollingIndices],
      [pinnedIndices, visibleScrollingIndices],
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
    const coordinateRowAnchor = hystereticRowAnchor(renderedRows, rowAnchor);

    const publishViewport = useCallback(
      (
        logicalTop: number,
        viewportHeight: number,
        nextColumnWindow: ColumnWindow,
      ) => {
        const nextVisibleRows = visibleRowRange(
          logicalTop,
          viewportHeight,
          GRID_ROW_HEIGHT,
          rowCount,
          0,
        );
        const nextMountedRows = visibleRowRange(
          logicalTop,
          viewportHeight,
          GRID_ROW_HEIGHT,
          rowCount,
          GRID_OVERSCAN_ROWS,
        );
        onViewportChangeRef.current({
          rowStart: nextVisibleRows.start,
          rowCount: nextVisibleRows.end - nextVisibleRows.start,
          columnIndices: [
            ...pinnedIndices,
            ...scrollingIndices.slice(
              nextColumnWindow.visible.start,
              nextColumnWindow.visible.end,
            ),
          ],
          mountedRowStart: nextMountedRows.start,
          mountedRowCount: nextMountedRows.end - nextMountedRows.start,
          mountedColumnIndices: [
            ...pinnedIndices,
            ...scrollingIndices.slice(
              nextColumnWindow.mounted.start,
              nextColumnWindow.mounted.end,
            ),
          ],
        });
      },
      [pinnedIndices, rowCount, scrollingIndices],
    );
    useLayoutEffect(() => {
      publishViewportRef.current = publishViewport;
    }, [publishViewport]);

    const recordCurrentGridSnapshot = useCallback(
      (
        snapshotGeometry: GridSize & { devicePixelRatio: number },
        frameId: number | null = null,
        snapshotColumnWindow?: ColumnWindow,
      ) => {
        // Snapshot construction includes a bounded DOM count. Keep it entirely
        // outside the normal scroll path when no recording consumes it.
        if (!diagnostics.isEnabled()) {
          return;
        }
        const measuredColumnWindow = snapshotColumnWindow ?? {
          visible: visibleScrollingRange,
          mounted: renderedScrollingRange,
        };
        diagnostics.configure({
          viewportWidth: snapshotGeometry.width,
          viewportHeight: snapshotGeometry.height,
          devicePixelRatio: snapshotGeometry.devicePixelRatio,
          verticalMode: deriveVerticalLayout(
            rowCount,
            GRID_ROW_HEIGHT,
            snapshotGeometry.height,
            extent.vertical,
          ).mode,
          rowHeight: GRID_ROW_HEIGHT,
          rowCount,
          columnCount: columns.length,
          pinnedColumnCount: pinnedIndices.length,
        });
        diagnostics.viewport(frameId, {
          visibleRowStart: visibleRows.start,
          visibleRowCount: visibleRows.end - visibleRows.start,
          visibleScrollingColumnStart: measuredColumnWindow.visible.start,
          visibleScrollingColumnCount:
            measuredColumnWindow.visible.end -
            measuredColumnWindow.visible.start,
          mountedRowStart: renderedRows.start,
          mountedRowCount: renderedRows.end - renderedRows.start,
          mountedScrollingColumnStart: measuredColumnWindow.mounted.start,
          mountedScrollingColumnCount:
            measuredColumnWindow.mounted.end -
            measuredColumnWindow.mounted.start,
          renderedColumnCount: renderedColumnIndices.length,
          renderedCellCount:
            rootRef.current?.querySelectorAll(".viewda-grid-cell").length ?? 0,
        });
      },
      [
        columns.length,
        diagnostics,
        extent.vertical,
        pinnedIndices.length,
        renderedColumnIndices.length,
        renderedRows.end,
        renderedRows.start,
        renderedScrollingRange.end,
        renderedScrollingRange.start,
        rowCount,
        visibleRows.end,
        visibleRows.start,
        visibleScrollingRange.end,
        visibleScrollingRange.start,
      ],
    );
    useLayoutEffect(() => {
      recordCurrentGridSnapshotRef.current = recordCurrentGridSnapshot;
    }, [recordCurrentGridSnapshot]);

    useLayoutEffect(() => {
      const frames = diagnosticFrameRefs.current;
      if (frames.input.size === 0 && frames.measurement.size === 0) {
        return;
      }
      if (!diagnostics.isEnabled()) {
        frames.input.clear();
        frames.measurement.clear();
        return;
      }
      // Frame ids bridge input/measurement callbacks to the React commit that
      // they scheduled. The following rAF is an observable boundary, not a
      // claim that the browser has painted the frame.
      const measurementFrames = new Set(frames.measurement);
      const pending = new Set([...frames.input, ...frames.measurement]);
      frames.input.clear();
      frames.measurement.clear();
      if (pending.size === 0) {
        return;
      }
      const committedAt = performance.now();
      let primaryFrame: number | null = null;
      for (const frame of pending) {
        if (primaryFrame === null || frame > primaryFrame) primaryFrame = frame;
      }
      let commitToken: number | null = null;
      for (const frame of pending) {
        const source: GridReactCommitSource = measurementFrames.has(frame)
          ? "measurement"
          : "input";
        const token = diagnostics.reactCommit(
          frame,
          committedAt,
          source,
          frame === primaryFrame,
        );
        if (frame === primaryFrame) commitToken = token;
      }
      recordCurrentGridSnapshotRef.current(geometryRef.current, primaryFrame);
      if (commitToken !== null) {
        const animationFrame = window.requestAnimationFrame((timeStamp) => {
          diagnosticAnimationFramesRef.current.delete(animationFrame);
          diagnostics.nextAnimationFrame(commitToken, timeStamp);
        });
        diagnosticAnimationFramesRef.current.add(animationFrame);
      }
    });

    useEffect(
      () => () => {
        for (const animationFrame of diagnosticAnimationFramesRef.current) {
          window.cancelAnimationFrame(animationFrame);
        }
        diagnosticAnimationFramesRef.current.clear();
      },
      [],
    );

    useEffect(() => {
      publishViewport(effectiveScrollState.logicalTop, geometry.height, {
        visible: visibleScrollingRange,
        mounted: renderedScrollingRange,
      });
      recordCurrentGridSnapshot(geometry);
    }, [
      effectiveScrollState.logicalTop,
      geometry,
      publishViewport,
      recordCurrentGridSnapshot,
      renderedScrollingRange,
      visibleScrollingRange,
    ]);

    const applyLogicalDelta = useCallback(
      (delta: number) => {
        const current = scrollStateRef.current;
        const next = applyLogicalScroll(current, delta, layout);
        if (!positionsDiffer(current.logicalTop, next.logicalTop)) {
          return false;
        }
        commitRowAnchor(next.logicalTop, geometryRef.current.height);
        commitScrollState(next);
        writePhysicalTop(next.physicalTop);
        scheduleMeasurement();
        return true;
      },
      [
        commitRowAnchor,
        commitScrollState,
        layout,
        scheduleMeasurement,
        writePhysicalTop,
      ],
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
        const diagnosticWheelStartedAt = diagnostics.startWheel();
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
        onScrollInteraction?.();
        const advance = advanceWheelGesture(
          wheelGestureRef.current,
          horizontalDelta,
          verticalDelta,
          event.timeStamp,
          GRID_ROW_HEIGHT,
        );
        const decision = advance.state.axis ?? "ambiguous";
        let appliedHorizontalPixels = 0;
        let verticalTarget: number | null = null;
        let outcome: GridWheelOutcome | null = null;
        const logicalTopAtStart = scrollStateRef.current.logicalTop;
        const dominantVerticalBlocked =
          Math.abs(verticalDelta) >= Math.abs(horizontalDelta) &&
          verticalDelta !== 0 &&
          (layout.logicalMax <= 0 ||
            (verticalDelta < 0
              ? logicalTopAtStart <= 0
              : logicalTopAtStart >= layout.logicalMax));
        if (!dominantVerticalBlocked && advance.horizontalDelta !== 0) {
          const previousLeft = scrollport.scrollLeft;
          const actualLeft = syncHorizontalScroll(
            previousLeft + advance.horizontalDelta,
          );
          if (actualLeft !== null && previousLeft !== actualLeft) {
            appliedHorizontalPixels = actualLeft - previousLeft;
            scheduleMeasurement();
          }
        }
        if (dominantVerticalBlocked) {
          outcome =
            layout.logicalMax <= 0
              ? "noScrollableExtent"
              : verticalDelta < 0
                ? "atStartBoundary"
                : "atEndBoundary";
        } else if (decision === "horizontal") {
          if (advance.horizontalDelta === 0) {
            outcome = "axisLockedNoise";
          } else if (scrollingWidth <= scrollingViewportWidth) {
            outcome = "noScrollableExtent";
          } else if (appliedHorizontalPixels !== 0) {
            outcome = "appliedMovement";
          } else {
            outcome =
              advance.horizontalDelta < 0 ? "atStartBoundary" : "atEndBoundary";
          }
        } else if (decision === "vertical") {
          const logicalTop = scrollStateRef.current.logicalTop;
          verticalTarget = logicalTopAfterRowSteps(
            logicalTop,
            advance.rowSteps,
            GRID_ROW_HEIGHT,
            layout.logicalMax,
          );
          if (verticalDelta === 0) {
            outcome = "axisLockedNoise";
          } else if (layout.logicalMax <= 0) {
            outcome = "noScrollableExtent";
          } else if (advance.rowSteps === 0) {
            outcome = "accumulatingWholeRow";
          } else if (positionsDiffer(logicalTop, verticalTarget)) {
            outcome = "appliedMovement";
          } else {
            outcome =
              advance.rowSteps < 0 ? "atStartBoundary" : "atEndBoundary";
          }
        }
        const requestedVerticalPixels =
          decision === "vertical"
            ? advance.rowSteps * GRID_ROW_HEIGHT +
              advance.state.verticalRemainder
            : 0;
        const boundaryTarget =
          verticalDelta > 0 &&
          requestedVerticalPixels > 0 &&
          requestedVerticalPixels >= layout.logicalMax - logicalTopAtStart
            ? layout.logicalMax
            : verticalDelta < 0 &&
                requestedVerticalPixels < 0 &&
                -requestedVerticalPixels >= logicalTopAtStart
              ? 0
              : null;
        if (boundaryTarget !== null && layout.logicalMax > 0) {
          verticalTarget = boundaryTarget;
          outcome = positionsDiffer(logicalTopAtStart, boundaryTarget)
            ? "appliedMovement"
            : requestedVerticalPixels < 0
              ? "atStartBoundary"
              : "atEndBoundary";
        }
        const appliedVerticalRowSteps =
          outcome === "appliedMovement" && verticalTarget !== null
            ? (verticalTarget - scrollStateRef.current.logicalTop) /
              GRID_ROW_HEIGHT
            : 0;
        const verticalRemainder =
          boundaryTarget === null
            ? 0
            : requestedVerticalPixels -
              appliedVerticalRowSteps * GRID_ROW_HEIGHT;
        // Native default cannot route a header-originated wheel through the
        // body scrollport, so boundary remainder is forwarded deliberately.
        const forwardedVerticalPixels = scrollVerticalAncestors(
          root,
          verticalRemainder,
        );
        const logicalTop = scrollStateRef.current.logicalTop;
        const canMoveVertically =
          verticalDelta < 0
            ? logicalTop > 0
            : verticalDelta > 0
              ? logicalTop < layout.logicalMax
              : false;
        const horizontalMax = Math.max(
          0,
          scrollingWidth - scrollingViewportWidth,
        );
        const canMoveHorizontally =
          horizontalDelta < 0
            ? scrollport.scrollLeft > 0
            : horizontalDelta > 0
              ? scrollport.scrollLeft < horizontalMax
              : false;
        const shouldConsume =
          forwardedVerticalPixels !== 0 ||
          (!dominantVerticalBlocked &&
            (outcome === "appliedMovement" ||
              (decision === "vertical" &&
                outcome === "accumulatingWholeRow" &&
                canMoveVertically) ||
              (decision === "ambiguous" &&
                (canMoveVertically || canMoveHorizontally))));
        if (shouldConsume) {
          event.preventDefault();
        }
        const consumed = event.defaultPrevented;
        wheelGestureRef.current =
          consumed && boundaryTarget === null ? advance.state : null;
        if (
          decision === "vertical" &&
          outcome === "appliedMovement" &&
          verticalTarget !== null
        ) {
          const logicalTop = scrollStateRef.current.logicalTop;
          applyLogicalDelta(verticalTarget - logicalTop);
        }
        if (diagnosticWheelStartedAt !== null) {
          const diagnosticFrame = diagnostics.wheel(diagnosticWheelStartedAt, {
            timeStamp: event.timeStamp,
            decision,
            consumed,
            takeover: advance.takeover,
            requestedHorizontalPixels:
              decision === "horizontal" ? advance.horizontalDelta : 0,
            appliedHorizontalPixels,
            requestedVerticalPixels:
              decision === "vertical" ? verticalDelta : 0,
            appliedVerticalRowSteps,
            outcome,
          });
          if (
            decision === "vertical" &&
            outcome === "appliedMovement" &&
            diagnosticFrame !== null
          ) {
            diagnosticFrameRefs.current.input.add(diagnosticFrame);
          }
        }
      };
      root.addEventListener("wheel", handleWheel, { passive: false });
      return () => root.removeEventListener("wheel", handleWheel);
    }, [
      applyLogicalDelta,
      diagnostics,
      layout.logicalMax,
      onScrollInteraction,
      geometry.height,
      geometry.width,
      scheduleMeasurement,
      scrollingViewportWidth,
      scrollingWidth,
      syncHorizontalScroll,
    ]);

    const handleScroll = useCallback(() => {
      const scrollport = scrollportRef.current;
      if (scrollport === null) {
        return;
      }
      if (scrollport.closest("[hidden]") !== null) {
        scheduleMeasurement();
        return;
      }
      const expected = expectedPhysicalTopRef.current;
      const physicalTop = scrollport.scrollTop;
      pendingPhysicalScrollRef.current =
        expected !== null ||
        positionsDiffer(scrollStateRef.current.physicalTop, physicalTop)
          ? {
              physicalTop,
              ownWrite:
                expected !== null && samePosition(expected, physicalTop),
            }
          : null;
      const actualLeft = syncHorizontalScroll();
      if (actualLeft !== null) {
        pendingHorizontalScrollLeftRef.current = actualLeft;
      }
      scheduleMeasurement();
    }, [scheduleMeasurement, syncHorizontalScroll]);

    const handleHorizontalTrackScroll = useCallback(() => {
      const scrollport = scrollportRef.current;
      const horizontalTrack = horizontalTrackRef.current;
      if (scrollport === null || horizontalTrack === null) {
        return;
      }
      if (horizontalTrack.closest("[hidden]") !== null) {
        scheduleMeasurement();
        return;
      }
      const previousLeft = scrollport.scrollLeft;
      const actualLeft = syncHorizontalScroll(horizontalTrack.scrollLeft);
      if (actualLeft !== null && positionsDiffer(previousLeft, actualLeft)) {
        scheduleMeasurement();
      }
    }, [scheduleMeasurement, syncHorizontalScroll]);

    const scrollFromHorizontalScrollbar = useCallback(
      (scrollLeft: number, viewportWidth = scrollingViewportWidth) => {
        const scrollport = scrollportRef.current;
        if (scrollport === null) {
          return;
        }
        const maximumScrollLeft = Math.max(0, scrollingWidth - viewportWidth);
        const previousLeft = scrollport.scrollLeft;
        const actualLeft = syncHorizontalScroll(
          Math.max(0, Math.min(maximumScrollLeft, scrollLeft)),
          viewportWidth,
        );
        if (actualLeft !== null && positionsDiffer(previousLeft, actualLeft)) {
          scheduleMeasurement();
        }
      },
      [
        scheduleMeasurement,
        scrollingViewportWidth,
        scrollingWidth,
        syncHorizontalScroll,
      ],
    );

    const finishHorizontalScrollbarDrag = useCallback((pointerId?: number) => {
      const drag = horizontalScrollbarDragRef.current;
      if (
        drag === null ||
        (pointerId !== undefined && pointerId !== drag.pointerId)
      ) {
        return;
      }
      horizontalScrollbarDragRef.current = null;
      drag.captureTarget.removeAttribute("data-dragging");
      if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
        drag.captureTarget.releasePointerCapture(drag.pointerId);
      }
    }, []);

    const handleHorizontalScrollbarPointerDown = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        if (event.button !== 0 || horizontalScrollbarDragRef.current !== null) {
          return;
        }
        const scrollport = scrollportRef.current;
        if (scrollport === null) {
          return;
        }
        const captureTarget = event.currentTarget;
        const bounds = measurementPort.bounds(captureTarget);
        const thumb = horizontalThumbGeometry(
          bounds.width,
          bounds.width,
          scrollingWidth,
          scrollport.scrollLeft,
        );
        if (thumb.maximumScrollLeft <= 0 || thumb.travel <= 0) {
          return;
        }
        onScrollInteraction?.();
        event.preventDefault();
        event.stopPropagation();
        captureTarget.focus();
        captureTarget.setPointerCapture(event.pointerId);
        captureTarget.setAttribute("data-dragging", "true");
        const pointerPosition = Math.max(
          0,
          Math.min(bounds.width, event.clientX - bounds.x),
        );
        const grabbedThumb =
          pointerPosition >= thumb.left &&
          pointerPosition <= thumb.left + thumb.width;
        const grabRatio = grabbedThumb
          ? (pointerPosition - thumb.left) / thumb.width
          : 0.5;
        horizontalScrollbarDragRef.current = {
          pointerId: event.pointerId,
          captureTarget,
          grabRatio,
        };
        if (!grabbedThumb) {
          scrollFromHorizontalScrollbar(
            ((pointerPosition - thumb.width * grabRatio) / thumb.travel) *
              thumb.maximumScrollLeft,
            bounds.width,
          );
        }
      },
      [
        measurementPort,
        onScrollInteraction,
        scrollFromHorizontalScrollbar,
        scrollingWidth,
      ],
    );

    const handleHorizontalScrollbarPointerMove = useCallback(
      (event: ReactPointerEvent<HTMLDivElement>) => {
        const drag = horizontalScrollbarDragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) {
          return;
        }
        const scrollport = scrollportRef.current;
        if (scrollport === null) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const bounds = measurementPort.bounds(drag.captureTarget);
        const thumb = horizontalThumbGeometry(
          bounds.width,
          bounds.width,
          scrollingWidth,
          scrollport.scrollLeft,
        );
        if (thumb.maximumScrollLeft <= 0 || thumb.travel <= 0) {
          return;
        }
        const thumbLeft = Math.max(
          0,
          Math.min(
            thumb.travel,
            event.clientX - bounds.x - thumb.width * drag.grabRatio,
          ),
        );
        scrollFromHorizontalScrollbar(
          (thumbLeft / thumb.travel) * thumb.maximumScrollLeft,
          bounds.width,
        );
      },
      [measurementPort, scrollFromHorizontalScrollbar, scrollingWidth],
    );

    const handleHorizontalScrollbarKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        const scrollport = scrollportRef.current;
        if (scrollport === null) {
          return;
        }
        const maximumScrollLeft = Math.max(
          0,
          scrollingWidth - scrollingViewportWidth,
        );
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        let target: number;
        if (event.key === "ArrowLeft") {
          target = scrollport.scrollLeft - GRID_ROW_HEIGHT;
        } else if (event.key === "ArrowRight") {
          target = scrollport.scrollLeft + GRID_ROW_HEIGHT;
        } else if (event.key === "PageUp") {
          target = scrollport.scrollLeft - scrollingViewportWidth;
        } else if (event.key === "PageDown") {
          target = scrollport.scrollLeft + scrollingViewportWidth;
        } else if (event.key === "Home") {
          target = 0;
        } else if (event.key === "End") {
          target = maximumScrollLeft;
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        onScrollInteraction?.();
        scrollFromHorizontalScrollbar(target);
      },
      [
        onScrollInteraction,
        scrollFromHorizontalScrollbar,
        scrollingViewportWidth,
        scrollingWidth,
      ],
    );

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
        commitRowAnchor(next.logicalTop, geometryRef.current.height);
        commitScrollState(next);
        writePhysicalTop(next.physicalTop);
        scheduleMeasurement();
      },
      [
        commitRowAnchor,
        commitScrollState,
        layout,
        scheduleMeasurement,
        writePhysicalTop,
      ],
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

    useLayoutEffect(() => {
      if (pendingPeek === null) return;
      const active = selection.current?.cell;
      if (
        active === undefined ||
        active.row !== pendingPeek.row ||
        active.column !== pendingPeek.column
      ) {
        setPendingPeek(null);
        return;
      }
      const cell = rootRef.current?.querySelector<HTMLElement>(
        `[data-grid-kind="cell"][data-row="${pendingPeek.row}"][data-column="${pendingPeek.column}"]`,
      );
      if (cell === undefined || cell === null) return;
      setPendingPeek(null);
      onCellPeek?.(pendingPeek, measurementPort.bounds(cell));
    }, [
      contentRevision,
      measurementPort,
      onCellPeek,
      pendingPeek,
      selection.current?.cell,
      scrollState,
    ]);

    const updateCellSelection = useCallback(
      (cell: GridAddress, extend: boolean, additive: boolean) => {
        const next = selectCell(selection, cell, extend, additive);
        onSelectionChange(next);
        ensureCellVisible(cell);
      },
      [ensureCellVisible, onSelectionChange, selection],
    );

    const activateCell = useCallback(
      (address: GridAddress) => {
        const focusBeforeActivation = document.activeElement;
        onCellActivate?.(address);
        const focusAfterActivation = document.activeElement;
        const callbackMovedFocus =
          focusAfterActivation !== focusBeforeActivation &&
          focusAfterActivation !== document.body &&
          focusAfterActivation !== document.documentElement &&
          focusAfterActivation?.isConnected === true;
        if (!callbackMovedFocus) rootRef.current?.focus();
      },
      [onCellActivate],
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
        if (
          target.dataset.action === "sort" &&
          column !== null &&
          columns[column]?.sortable === true
        ) {
          onSort(column, additive || event.shiftKey);
          rootRef.current?.focus();
          return;
        }
        if (
          target.dataset.action === "filter" &&
          column !== null &&
          columns[column]?.filterable === true
        ) {
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
          if (onCellActivate !== undefined) {
            activateCell({ column, row });
            return;
          }
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
        activateCell,
        columns,
        measurementPort,
        onFilter,
        onCellActivate,
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
        if (
          event.target === scrollportRef.current ||
          (event.target as HTMLElement).closest(
            ".viewda-grid-horizontal-scrollport",
          ) !== null
        ) {
          onScrollInteraction?.();
        }
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
          moved: false,
          additive,
          clientX: event.clientX,
          clientY: event.clientY,
        };
      },
      [columns, onScrollInteraction, onSelectionChange, selection],
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
          if (suppressFollowingClick && !drag.moved && drag.kind === "cell") {
            if (onCellActivate !== undefined) {
              activateCell({ row: drag.lastRow, column: drag.lastColumn });
            }
          }
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
      [activateCell, onCellActivate],
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
        drag.moved = true;
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
        finishHorizontalScrollbarDrag();
      },
      [finishHorizontalScrollbarDrag, finishResize, finishSelectionDrag],
    );

    const handleDoubleClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        const target = event.target as HTMLElement;
        const coordinateHit =
          target.closest("[data-grid-kind], [data-action=resize]") === null
            ? document.elementFromPoint?.(event.clientX, event.clientY)
            : null;
        const coordinateTarget =
          coordinateHit != null && event.currentTarget.contains(coordinateHit)
            ? coordinateHit
            : null;
        const handle =
          target.closest<HTMLElement>('[data-action="resize"]') ??
          coordinateTarget?.closest<HTMLElement>('[data-action="resize"]');
        const column = parseIndex(handle?.dataset.column);
        if (column !== null) {
          event.preventDefault();
          finishResize();
          onColumnAutoFit(column);
          return;
        }
        // Pointer capture can retarget the native dblclick to the grid root.
        // Hit-test its coordinates so the gesture still resolves the cell.
        const cell =
          target.closest<HTMLElement>('[data-grid-kind="cell"]') ??
          coordinateTarget?.closest<HTMLElement>('[data-grid-kind="cell"]');
        const cellColumn = parseIndex(cell?.dataset.column);
        const row = parseIndex(cell?.dataset.row);
        if (cell != null && cellColumn !== null && row !== null) {
          event.preventDefault();
          onCellPeek?.(
            { column: cellColumn, row },
            measurementPort.bounds(cell),
            "open",
          );
        }
      },
      [finishResize, measurementPort, onCellPeek, onColumnAutoFit],
    );

    const handleKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Escape") {
          setPendingPeek(null);
          onEscape?.();
          return;
        }
        if (
          event.key === "Tab" &&
          !event.shiftKey &&
          onPeekFocus !== undefined
        ) {
          event.preventDefault();
          onPeekFocus();
          return;
        }
        if (rowCount === 0 || columns.length === 0) {
          return;
        }
        if (event.key === "Enter") {
          const active = selection.current?.cell;
          if (active !== undefined && onCellActivate !== undefined) {
            event.preventDefault();
            activateCell(active);
          }
          return;
        }
        const pageRows = Math.max(
          1,
          Math.floor(geometry.height / GRID_ROW_HEIGHT),
        );
        const currentCell = selection.current?.cell ?? { row: 0, column: 0 };
        if (event.key === " " && selection.current?.cell !== undefined) {
          event.preventDefault();
          const cell = rootRef.current?.querySelector<HTMLElement>(
            `[data-grid-kind="cell"][data-row="${currentCell.row}"][data-column="${currentCell.column}"]`,
          );
          if (cell !== undefined && cell !== null) {
            onCellPeek?.(currentCell, measurementPort.bounds(cell));
          } else {
            ensureCellVisible(currentCell);
            setPendingPeek(currentCell);
          }
          return;
        }
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
        measurementPort,
        onCellPeek,
        onEscape,
        onPeekFocus,
        activateCell,
        onCellActivate,
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
    useLayoutEffect(() => {
      if (!activeMounted || activeCell === undefined) return;
      const cell = document.getElementById(cellId(instanceId, activeCell));
      if (cell !== null) {
        onActiveCellBoundsChange?.(activeCell, measurementPort.bounds(cell));
      }
    }, [
      activeCell?.column,
      activeCell?.row,
      activeMounted,
      contentRevision,
      effectiveScrollState.logicalTop,
      effectiveScrollState.physicalTop,
      instanceId,
      measurementPort,
      onActiveCellBoundsChange,
      renderedRows.end,
      renderedRows.start,
      renderedScrollingRange.end,
      renderedScrollingRange.start,
    ]);
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

    // Keep the shared layer translation near the physical viewport. Using
    // `physicalTop - logicalTop` directly would create an enormous negative CSS
    // coordinate in compressed mode, while absolute logical row positions can
    // exceed the webview's reliable layout range. The coordinate anchor changes
    // on a wider runway than the actual DOM window, so overlapping memoized rows
    // keep stable transforms while rows still mount one at a time.
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
          anchoredTop={(row - coordinateRowAnchor) * GRID_ROW_HEIGHT}
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
        aria-label={label}
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
          id={`viewda-grid-scrollport-${instanceId}`}
          className="viewda-grid-body-scrollport"
          onScroll={handleScroll}
        >
          <div
            className="viewda-grid-spacer"
            style={{ width: totalWidth, height: layout.physicalHeight }}
          />
          <div
            className="viewda-grid-visible-rows"
            style={{
              width: totalWidth,
              transform: `translateY(${
                effectiveScrollState.physicalTop +
                coordinateRowAnchor * GRID_ROW_HEIGHT -
                effectiveScrollState.logicalTop
              }px)`,
            }}
          >
            {rows}
          </div>
        </div>
        <div
          ref={horizontalScrollbarRef}
          className="viewda-grid-horizontal-scrollbar"
          id={`viewda-grid-horizontal-scrollbar-${instanceId}`}
          role="scrollbar"
          aria-label="Horizontal grid scroll"
          aria-controls={`viewda-grid-scrollport-${instanceId}`}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(
            0,
            Math.round(scrollingWidth - scrollingViewportWidth),
          )}
          aria-valuenow={Math.round(horizontalScrollLeftRef.current)}
          hidden={!hasHorizontalOverflow}
          tabIndex={hasHorizontalOverflow ? 0 : -1}
          onKeyDown={handleHorizontalScrollbarKeyDown}
          onPointerDown={handleHorizontalScrollbarPointerDown}
          onPointerMove={handleHorizontalScrollbarPointerMove}
          onPointerUp={(event) =>
            finishHorizontalScrollbarDrag(event.pointerId)
          }
          onPointerCancel={(event) =>
            finishHorizontalScrollbarDrag(event.pointerId)
          }
          onLostPointerCapture={(event) =>
            finishHorizontalScrollbarDrag(event.pointerId)
          }
          style={{
            marginLeft: markerWidth + pinnedWidth,
          }}
        >
          <div
            ref={horizontalTrackRef}
            className="viewda-grid-horizontal-scrollport"
            aria-hidden="true"
            onScroll={handleHorizontalTrackScroll}
          >
            <div
              className="viewda-grid-horizontal-spacer"
              style={{ width: scrollingWidth }}
            />
          </div>
          <div
            ref={horizontalThumbRef}
            className="viewda-grid-horizontal-thumb"
            aria-hidden="true"
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
  anchoredTop,
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
  anchoredTop: number;
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
        transform: `translateY(${anchoredTop}px)`,
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
      aria-label={cell.kind === "text" ? cell.displayData : undefined}
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
      {cell.kind === "text"
        ? (cell.segments?.map((segment, index) => (
            <span key={index} className={`cell-preview-${segment.tone}`}>
              {segment.text}
            </span>
          )) ?? cell.displayData)
        : ""}
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
      className={`viewda-grid-column-header${pinned ? " is-pinned" : ""}${details.pending ? " is-pending" : ""}${details.filterable ? " has-filter" : ""}`}
      role="columnheader"
      aria-label={details.title}
      aria-colindex={ariaColumnIndex}
      aria-sort={
        details.sortable
          ? details.sort.direction === "neutral"
            ? "none"
            : details.sort.direction
          : undefined
      }
      data-grid-kind="header"
      data-column={column}
      style={{ left, width: details.width }}
    >
      {details.sortable && (
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
      )}
      <span className="viewda-grid-header-title">{details.title}</span>
      {details.filterable && (
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
            <path
              d="M1.5 2h9L7 6v3L5 10V6z"
              fill="none"
              stroke="currentColor"
            />
          </svg>
        </button>
      )}
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

function scrollVerticalAncestors(root: HTMLElement, delta: number): number {
  let remaining = delta;
  for (
    let ancestor = root.parentElement;
    ancestor !== null && remaining !== 0;
    ancestor = ancestor.parentElement
  ) {
    const overflowY = getComputedStyle(ancestor).overflowY;
    const maximum = Math.max(0, ancestor.scrollHeight - ancestor.clientHeight);
    if ((overflowY !== "auto" && overflowY !== "scroll") || maximum === 0) {
      continue;
    }
    const previous = ancestor.scrollTop;
    const next = Math.max(0, Math.min(maximum, previous + remaining));
    ancestor.scrollTop = next;
    remaining -= ancestor.scrollTop - previous;
  }
  return delta - remaining;
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

function sameRange(
  left: ColumnWindow["mounted"] | null,
  right: ColumnWindow["mounted"],
): boolean {
  return left !== null && left.start === right.start && left.end === right.end;
}
