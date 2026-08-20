import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelDataExport,
  cancelDataView,
  DataExportCommandError,
  DataWindowCommandError,
  dismissDataExport,
  getDataExportStatus,
  getDataWindow,
  getDataViewStatus,
  prepareDataView,
  revealDataExport,
  shortcutModifier,
  startDataExport,
  type DataExportErrorCode,
  type DataExportRequest,
  type DataExportScope,
  type DataExportStatus,
  type DataFilter,
  type DataViewSettings,
  type DataViewResourceDiagnostics,
  type SortColumn,
  type SourceSummary,
} from "../desktop";
import { loadBundledEmojiFont } from "../fonts";
import {
  decodeArrowWindow,
  windowContainsRow,
  windowDataType,
  windowValue,
  type ArrowDataWindow,
} from "./arrow-window";
import { copyRowLimit } from "./copy-limit";
import { projectedSourceIndices, projectionContains } from "./column-window";
import { exportSelectionShape } from "./export-selection";
import { formatCellValue, usesMonospaceCells } from "./format-cell";
import {
  CompactSelection,
  copyBufferContents,
  type GridAddress,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Rectangle,
} from "./grid-model";
import { createGridClipboard } from "./grid-clipboard";
import {
  gridDiagnosticsNoopSink,
  type GridDataWindowRequestReason,
  type GridDiagnosticsSink,
} from "./grid-performance-report";
import { GRID_INITIAL_COLUMNS, GRID_INITIAL_ROWS } from "./grid-layout";
import { boundedSelectionScope, selectColumn } from "./grid-selection";
import { gridFontStrings } from "./grid-typography";
import {
  defaultFilterOperator,
  FilterEditor,
  type FilterEditorRequest,
} from "./filter-controls";
import {
  columnFilterKind,
  filterInputFromCell,
  formatFilterCondition,
  formatOrderByClause,
  formatSelectClause,
  formatWhereClause,
} from "./filter-query";
import {
  clampedVisibleStart,
  nextScrollState,
  requestContainsVisibleRows,
  requestSatisfiesRequest,
  rowRequest,
  windowSatisfiesRequest,
  type RowRequest,
  type ScrollState,
} from "./row-window";
import { SchemaSidebar } from "./SchemaSidebar";
import { nextSort } from "./sort";
import { ColumnPicker } from "./ColumnPicker";
import {
  ViewdaGrid,
  type GridViewport,
  type ViewdaGridHandle,
} from "./ViewdaGrid";

const COPY_CHUNK_ROWS = 512;
const EXPORT_STATUS_POLL_MS = 1_000;
const MIN_COLUMN_WIDTH = 112;
const MAX_COLUMN_WIDTH = 500;
const WHERE_POPUP_MARGIN = 16;
const WHERE_POPUP_MAX_WIDTH = 680;
const WHERE_POPUP_OFFSET = -42;
const SELECT_TOOLTIP_COLUMN_LIMIT = 50;
const GRID_HEADER_HORIZONTAL_PADDING = 16;
const GRID_HEADER_ICON_SPACE = 28;
const GRID_CELL_HORIZONTAL_PADDING = 10;
// A horizontal fling can expose several projections before it settles. Waiting
// 120 ms keeps those superseded reads out of DuckDB. Shorten the pause if traces
// show columns waiting without request churn.
const PROJECTION_REQUEST_IDLE_MS = 120;

// Missing columns are read for two mounted row spans. That usually covers the
// next small vertical move without retaining another full Arrow window. Revisit
// the span when traces show repeated supplements or expensive reads.
// Both values follow source and memory profiles. Settings can expose named
// profiles if workloads eventually need different defaults.
const SUPPLEMENT_WINDOW_MULTIPLIER = 2;
const DEFAULT_DATA_VIEW_SETTINGS: DataViewSettings = { memoryLimit: "mb384" };

// Detect clipboard support once per webview so copy format stays consistent.
// There is no user choice here.
const gridClipboard = createGridClipboard();

function fittedColumnWidth(
  title: string,
  displayData: readonly string[],
  headerFont: string,
  cellFont: string,
  context: CanvasRenderingContext2D | null,
) {
  if (context !== null) {
    context.font = headerFont;
  }
  const headerTextWidth = context?.measureText(title).width ?? title.length * 8;
  let contentWidth = 0;
  if (context !== null) {
    context.font = cellFont;
  }
  for (const value of displayData) {
    const line = value.split("\n", 1)[0] ?? "";
    const textWidth = context?.measureText(line).width ?? line.length * 8;
    contentWidth = Math.max(
      contentWidth,
      textWidth + GRID_CELL_HORIZONTAL_PADDING * 2,
    );
  }
  return Math.min(
    MAX_COLUMN_WIDTH,
    Math.max(
      MIN_COLUMN_WIDTH,
      Math.ceil(
        Math.max(
          headerTextWidth +
            GRID_HEADER_HORIZONTAL_PADDING +
            GRID_HEADER_ICON_SPACE,
          contentWidth,
        ),
      ),
    ),
  );
}

interface ColumnState {
  sourceIndex: number;
  title: string;
  width: number;
  pinned: boolean;
  hidden: boolean;
}

interface HeaderMenu {
  sourceIndex: number;
  left: number;
  top: number;
}

interface GridMenu {
  bounds: Rectangle;
  row: number;
  sourceIndex: number;
  left: number;
  top: number;
}

type GridFilterAnchor = { kind: "header" } | { kind: "cell"; row: number };

type FilterEditorState = FilterEditorRequest & {
  gridAnchor?: GridFilterAnchor;
};

interface ExportUiError {
  action: "export" | "reveal" | "status";
  code: DataExportErrorCode;
}

interface VersionedRowRequest {
  rows: RowRequest;
  revision: number;
  projectionRevision: number;
  sourceIndices: readonly number[];
  // The row window owns the prefetched rows. The column supplement fills
  // columns absent from it for the much smaller mounted-row runway.
  cacheSlot: "rowWindow" | "columnSupplement";
  reason: GridDataWindowRequestReason;
  traceId: number | null;
}

interface DesiredRowRequest {
  rows: RowRequest;
  supplementRows: RowRequest;
  revision: number;
  projectionRevision: number;
  sourceIndices: readonly number[];
}

interface ActiveView {
  revision: number;
  filters: DataFilter[];
  sort: SortColumn[];
  rowCount: number;
}

interface PendingView {
  revision: number;
  filters: DataFilter[];
  sort: SortColumn[];
}

interface ViewErrorState {
  message: string;
  diagnostics?: string;
}

function requestSatisfiesWindow(
  candidate: VersionedRowRequest,
  requested: VersionedRowRequest,
): boolean {
  return (
    candidate.cacheSlot === requested.cacheSlot &&
    candidate.revision === requested.revision &&
    candidate.projectionRevision === requested.projectionRevision &&
    requestSatisfiesRequest(candidate.rows, requested.rows) &&
    projectionContains(candidate.sourceIndices, requested.sourceIndices)
  );
}

function requestCoversDesiredVisible(
  candidate: VersionedRowRequest,
  desired: DesiredRowRequest | null,
  base: ArrowDataWindow | null,
): boolean {
  if (
    desired === null ||
    candidate.revision !== desired.revision ||
    candidate.projectionRevision !== desired.projectionRevision
  ) {
    return false;
  }
  if (candidate.cacheSlot === "rowWindow") {
    return (
      requestContainsVisibleRows(candidate.rows, desired.rows) &&
      projectionContains(candidate.sourceIndices, desired.sourceIndices)
    );
  }
  return (
    base !== null &&
    windowSatisfiesRequest(base.rowOffset, base.rowCount, desired.rows) &&
    !projectionContains(base.sourceIndices, desired.sourceIndices) &&
    candidate.rows.offset >= base.rowOffset &&
    candidate.rows.offset + candidate.rows.count <=
      base.rowOffset + base.rowCount &&
    requestSatisfiesRequest(candidate.rows, desired.supplementRows) &&
    projectionContains(
      [...base.sourceIndices, ...candidate.sourceIndices],
      desired.sourceIndices,
    )
  );
}

function requestFullySatisfiesDesired(
  candidate: VersionedRowRequest,
  desired: DesiredRowRequest | null,
  base: ArrowDataWindow | null,
): boolean {
  if (candidate.cacheSlot === "columnSupplement") {
    return requestCoversDesiredVisible(candidate, desired, base);
  }
  return (
    desired !== null &&
    candidate.revision === desired.revision &&
    candidate.projectionRevision === desired.projectionRevision &&
    requestSatisfiesRequest(candidate.rows, desired.rows) &&
    projectionContains(candidate.sourceIndices, desired.sourceIndices)
  );
}

function windowsSatisfyDesired(
  base: ArrowDataWindow | null,
  supplement: ArrowDataWindow | null,
  desired: DesiredRowRequest,
): boolean {
  if (
    base === null ||
    !windowSatisfiesRequest(base.rowOffset, base.rowCount, desired.rows)
  ) {
    return false;
  }
  if (projectionContains(base.sourceIndices, desired.sourceIndices)) {
    return true;
  }
  return (
    supplement !== null &&
    windowSatisfiesRequest(
      supplement.rowOffset,
      supplement.rowCount,
      desired.supplementRows,
    ) &&
    projectionContains(
      [...base.sourceIndices, ...supplement.sourceIndices],
      desired.sourceIndices,
    )
  );
}

function supplementRowRequest(
  base: ArrowDataWindow,
  mountedStart: number,
  mountedCount: number,
  visibleStart: number,
  visibleEnd: number,
): RowRequest {
  const baseEnd = base.rowOffset + base.rowCount;
  const requiredStart = Math.max(base.rowOffset, mountedStart);
  const requiredEnd = Math.max(
    requiredStart,
    Math.min(baseEnd, mountedStart + mountedCount),
  );
  const requiredCount = requiredEnd - requiredStart;
  const count = Math.min(
    base.rowCount,
    Math.max(requiredCount, requiredCount * SUPPLEMENT_WINDOW_MULTIPLIER),
  );
  const preferredOffset =
    requiredStart - Math.floor((count - requiredCount) / 2);
  const offset = Math.max(
    base.rowOffset,
    Math.min(baseEnd - count, preferredOffset),
  );
  return {
    offset,
    count,
    visibleStart,
    visibleEnd,
    // The offset/count include a small data runway, but only the actual DOM
    // rows are required. This avoids a native read on each one-row mount shift
    // without making diagnostics report a larger rendered window.
    requiredStart,
    requiredEnd,
  };
}

function viewDefinitionEquals(
  current: Pick<ActiveView, "filters" | "sort">,
  filters: readonly DataFilter[],
  sort: readonly SortColumn[],
): boolean {
  return (
    current.filters.length === filters.length &&
    current.filters.every((filter, index) => {
      const next = filters[index];
      return (
        next !== undefined &&
        filter.columnIndex === next.columnIndex &&
        filter.operator === next.operator &&
        (filter.matchCase ?? false) === (next.matchCase ?? false) &&
        filter.values.length === next.values.length &&
        filter.values.every(
          (value, valueIndex) => value === next.values[valueIndex],
        )
      );
    }) &&
    current.sort.length === sort.length &&
    current.sort.every((column, index) => {
      const next = sort[index];
      return (
        next !== undefined &&
        column.sourceIndex === next.sourceIndex &&
        column.direction === next.direction
      );
    })
  );
}

function ViewErrorAlert({
  error,
  onDismiss,
  onRetry,
  dismissLabel = "Dismiss view error",
}: {
  error: ViewErrorState;
  onDismiss: () => void;
  onRetry?: () => void;
  dismissLabel?: string;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyDiagnostics = () => {
    if (error.diagnostics === undefined || navigator.clipboard === undefined) {
      setCopyState("failed");
      return;
    }
    try {
      void navigator.clipboard.writeText(error.diagnostics).then(
        () => setCopyState("copied"),
        () => setCopyState("failed"),
      );
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <section className="grid-error view-error" role="alert">
      <div className="view-error-content">
        <span>{error.message}</span>
        {error.diagnostics !== undefined && (
          <details className="view-error-details">
            <summary>
              <span className="view-error-details-show">Show details</span>
              <span className="view-error-details-hide">Hide details</span>
            </summary>
            <pre>{error.diagnostics}</pre>
            <div className="view-error-details-actions">
              <button type="button" onClick={copyDiagnostics}>
                Copy diagnostics
              </button>
              <span aria-live="polite">
                {copyState === "copied"
                  ? "Copied"
                  : copyState === "failed"
                    ? "Copy failed"
                    : ""}
              </span>
            </div>
          </details>
        )}
      </div>
      {onRetry !== undefined && (
        <button type="button" onClick={onRetry}>
          Retry window
        </button>
      )}
      <button
        type="button"
        aria-label={dismissLabel}
        title="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </section>
  );
}

export function DataGrid({
  source,
  viewSettings = DEFAULT_DATA_VIEW_SETTINGS,
  diagnostics = gridDiagnosticsNoopSink,
  active = true,
  onOperationChange,
}: {
  source: SourceSummary;
  viewSettings?: DataViewSettings;
  diagnostics?: GridDiagnosticsSink;
  active?: boolean;
  onOperationChange?: (running: boolean) => void;
}) {
  const [columnStates, setColumnStates] = useState<ColumnState[]>(() =>
    source.schema.map((field, sourceIndex) => ({
      sourceIndex,
      title: field.name,
      width: Math.min(
        280,
        Math.max(MIN_COLUMN_WIDTH, field.name.length * 8 + 48),
      ),
      pinned: false,
      hidden: false,
    })),
  );
  const [monospaceColumns, setMonospaceColumns] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [loadError, setLoadError] = useState<ViewErrorState | null>(null);
  const [horizontalExtentError, setHorizontalExtentError] = useState<
    string | null
  >(null);
  const [viewError, setViewError] = useState<ViewErrorState | null>(null);
  const [selection, setSelection] = useState<GridSelection>(() =>
    emptySelection(),
  );
  const [copyLimit, setCopyLimit] = useState<number | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
  const [gridMenu, setGridMenu] = useState<GridMenu | null>(null);
  const [exportStatus, setExportStatus] = useState<DataExportStatus | null>(
    null,
  );
  const [exportStarting, setExportStarting] = useState(false);
  const [exportError, setExportError] = useState<ExportUiError | null>(null);
  const [filterEditor, setFilterEditor] = useState<FilterEditorState | null>(
    null,
  );
  const [activeView, setActiveView] = useState<ActiveView>(() => ({
    revision: 0,
    filters: [],
    sort: [],
    rowCount: source.rowCount,
  }));
  const [contentRevision, setContentRevision] = useState(0);
  const [pendingView, setPendingView] = useState<PendingView | null>(null);
  const [selectPopupOpen, setSelectPopupOpen] = useState(false);
  const [wherePopupOpen, setWherePopupOpen] = useState(false);
  const [wherePopupPosition, setWherePopupPosition] = useState({
    left: WHERE_POPUP_MARGIN,
    top: WHERE_POPUP_MARGIN,
  });
  const [sortPopupOpen, setSortPopupOpen] = useState(false);
  const [sortDraft, setSortDraft] = useState<SortColumn[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSchemaColumn, setSelectedSchemaColumn] = useState<
    number | null
  >(null);
  const [schemaFocusRequest, setSchemaFocusRequest] = useState(0);
  const gridRef = useRef<ViewdaGridHandle>(null);
  const schemaFocusColumnRef = useRef<number | null>(null);
  const visibleColumnStatesRef = useRef<readonly ColumnState[]>([]);
  // The display cache holds one row window and one column supplement. The row
  // window owns the prefetch range. The supplement holds columns missing from
  // that window for the mounted rows. Leaving the prefetched range replaces both.
  // This reuses shared columns while keeping Arrow memory bounded for wide values.
  const baseWindowRef = useRef<ArrowDataWindow | null>(null);
  const supplementWindowRef = useRef<ArrowDataWindow | null>(null);
  const visibleViewportRef = useRef<GridViewport | null>(null);
  const copyTailRef = useRef<Promise<void>>(Promise.resolve());
  const copyWindowsRef = useRef(new Map<string, Promise<ArrowDataWindow>>());
  const copyAbortRef = useRef<AbortController | null>(null);
  const pendingRequestRef = useRef<VersionedRowRequest | null>(null);
  const deferredProjectionRef = useRef<VersionedRowRequest | null>(null);
  const projectionTimerRef = useRef<number | null>(null);
  const activeRequestRef = useRef<VersionedRowRequest | null>(null);
  const failedRequestRef = useRef<VersionedRowRequest | null>(null);
  const activeViewRef = useRef(activeView);
  const pendingViewRef = useRef<PendingView | null>(null);
  const nextViewRevisionRef = useRef(0);
  const nextSuggestionRevisionRef = useRef(0);
  const projectionRevisionRef = useRef(0);
  const previousProjectionRef = useRef<readonly number[] | null>(null);
  const requestedProjectionRef = useRef<readonly number[]>([]);
  const desiredRequestRef = useRef<DesiredRowRequest | null>(null);
  const scrollStateRef = useRef<ScrollState>({ direction: 0, boundary: 0 });
  const aliveRef = useRef(true);
  const exportStatusFailuresRef = useRef(0);
  const columnFitRequestRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const gridMenuRef = useRef<HTMLDivElement>(null);
  const selectPopupRef = useRef<HTMLDivElement>(null);
  const wherePopupAnchorRef = useRef<HTMLDivElement>(null);
  const wherePopupRef = useRef<HTMLDivElement>(null);
  const sortPopupRef = useRef<HTMLDivElement>(null);
  const onOperationChangeRef = useRef(onOperationChange);
  onOperationChangeRef.current = onOperationChange;

  useEffect(() => {
    const exportRunning = exportStarting || exportStatus?.state === "running";
    onOperationChangeRef.current?.(pendingView !== null || exportRunning);
  }, [exportStarting, exportStatus?.state, pendingView]);

  useEffect(
    () => () => {
      onOperationChangeRef.current?.(false);
    },
    [],
  );

  const visibleColumnStates = useMemo(
    () => [
      ...columnStates.filter((column) => column.pinned && !column.hidden),
      ...columnStates.filter((column) => !column.pinned && !column.hidden),
    ],
    [columnStates],
  );
  visibleColumnStatesRef.current = visibleColumnStates;
  const hiddenCount = columnStates.length - visibleColumnStates.length;
  activeViewRef.current = activeView;

  const nextSuggestionRevision = useCallback(() => {
    nextSuggestionRevisionRef.current += 1;
    return nextSuggestionRevisionRef.current;
  }, []);
  pendingViewRef.current = pendingView;
  const filters = activeView.filters;
  const sort = activeView.sort;
  const gridRowCount = activeView.rowCount;
  const visibleSourceIndices = useMemo(
    () => visibleColumnStates.map((column) => column.sourceIndex),
    [visibleColumnStates],
  );
  const visibleProjectionKey = visibleSourceIndices.join(",");
  const selectTitle = useMemo(() => {
    if (hiddenCount === 0) {
      return "*";
    }
    if (visibleSourceIndices.length > SELECT_TOOLTIP_COLUMN_LIMIT) {
      return `${visibleSourceIndices.length.toLocaleString("en-US")} of ${columnStates.length.toLocaleString("en-US")} columns visible`;
    }
    return formatSelectClause(visibleSourceIndices, source.schema);
  }, [columnStates.length, hiddenCount, source.schema, visibleSourceIndices]);
  const pickerColumns = useMemo(
    () =>
      columnStates.map((column) => {
        const field = source.schema[column.sourceIndex];
        return {
          sourceIndex: column.sourceIndex,
          name: column.title,
          type: field?.logicalType ?? field?.physicalType ?? "Unknown",
          visible: !column.hidden,
          pinned: column.pinned,
        };
      }),
    [columnStates, source.schema],
  );
  const selectedExport = useMemo(
    () => exportSelectionShape(selection, visibleSourceIndices, gridRowCount),
    [gridRowCount, selection, visibleSourceIndices],
  );
  const whereClause = useMemo(
    () => formatWhereClause(filters, source.schema),
    [filters, source.schema],
  );
  const orderByClause = useMemo(
    () => formatOrderByClause(sort, source.schema),
    [sort, source.schema],
  );

  useEffect(() => {
    const fonts = document.fonts;
    if (fonts === undefined) {
      return;
    }
    let alive = true;
    void loadBundledEmojiFont(fonts).then((loaded) => {
      if (alive && loaded) {
        setContentRevision((current) => current + 1);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo<GridColumn[]>(
    () =>
      visibleColumnStates.map((column) => {
        const displayedSort = pendingView?.sort ?? sort;
        const sortIndex = displayedSort.findIndex(
          (entry) => entry.sourceIndex === column.sourceIndex,
        );
        return {
          id: String(column.sourceIndex),
          title: column.title,
          width: column.width,
          monospace: monospaceColumns.has(column.sourceIndex),
          pinned: column.pinned,
          pending: pendingView !== null && sortIndex >= 0,
          sort: {
            direction:
              sortIndex < 0
                ? "neutral"
                : (displayedSort[sortIndex]?.direction ?? "ascending"),
            priority:
              displayedSort.length > 1 && sortIndex >= 0
                ? sortIndex + 1
                : undefined,
          },
        };
      }),
    [monospaceColumns, pendingView, sort, visibleColumnStates],
  );

  const readCell = useCallback(
    (
      window: ArrowDataWindow,
      visibleColumn: number,
      row: number,
      visibleColumns = visibleColumnStates,
      includeRawCopy = false,
    ): GridCell => {
      const column = visibleColumns[visibleColumn];
      if (column === undefined || !windowContainsRow(window, row)) {
        return loadingCell();
      }
      const dataType = windowDataType(window, column.sourceIndex);
      if (dataType === undefined) {
        return loadingCell();
      }
      const formatted = formatCellValue(
        windowValue(window, column.sourceIndex, row),
        dataType,
        includeRawCopy,
      );
      return {
        kind: "text",
        displayData: formatted.displayData,
        copyData: formatted.copyData,
        alignment: formatted.align,
        faded: formatted.faded,
      };
    },
    [visibleColumnStates],
  );

  const getCellContent = useCallback(
    ({ column, row }: GridAddress): GridCell => {
      const sourceIndex = visibleColumnStatesRef.current[column]?.sourceIndex;
      const supplement = supplementWindowRef.current;
      if (
        sourceIndex !== undefined &&
        supplement !== null &&
        windowContainsRow(supplement, row) &&
        supplement.sourceColumnOffsets.has(sourceIndex)
      ) {
        return readCell(supplement, column, row);
      }
      const base = baseWindowRef.current;
      return base === null ? loadingCell() : readCell(base, column, row);
    },
    [readCell],
  );

  const queueRequestTrace = useCallback(
    (request: VersionedRowRequest) => {
      if (!diagnostics.isEnabled()) return null;
      const view = activeViewRef.current;
      return diagnostics.queueRequest({
        reason: request.reason,
        rowOffset: request.rows.offset,
        rowCount: request.rows.count,
        projectionCount: request.sourceIndices.length,
        projectionKey: projectionFingerprint(request.sourceIndices),
        filtered: view.filters.length > 0,
        sorted: view.sort.length > 0,
      });
    },
    [diagnostics],
  );

  const clearDeferredProjection = useCallback(
    (
      reason:
        | "supersededBeforeStart"
        | "invalidatedBeforeStart"
        | "satisfiedByCompletedWindow" = "supersededBeforeStart",
    ) => {
      if (projectionTimerRef.current !== null) {
        window.clearTimeout(projectionTimerRef.current);
        projectionTimerRef.current = null;
      }
      diagnostics.disposeRequest(
        deferredProjectionRef.current?.traceId ?? null,
        reason,
      );
      deferredProjectionRef.current = null;
    },
    [diagnostics],
  );

  const promoteView = useCallback(
    (
      revision: number,
      rowCount: number,
      filters: DataFilter[],
      sort: SortColumn[],
    ) => {
      const next = { revision, rowCount, filters, sort };
      nextViewRevisionRef.current = Math.max(
        nextViewRevisionRef.current,
        revision,
      );
      activeViewRef.current = next;
      setActiveView(next);
      pendingViewRef.current = null;
      setPendingView(null);
      setLoadError(null);
      setViewError(null);
      diagnostics.disposeRequest(
        pendingRequestRef.current?.traceId ?? null,
        "invalidatedBeforeStart",
      );
      pendingRequestRef.current = null;
      clearDeferredProjection("invalidatedBeforeStart");
      failedRequestRef.current = null;
      desiredRequestRef.current = null;
      baseWindowRef.current = null;
      supplementWindowRef.current = null;
      copyWindowsRef.current.clear();
      copyAbortRef.current?.abort();
      setSelection(emptySelection());
      setCopyLimit(null);
      setHeaderMenu(null);
      setGridMenu(null);
      setContentRevision((current) => current + 1);
    },
    [clearDeferredProjection, diagnostics],
  );

  const drainRequests = useCallback(async () => {
    if (activeRequestRef.current !== null) {
      return;
    }

    while (aliveRef.current && pendingRequestRef.current !== null) {
      const request = pendingRequestRef.current;
      pendingRequestRef.current = null;
      activeRequestRef.current = request;
      diagnostics.startRequest(request.traceId);
      let requestOutcome: "completed" | "failed" = "completed";
      let staleRequest = false;
      try {
        const bytes = await getDataWindow(
          source.generation,
          request.revision,
          request.rows.offset,
          request.rows.count,
          request.sourceIndices,
        );
        const decoded = decodeArrowWindow(
          bytes,
          request.rows.offset,
          request.sourceIndices,
        );
        const desired = desiredRequestRef.current;
        const base = baseWindowRef.current;
        if (
          !aliveRef.current ||
          request.revision !== activeViewRef.current.revision ||
          request.projectionRevision !== projectionRevisionRef.current ||
          !requestCoversDesiredVisible(request, desired, base)
        ) {
          staleRequest = true;
          continue;
        }
        const fullySatisfiesDesired = requestFullySatisfiesDesired(
          request,
          desired,
          base,
        );
        const queuedSuccessor =
          (pendingRequestRef.current as VersionedRowRequest | null) ??
          deferredProjectionRef.current;
        if (
          !fullySatisfiesDesired &&
          request.cacheSlot === "rowWindow" &&
          queuedSuccessor?.cacheSlot === "columnSupplement"
        ) {
          // The supplement was planned against the existing base, which still
          // owns the full row runway. Replacing it with a visible-only base
          // would invalidate the queued request and lose both prefetch paths.
          staleRequest = true;
          continue;
        }
        setMonospaceColumns((current) => {
          const next = new Set(current);
          decoded.table.schema.fields.forEach((field, columnOffset) => {
            const sourceIndex = decoded.sourceIndices[columnOffset];
            if (sourceIndex !== undefined && usesMonospaceCells(field.type)) {
              next.add(sourceIndex);
            }
          });
          return next.size === current.size ? current : next;
        });
        if (fullySatisfiesDesired) {
          const pending =
            pendingRequestRef.current as VersionedRowRequest | null;
          if (pending !== null) {
            diagnostics.disposeRequest(
              pending.traceId,
              "satisfiedByCompletedWindow",
            );
            pendingRequestRef.current = null;
          }
          clearDeferredProjection("satisfiedByCompletedWindow");
        }
        if (request.cacheSlot === "rowWindow") {
          baseWindowRef.current = decoded;
          supplementWindowRef.current = null;
        } else {
          supplementWindowRef.current = decoded;
        }
        failedRequestRef.current = null;
        setContentRevision((current) => current + 1);
        setLoadError(null);
      } catch (error) {
        requestOutcome = "failed";
        const requestIsCurrent =
          aliveRef.current &&
          request.revision === activeViewRef.current.revision &&
          request.projectionRevision === projectionRevisionRef.current &&
          requestCoversDesiredVisible(
            request,
            desiredRequestRef.current,
            baseWindowRef.current,
          );
        if (!requestIsCurrent) {
          staleRequest = true;
        } else if (
          error instanceof DataWindowCommandError &&
          error.code === "viewChanged"
        ) {
          staleRequest = true;
          try {
            const status = await getDataViewStatus(source.generation);
            const stillCurrent =
              aliveRef.current &&
              request.revision === activeViewRef.current.revision &&
              request.projectionRevision === projectionRevisionRef.current &&
              requestCoversDesiredVisible(
                request,
                desiredRequestRef.current,
                baseWindowRef.current,
              );
            const pending = pendingViewRef.current;
            const active = activeViewRef.current;
            if (aliveRef.current && pending?.revision === status.revision) {
              promoteView(
                status.revision,
                status.rowCount,
                pending.filters,
                pending.sort,
              );
            } else if (
              aliveRef.current &&
              stillCurrent &&
              active.revision === status.revision &&
              pendingRequestRef.current === null &&
              deferredProjectionRef.current === null
            ) {
              const retry: VersionedRowRequest = {
                rows: request.rows,
                revision: active.revision,
                projectionRevision: request.projectionRevision,
                sourceIndices: request.sourceIndices,
                cacheSlot: request.cacheSlot,
                reason: "retry",
                traceId: null,
              };
              retry.traceId = queueRequestTrace(retry);
              pendingRequestRef.current = retry;
            } else if (
              aliveRef.current &&
              stillCurrent &&
              active.revision !== status.revision &&
              pendingRequestRef.current === null &&
              deferredProjectionRef.current === null
            ) {
              setLoadError({
                message: "The active data view could not be synchronized.",
              });
            }
          } catch (statusError) {
            if (
              aliveRef.current &&
              request.revision === activeViewRef.current.revision &&
              request.projectionRevision === projectionRevisionRef.current &&
              pendingRequestRef.current === null &&
              deferredProjectionRef.current === null &&
              requestCoversDesiredVisible(
                request,
                desiredRequestRef.current,
                baseWindowRef.current,
              )
            ) {
              setLoadError(dataViewErrorState(statusError));
            }
          }
        } else if (
          pendingRequestRef.current === null &&
          deferredProjectionRef.current === null
        ) {
          failedRequestRef.current = request;
          setLoadError(dataViewErrorState(error));
        }
      } finally {
        diagnostics.finishRequest(
          request.traceId,
          requestOutcome,
          staleRequest,
        );
        activeRequestRef.current = null;
      }
    }
  }, [
    clearDeferredProjection,
    diagnostics,
    promoteView,
    queueRequestTrace,
    source.generation,
  ]);

  const requestRows = useCallback(
    (
      visibleStart: number,
      visibleCount: number,
      planningRowCount = activeViewRef.current.rowCount,
    ) => {
      const scrollState = nextScrollState(scrollStateRef.current, visibleStart);
      scrollStateRef.current = scrollState;
      const request = rowRequest(
        planningRowCount,
        visibleStart,
        visibleCount,
        scrollState.direction,
      );
      const activeView = activeViewRef.current;
      const sourceIndices = projectedSourceIndices(
        visibleColumnStatesRef.current,
        visibleViewportRef.current?.mountedColumnIndices ?? [],
        GRID_INITIAL_COLUMNS,
      );
      if (sourceIndices.length === 0) {
        return;
      }
      const previousProjection = requestedProjectionRef.current;
      const projectionChanged = !sameColumnSet(
        previousProjection,
        sourceIndices,
      );
      requestedProjectionRef.current = sourceIndices;
      const base = baseWindowRef.current;
      const baseContainsRows =
        base !== null &&
        windowSatisfiesRequest(base.rowOffset, base.rowCount, request);
      const mountedRows = visibleViewportRef.current;
      const mountedStart = mountedRows?.mountedRowStart ?? request.visibleStart;
      const mountedCount =
        mountedRows?.mountedRowCount ??
        request.visibleEnd - request.visibleStart;
      const supplementRows =
        baseContainsRows && base !== null
          ? supplementRowRequest(
              base,
              mountedStart,
              mountedCount,
              request.visibleStart,
              request.visibleEnd,
            )
          : {
              offset: mountedStart,
              count: mountedCount,
              visibleStart: request.visibleStart,
              visibleEnd: request.visibleEnd,
              requiredStart: mountedStart,
              requiredEnd: mountedStart + mountedCount,
            };
      const desired: DesiredRowRequest = {
        rows: request,
        supplementRows,
        revision: activeView.revision,
        projectionRevision: projectionRevisionRef.current,
        sourceIndices,
      };
      // This is the sole authority for whether an async result still belongs on
      // screen. It is updated before any cache or in-flight early return so a
      // late away-window result cannot overwrite a viewport that returned to
      // already cached rows.
      desiredRequestRef.current = desired;
      const failed = failedRequestRef.current;
      if (
        failed !== null &&
        !requestCoversDesiredVisible(failed, desired, base)
      ) {
        failedRequestRef.current = null;
        setLoadError(null);
      }
      const missingFromBase =
        base === null
          ? sourceIndices
          : sourceIndices.filter(
              (sourceIndex) => !base.sourceColumnOffsets.has(sourceIndex),
            );
      const supplement = supplementWindowRef.current;
      const supplementContainsRows =
        supplement !== null &&
        windowSatisfiesRequest(
          supplement.rowOffset,
          supplement.rowCount,
          supplementRows,
        );
      if (windowsSatisfyDesired(base, supplement, desired)) {
        if (failedRequestRef.current !== null) {
          failedRequestRef.current = null;
          setLoadError(null);
        }
        const pending = pendingRequestRef.current;
        if (pending !== null) {
          diagnostics.disposeRequest(pending.traceId, "supersededBeforeStart");
          pendingRequestRef.current = null;
        }
        clearDeferredProjection();
        return;
      }
      const cacheSlot = baseContainsRows ? "columnSupplement" : "rowWindow";
      const requestedRows =
        cacheSlot === "columnSupplement" ? supplementRows : request;
      const requestedWindow: VersionedRowRequest = {
        rows: requestedRows,
        revision: activeView.revision,
        projectionRevision: projectionRevisionRef.current,
        sourceIndices:
          cacheSlot === "columnSupplement" ? missingFromBase : sourceIndices,
        cacheSlot,
        reason:
          base === null
            ? "initial"
            : cacheSlot === "columnSupplement"
              ? projectionChanged
                ? supplement !== null && !supplementContainsRows
                  ? "rowAndColumnWindow"
                  : "columnProjection"
                : "rowWindow"
              : projectionChanged
                ? "rowAndColumnWindow"
                : "rowWindow",
        traceId: null,
      };
      const pending = pendingRequestRef.current;
      const active = activeRequestRef.current;
      if (
        active !== null &&
        requestFullySatisfiesDesired(active, desired, base)
      ) {
        if (pending !== null) {
          diagnostics.disposeRequest(pending.traceId, "supersededBeforeStart");
          pendingRequestRef.current = null;
        }
        clearDeferredProjection();
        return;
      }
      if (
        pending !== null &&
        requestFullySatisfiesDesired(pending, desired, base)
      ) {
        clearDeferredProjection();
        return;
      }
      const deferred = deferredProjectionRef.current;
      if (
        deferred !== null &&
        requestSatisfiesWindow(deferred, requestedWindow)
      ) {
        if (pending !== null) {
          diagnostics.disposeRequest(pending.traceId, "supersededBeforeStart");
          pendingRequestRef.current = null;
        }
        return;
      }
      if (cacheSlot === "columnSupplement" && projectionChanged) {
        clearDeferredProjection();
        if (pending !== null) {
          diagnostics.disposeRequest(pending.traceId, "supersededBeforeStart");
          pendingRequestRef.current = null;
        }
        requestedWindow.traceId = queueRequestTrace(requestedWindow);
        deferredProjectionRef.current = requestedWindow;
        // Projection changes do not affect scroll geometry. Waiting for a brief
        // horizontal idle period keeps an obsolete sparse read from owning the
        // native engine mutex when a row movement immediately follows. A row-
        // only supplement is queued below without delay so continuous vertical
        // scrolling cannot leave the newly mounted rows loading indefinitely.
        projectionTimerRef.current = window.setTimeout(() => {
          projectionTimerRef.current = null;
          const deferred = deferredProjectionRef.current;
          deferredProjectionRef.current = null;
          if (deferred === null) return;
          if (
            !requestFullySatisfiesDesired(
              deferred,
              desiredRequestRef.current,
              baseWindowRef.current,
            )
          ) {
            diagnostics.disposeRequest(
              deferred.traceId,
              "supersededBeforeStart",
            );
            return;
          }
          pendingRequestRef.current = deferred;
          void drainRequests();
        }, PROJECTION_REQUEST_IDLE_MS);
        return;
      }
      clearDeferredProjection();
      if (pending !== null) {
        diagnostics.disposeRequest(pending.traceId, "supersededBeforeStart");
      }
      requestedWindow.traceId = queueRequestTrace(requestedWindow);
      pendingRequestRef.current = requestedWindow;
      void drainRequests();
    },
    [clearDeferredProjection, diagnostics, drainRequests, queueRequestTrace],
  );

  const retryWindow = useCallback(() => {
    const failed = failedRequestRef.current;
    const desired = desiredRequestRef.current;
    const base = baseWindowRef.current;
    if (
      failed === null ||
      !requestCoversDesiredVisible(failed, desired, base) ||
      (desired !== null &&
        windowsSatisfyDesired(base, supplementWindowRef.current, desired))
    ) {
      return;
    }
    if (
      activeRequestRef.current !== null ||
      pendingRequestRef.current !== null ||
      deferredProjectionRef.current !== null
    ) {
      return;
    }
    failedRequestRef.current = null;
    pendingRequestRef.current = {
      ...failed,
      reason: "retry",
      traceId: null,
    };
    pendingRequestRef.current.traceId = queueRequestTrace(
      pendingRequestRef.current,
    );
    setLoadError(null);
    void drainRequests();
  }, [drainRequests, queueRequestTrace]);

  const reloadActiveWindow = useCallback(() => {
    const active = activeViewRef.current;
    failedRequestRef.current = null;
    diagnostics.disposeRequest(
      pendingRequestRef.current?.traceId ?? null,
      "invalidatedBeforeStart",
    );
    pendingRequestRef.current = null;
    clearDeferredProjection("invalidatedBeforeStart");
    desiredRequestRef.current = null;
    baseWindowRef.current = null;
    supplementWindowRef.current = null;
    setContentRevision((current) => current + 1);
    if (active.rowCount === 0) {
      return;
    }
    const visible = visibleViewportRef.current;
    requestRows(
      visible?.rowStart ?? 0,
      visible?.rowCount ?? Math.min(GRID_INITIAL_ROWS, active.rowCount),
    );
  }, [clearDeferredProjection, diagnostics, requestRows]);

  useEffect(() => {
    const previous = previousProjectionRef.current;
    previousProjectionRef.current = visibleSourceIndices;
    if (previous === null) {
      return;
    }
    copyAbortRef.current?.abort();
    if (
      previous.length === visibleSourceIndices.length &&
      projectionContains(previous, visibleSourceIndices)
    ) {
      if (!sameColumnOrder(previous, visibleSourceIndices)) {
        setSelection(clearColumnSelection);
        setCopyLimit(null);
      }
      return;
    }
    projectionRevisionRef.current += 1;
    diagnostics.disposeRequest(
      pendingRequestRef.current?.traceId ?? null,
      "invalidatedBeforeStart",
    );
    pendingRequestRef.current = null;
    clearDeferredProjection("invalidatedBeforeStart");
    failedRequestRef.current = null;
    desiredRequestRef.current = null;
    baseWindowRef.current = null;
    supplementWindowRef.current = null;
    copyWindowsRef.current.clear();
    setLoadError(null);
    setSelection(clearColumnSelection);
    setCopyLimit(null);
    setContentRevision((current) => current + 1);
  }, [clearDeferredProjection, diagnostics, visibleSourceIndices]);

  useEffect(() => {
    setHeaderMenu((current) =>
      current !== null &&
      visibleColumnIndex(current.sourceIndex, visibleColumnStates) >= 0
        ? current
        : null,
    );
    setGridMenu((current) =>
      current !== null &&
      visibleColumnIndex(current.sourceIndex, visibleColumnStates) >= 0
        ? current
        : null,
    );
    setFilterEditor((current) => {
      if (current?.gridAnchor === undefined) {
        return current;
      }
      return visibleColumnIndex(current.sourceIndex, visibleColumnStates) >= 0
        ? current
        : null;
    });
  }, [visibleColumnStates]);

  // Keep liveness scoped to component lifetime: a view change can make the child
  // report its new viewport before the request effect runs.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      copyAbortRef.current?.abort();
      diagnostics.disposeRequest(
        pendingRequestRef.current?.traceId ?? null,
        "invalidatedBeforeStart",
      );
      pendingRequestRef.current = null;
      clearDeferredProjection("invalidatedBeforeStart");
      failedRequestRef.current = null;
    };
  }, [clearDeferredProjection, diagnostics]);

  useEffect(() => {
    if (activeView.rowCount > 0) {
      const visible = visibleViewportRef.current;
      const visibleCount =
        visible?.rowCount ?? Math.min(GRID_INITIAL_ROWS, activeView.rowCount);
      const visibleStart = clampedVisibleStart(
        activeView.rowCount,
        visible?.rowStart ?? 0,
        visibleCount,
      );
      if (visible !== null && visibleStart !== visible.rowStart) {
        visibleViewportRef.current = {
          ...visible,
          rowStart: visibleStart,
          rowCount: Math.min(
            visible.rowCount,
            activeView.rowCount - visibleStart,
          ),
        };
        scrollStateRef.current = { direction: 0, boundary: visibleStart };
        gridRef.current?.scrollToRow(visibleStart);
      }
      requestRows(visibleStart, visibleCount);
    }
  }, [
    activeView.revision,
    activeView.rowCount,
    requestRows,
    visibleProjectionKey,
  ]);

  useEffect(
    () => () => {
      const pending = pendingViewRef.current;
      if (pending !== null) {
        void cancelDataView(source.generation, pending.revision).catch(
          () => undefined,
        );
      }
    },
    [source.generation],
  );

  const refreshExportStatus = useCallback(() => {
    void getDataExportStatus(source.generation).then(
      (status) => {
        exportStatusFailuresRef.current = 0;
        setExportStatus(status);
      },
      () => {
        exportStatusFailuresRef.current += 1;
        if (exportStatusFailuresRef.current >= 3) {
          setExportStatus(null);
          setExportError({ action: "status", code: "queryFailed" });
        }
      },
    );
  }, []);

  useEffect(() => {
    refreshExportStatus();
  }, [refreshExportStatus]);

  useEffect(() => {
    if (exportStatus?.state !== "running") {
      return;
    }
    const interval = window.setInterval(
      refreshExportStatus,
      EXPORT_STATUS_POLL_MS,
    );
    return () => window.clearInterval(interval);
  }, [exportStatus?.state, exportStatus?.id, refreshExportStatus]);

  useEffect(() => {
    if (exportStatus?.state !== "completed") {
      return;
    }
    const completed = exportStatus;
    const timeout = window.setTimeout(() => {
      const clearCompleted = () => {
        setExportStatus((current) =>
          current?.id === completed.id ? null : current,
        );
      };
      void dismissDataExport(completed.id).then(clearCompleted, clearCompleted);
    }, 6_000);
    return () => window.clearTimeout(timeout);
  }, [exportStatus]);

  const startExport = useCallback(
    async (scope: DataExportScope) => {
      if (exportStarting || exportStatus?.state === "running") {
        return;
      }
      const shape = scope === "selection" ? selectedExport : null;
      if (scope === "selection" && shape === null) {
        return;
      }
      const request: DataExportRequest = {
        columnIndices:
          shape?.columnIndices ??
          visibleColumnStates.map(({ sourceIndex }) => sourceIndex),
        rowRanges: shape?.rowRanges ?? [],
        output: { format: "csv", options: {} },
      };
      setExportStarting(true);
      setExportError(null);
      setGridMenu(null);
      try {
        const status = await startDataExport(
          source.generation,
          activeViewRef.current.revision,
          scope,
          request,
        );
        if (status !== null) {
          setExportStatus(status);
        }
      } catch (error) {
        if (
          error instanceof DataExportCommandError &&
          error.code === "alreadyRunning"
        ) {
          refreshExportStatus();
        } else {
          setExportError({
            action: "export",
            code:
              error instanceof DataExportCommandError
                ? error.code
                : "queryFailed",
          });
        }
      } finally {
        setExportStarting(false);
      }
    },
    [
      exportStarting,
      exportStatus?.state,
      refreshExportStatus,
      selectedExport,
      source.generation,
      visibleColumnStates,
    ],
  );

  useEffect(() => {
    if (headerMenu === null) {
      return;
    }
    menuRef.current?.querySelector("button")?.focus();
    const closeMenu = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setHeaderMenu(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setHeaderMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [headerMenu]);

  useEffect(() => {
    if (gridMenu === null) {
      return;
    }
    gridMenuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const closeMenu = (event: PointerEvent) => {
      if (!gridMenuRef.current?.contains(event.target as Node)) {
        setGridMenu(null);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setGridMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [gridMenu]);

  useEffect(() => {
    if (!selectPopupOpen) {
      return;
    }
    const closePopup = (event: PointerEvent) => {
      if (!selectPopupRef.current?.contains(event.target as Node)) {
        setSelectPopupOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectPopupOpen(false);
      }
    };
    document.addEventListener("pointerdown", closePopup);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePopup);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectPopupOpen]);

  useEffect(() => {
    if (!wherePopupOpen) {
      return;
    }
    const closePopup = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !wherePopupAnchorRef.current?.contains(target) &&
        !wherePopupRef.current?.contains(target)
      ) {
        setWherePopupOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setWherePopupOpen(false);
      }
    };
    document.addEventListener("pointerdown", closePopup);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePopup);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [wherePopupOpen]);

  useEffect(() => {
    if (!sortPopupOpen) {
      return;
    }
    sortPopupRef.current
      ?.querySelector<HTMLElement>(
        ".sort-popup button:not(:disabled), .sort-popup select:not(:disabled)",
      )
      ?.focus();
    const closePopup = (event: PointerEvent) => {
      if (!sortPopupRef.current?.contains(event.target as Node)) {
        setSortPopupOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setSortPopupOpen(false);
      }
    };
    document.addEventListener("pointerdown", closePopup);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closePopup);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [sortPopupOpen]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const toggleSidebar = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "b" ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      setSidebarOpen((open) => !open);
    };
    window.addEventListener("keydown", toggleSidebar);
    return () => window.removeEventListener("keydown", toggleSidebar);
  }, [active]);

  useEffect(() => {
    if (!active) {
      return;
    }
    const exportView = (event: globalThis.KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "e" ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      void startExport(selectedExport === null ? "view" : "selection");
    };
    window.addEventListener("keydown", exportView);
    return () => window.removeEventListener("keydown", exportView);
  }, [active, selectedExport, startExport]);

  useEffect(() => {
    const sourceIndex = schemaFocusColumnRef.current;
    if (sourceIndex === null) {
      return;
    }
    const visibleIndex = visibleColumnStatesRef.current.findIndex(
      (column) => column.sourceIndex === sourceIndex,
    );
    if (visibleIndex < 0) {
      return;
    }
    gridRef.current?.scrollToColumn(visibleIndex, 16);
    setSelection(selectColumn(emptySelection(), visibleIndex, false, false));
  }, [schemaFocusRequest]);

  const applyView = useCallback(
    (nextFilters: DataFilter[], nextSort: SortColumn[]) => {
      const current = pendingViewRef.current ?? activeViewRef.current;
      if (viewDefinitionEquals(current, nextFilters, nextSort)) {
        setHeaderMenu(null);
        setFilterEditor(null);
        setWherePopupOpen(false);
        setSortPopupOpen(false);
        return;
      }
      const previous = pendingViewRef.current;
      if (previous !== null) {
        void cancelDataView(source.generation, previous.revision).catch(
          () => undefined,
        );
      }
      if (source.rowCount === 0) {
        promoteView(activeViewRef.current.revision, 0, nextFilters, nextSort);
        setLoadError(null);
        setHeaderMenu(null);
        setFilterEditor(null);
        setWherePopupOpen(false);
        setSortPopupOpen(false);
        return;
      }
      const revision = nextViewRevisionRef.current + 1;
      nextViewRevisionRef.current = revision;
      const request = { revision, filters: nextFilters, sort: nextSort };
      pendingViewRef.current = request;
      setPendingView(request);
      copyAbortRef.current?.abort();
      failedRequestRef.current = null;
      setSelection(emptySelection());
      setCopyLimit(null);
      setLoadError(null);
      setViewError(null);
      setHeaderMenu(null);
      setFilterEditor(null);
      setWherePopupOpen(false);
      setSortPopupOpen(false);

      void prepareDataView(
        source.generation,
        revision,
        nextFilters,
        nextSort,
        viewSettings,
      ).then(
        (status) => {
          if (
            aliveRef.current &&
            pendingViewRef.current?.revision === revision
          ) {
            promoteView(
              status.revision,
              status.rowCount,
              nextFilters,
              nextSort,
            );
          }
        },
        async (error: unknown) => {
          if (
            !aliveRef.current ||
            pendingViewRef.current?.revision !== revision
          ) {
            return;
          }
          try {
            const status = await getDataViewStatus(source.generation);
            if (
              !aliveRef.current ||
              pendingViewRef.current?.revision !== revision
            ) {
              return;
            }
            if (status.revision === revision) {
              promoteView(
                status.revision,
                status.rowCount,
                nextFilters,
                nextSort,
              );
              return;
            }
            if (status.revision === activeViewRef.current.revision) {
              reloadActiveWindow();
            }
          } catch (statusError) {
            if (
              !aliveRef.current ||
              pendingViewRef.current?.revision !== revision
            ) {
              return;
            }
            setViewError(dataViewErrorState(statusError));
          }
          if (
            !aliveRef.current ||
            pendingViewRef.current?.revision !== revision
          ) {
            return;
          }
          pendingViewRef.current = null;
          setPendingView(null);
          if (
            !(error instanceof DataWindowCommandError) ||
            error.code !== "cancelled"
          ) {
            setViewError(dataViewErrorState(error));
          }
        },
      );
    },
    [
      promoteView,
      reloadActiveWindow,
      source.generation,
      source.rowCount,
      viewSettings,
    ],
  );

  const changeFilters = useCallback(
    (nextFilters: DataFilter[]) =>
      applyView(
        nextFilters,
        pendingViewRef.current?.sort ?? activeViewRef.current.sort,
      ),
    [applyView],
  );

  const changeSort = useCallback(
    (nextSort: SortColumn[]) =>
      applyView(
        pendingViewRef.current?.filters ?? activeViewRef.current.filters,
        nextSort,
      ),
    [applyView],
  );

  const cancelPendingView = useCallback(() => {
    const pending = pendingViewRef.current;
    if (pending === null) {
      return;
    }
    void (async () => {
      try {
        await cancelDataView(source.generation, pending.revision);
        if (pendingViewRef.current?.revision !== pending.revision) {
          return;
        }
        const status = await getDataViewStatus(source.generation);
        if (pendingViewRef.current?.revision !== pending.revision) {
          return;
        }
        if (status.revision === pending.revision) {
          promoteView(
            status.revision,
            status.rowCount,
            pending.filters,
            pending.sort,
          );
        } else if (status.revision === activeViewRef.current.revision) {
          reloadActiveWindow();
        }
      } catch (error: unknown) {
        if (pendingViewRef.current?.revision === pending.revision) {
          setViewError(dataViewErrorState(error));
        }
      } finally {
        if (pendingViewRef.current?.revision === pending.revision) {
          pendingViewRef.current = null;
          setPendingView(null);
        }
      }
    })();
  }, [promoteView, reloadActiveWindow, source.generation]);

  const loadCopyWindow = useCallback(
    (
      row: number,
      selectedSourceIndices: readonly number[],
      abortSignal: AbortSignal,
    ): Promise<ArrowDataWindow> => {
      const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
      const view = activeViewRef.current;
      const sourceIndices = [...selectedSourceIndices].sort(
        (left, right) => left - right,
      );
      const key = `${view.revision}:${offset}:${sourceIndices.join(",")}`;
      const existing = copyWindowsRef.current.get(key);
      if (existing !== undefined) {
        return existing;
      }

      const count = Math.min(COPY_CHUNK_ROWS, view.rowCount - offset);
      const request = copyTailRef.current.then(async () => {
        if (abortSignal.aborted) {
          throw new DOMException("Copy was cancelled.", "AbortError");
        }
        const bytes = await getDataWindow(
          source.generation,
          view.revision,
          offset,
          count,
          sourceIndices,
        );
        return decodeArrowWindow(bytes, offset, sourceIndices);
      });
      copyTailRef.current = request.then(
        () => undefined,
        () => undefined,
      );
      copyWindowsRef.current.set(key, request);
      const release = () => {
        queueMicrotask(() => {
          if (copyWindowsRef.current.get(key) === request) {
            copyWindowsRef.current.delete(key);
          }
        });
      };
      void request.then(release, release);
      return request;
    },
    [source.generation],
  );

  const loadCopyCells = useCallback(
    async (
      rows: readonly number[],
      columnIndices: readonly number[],
      abortSignal: AbortSignal,
    ): Promise<GridCell[][]> => {
      const selectedColumns = columnIndices.flatMap((index) => {
        const column = visibleColumnStates[index];
        return column === undefined ? [] : [column];
      });
      const sourceIndices = selectedColumns.map((column) => column.sourceIndex);
      const windows = new Map<number, ArrowDataWindow>();
      const cells: GridCell[][] = [];
      for (const row of rows) {
        if (abortSignal.aborted) {
          throw new DOMException("Copy was cancelled.", "AbortError");
        }
        const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
        let dataWindow = windows.get(offset);
        if (dataWindow === undefined) {
          dataWindow = await loadCopyWindow(row, sourceIndices, abortSignal);
          windows.set(offset, dataWindow);
        }
        cells.push(
          selectedColumns.map((_, column) =>
            readCell(dataWindow, column, row, selectedColumns, true),
          ),
        );
      }
      return cells;
    },
    [loadCopyWindow, readCell, visibleColumnStates],
  );

  const copySelection = useCallback(
    (event: ClipboardEvent) => {
      const shape = copySelectionShape(
        selection,
        gridRowCount,
        visibleColumnStates.length,
      );
      if (shape === null) {
        return;
      }
      event.preventDefault();
      copyAbortRef.current?.abort();
      const abortController = new AbortController();
      copyAbortRef.current = abortController;
      setCopyLimit(shape.truncated ? shape.rowLimit : null);
      const contents = loadCopyCells(
        shape.rows,
        shape.columnIndices,
        abortController.signal,
      ).then((cells) =>
        copyBufferContents(
          cells,
          shape.columnIndices.map((_, index) => index),
        ),
      );
      void gridClipboard
        .write(contents)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            failedRequestRef.current = null;
            setLoadError({ message: "The selection could not be copied." });
          }
        })
        .finally(() => {
          if (copyAbortRef.current === abortController) {
            copyAbortRef.current = null;
          }
        });
    },
    [gridRowCount, loadCopyCells, selection, visibleColumnStates.length],
  );

  const updateSelection = useCallback((next: GridSelection) => {
    setSelection(next);
    setCopyLimit(null);
  }, []);

  const resizeColumn = useCallback((visibleIndex: number, width: number) => {
    const sourceIndex =
      visibleColumnStatesRef.current[visibleIndex]?.sourceIndex;
    if (sourceIndex === undefined) {
      return;
    }
    const clampedWidth = Math.min(
      MAX_COLUMN_WIDTH,
      Math.max(MIN_COLUMN_WIDTH, width),
    );
    setColumnStates((current) =>
      current.map((column) =>
        column.sourceIndex === sourceIndex
          ? { ...column, width: clampedWidth }
          : column,
      ),
    );
  }, []);

  const updateHorizontalExtent = useCallback(
    (exceeded: boolean, totalWidth: number, safeExtent: number) => {
      setHorizontalExtentError(
        exceeded
          ? `The projected columns are ${Math.ceil(totalWidth - safeExtent).toLocaleString("en-US")} pixels wider than this webview can scroll.`
          : null,
      );
    },
    [],
  );

  const applyFittedColumnWidths = useCallback(
    (
      visibleColumns: readonly ColumnState[],
      dataWindow: ArrowDataWindow | null,
      sampleOffset = 0,
      sampleCount = 0,
    ) => {
      const context = document.createElement("canvas").getContext("2d");
      const fonts = gridFontStrings(getComputedStyle(document.documentElement));
      const widths = new Map<number, number>();
      for (const column of visibleColumns) {
        const dataType =
          dataWindow === null
            ? undefined
            : windowDataType(dataWindow, column.sourceIndex);
        const displayData: string[] = [];
        if (dataWindow !== null && dataType !== undefined) {
          const sampleEnd = Math.min(
            sampleOffset + sampleCount,
            dataWindow.rowOffset + dataWindow.rowCount,
          );
          for (
            let row = Math.max(sampleOffset, dataWindow.rowOffset);
            row < sampleEnd;
            row += 1
          ) {
            displayData.push(
              formatCellValue(
                windowValue(dataWindow, column.sourceIndex, row),
                dataType,
                false,
              ).displayData,
            );
          }
        }
        widths.set(
          column.sourceIndex,
          fittedColumnWidth(
            column.title,
            displayData,
            fonts.header,
            dataType !== undefined && usesMonospaceCells(dataType)
              ? fonts.monospaceCell
              : fonts.cell,
            context,
          ),
        );
      }
      setColumnStates((current) =>
        current.map((column) => {
          const width = widths.get(column.sourceIndex);
          return width === undefined ? column : { ...column, width };
        }),
      );
    },
    [],
  );

  const setColumnVisibility = useCallback(
    (sourceIndex: number, visible: boolean) => {
      setColumnStates((current) =>
        current.map((column) =>
          column.sourceIndex === sourceIndex
            ? {
                ...column,
                hidden: !visible,
                pinned: visible ? column.pinned : false,
              }
            : column,
        ),
      );
    },
    [],
  );

  const fitColumnWidths = useCallback(
    (visibleColumns: readonly ColumnState[]) => {
      if (visibleColumns.length === 0) {
        return;
      }
      const view = activeViewRef.current;
      const request = columnFitRequestRef.current + 1;
      columnFitRequestRef.current = request;
      if (view.rowCount === 0) {
        applyFittedColumnWidths(visibleColumns, null);
        return;
      }

      const visibleRegion = visibleViewportRef.current;
      const firstVisibleRow = visibleRegion?.rowStart ?? 0;
      const sampleOffset = Math.min(
        Math.max(0, firstVisibleRow),
        view.rowCount - 1,
      );
      const sampleCount = Math.min(
        Math.max(1, visibleRegion?.rowCount ?? GRID_INITIAL_ROWS),
        view.rowCount - sampleOffset,
      );
      const sourceIndices = visibleColumns
        .map((column) => column.sourceIndex)
        .sort((left, right) => left - right);
      void getDataWindow(
        source.generation,
        view.revision,
        sampleOffset,
        sampleCount,
        sourceIndices,
      )
        .then((bytes) => decodeArrowWindow(bytes, sampleOffset, sourceIndices))
        .then((dataWindow) => {
          if (
            aliveRef.current &&
            request === columnFitRequestRef.current &&
            view.revision === activeViewRef.current.revision
          ) {
            applyFittedColumnWidths(
              visibleColumns,
              dataWindow,
              sampleOffset,
              sampleCount,
            );
          }
        })
        .catch((error: unknown) => {
          if (
            aliveRef.current &&
            request === columnFitRequestRef.current &&
            view.revision === activeViewRef.current.revision
          ) {
            setLoadError(dataViewErrorState(error));
          }
        });
    },
    [applyFittedColumnWidths, source.generation],
  );

  const fitVisibleColumnWidths = useCallback(
    () => fitColumnWidths(visibleColumnStatesRef.current),
    [fitColumnWidths],
  );

  const fitColumnWidth = useCallback(
    (visibleIndex: number) => {
      const column = visibleColumnStatesRef.current[visibleIndex];
      if (column !== undefined) {
        fitColumnWidths([column]);
      }
    },
    [fitColumnWidths],
  );

  const showAllColumns = useCallback(() => {
    setColumnStates((current) =>
      current.map((column) => ({ ...column, hidden: false })),
    );
  }, []);

  const hideAllColumns = useCallback(() => {
    setColumnStates((current) =>
      current.map((column) => ({
        ...column,
        hidden: true,
        pinned: false,
      })),
    );
  }, []);

  const updateColumn = useCallback(
    (sourceIndex: number, update: Partial<ColumnState>) => {
      setColumnStates((current) =>
        current.map((column) =>
          column.sourceIndex === sourceIndex
            ? { ...column, ...update }
            : column,
        ),
      );
      setHeaderMenu(null);
      setGridMenu(null);
    },
    [],
  );

  const selectSchemaColumn = useCallback((sourceIndex: number) => {
    schemaFocusColumnRef.current = sourceIndex;
    setSelectedSchemaColumn(sourceIndex);
    setColumnStates((current) =>
      current.map((column) =>
        column.sourceIndex === sourceIndex
          ? { ...column, hidden: false }
          : column,
      ),
    );
    setSchemaFocusRequest((request) => request + 1);
  }, []);

  const openFilterForCell = useCallback(
    (sourceIndex: number, row: number, bounds: Rectangle) => {
      const field = source.schema[sourceIndex];
      const supplement = supplementWindowRef.current;
      const base = baseWindowRef.current;
      const current =
        supplement !== null &&
        windowContainsRow(supplement, row) &&
        supplement.sourceColumnOffsets.has(sourceIndex)
          ? supplement
          : base;
      if (
        field === undefined ||
        current === null ||
        !windowContainsRow(current, row)
      ) {
        return;
      }
      const value = windowValue(current, sourceIndex, row);
      const dataType = windowDataType(current, sourceIndex);
      const kind = columnFilterKind(field);
      const initialValue =
        value === null || value === undefined || dataType === undefined
          ? undefined
          : filterInputFromCell(value, dataType, field);
      setHeaderMenu(null);
      setFilterEditor({
        sourceIndex,
        left: Math.max(
          4,
          Math.min(bounds.x + bounds.width, window.innerWidth - 292),
        ),
        top: Math.max(4, Math.min(bounds.y, window.innerHeight - 268)),
        initialOperator:
          value === null || value === undefined
            ? "isNull"
            : kind === "nullOnly"
              ? "isNotNull"
              : defaultFilterOperator(kind),
        initialValue,
        gridAnchor: { kind: "cell", row },
      });
    },
    [source.schema],
  );

  const menuColumn =
    headerMenu === null
      ? undefined
      : columnStates.find(
          (column) => column.sourceIndex === headerMenu.sourceIndex,
        );
  const filterEditorField =
    filterEditor === null ? undefined : source.schema[filterEditor.sourceIndex];
  const exportBusy = exportStarting || exportStatus?.state === "running";
  const runningExportLabel =
    exportStatus?.state === "running"
      ? `Exporting ${exportStatus.fileName} (${formatBytes(exportStatus.bytesWritten)})…`
      : "Choosing export destination…";

  const editFilter = useCallback(
    (filterIndex: number, button: HTMLButtonElement) => {
      const filter = filters[filterIndex];
      if (filter === undefined) {
        return;
      }
      const bounds = button.getBoundingClientRect();
      setWherePopupOpen(false);
      setFilterEditor({
        sourceIndex: filter.columnIndex,
        filterIndex,
        initialFilter: filter,
        left: Math.max(4, Math.min(bounds.left, window.innerWidth - 292)),
        top: Math.max(4, Math.min(bounds.bottom + 4, window.innerHeight - 268)),
      });
    },
    [filters],
  );

  const toggleWherePopup = useCallback(() => {
    setSelectPopupOpen(false);
    setSortPopupOpen(false);
    if (!wherePopupOpen) {
      const bounds = wherePopupAnchorRef.current?.getBoundingClientRect();
      if (bounds !== undefined) {
        setWherePopupPosition(
          clampedWherePopupPosition(
            bounds,
            window.innerWidth,
            window.innerHeight,
          ),
        );
      }
    }
    setWherePopupOpen((open) => !open);
  }, [wherePopupOpen]);

  return (
    <section className="data-grid-view" aria-label="Data">
      <div className="query-row" aria-label="Query">
        <button
          className="schema-sidebar-toggle"
          type="button"
          aria-controls="schema-sidebar"
          aria-pressed={sidebarOpen}
          title={`Schema sidebar (${shortcutModifier}B)`}
          onClick={() => setSidebarOpen((open) => !open)}
        >
          Schema
        </button>
        <div className="query-expression">
          <span className="query-keyword">SELECT</span>
          <div ref={selectPopupRef} className="query-select-wrap">
            <button
              className="query-select"
              type="button"
              aria-expanded={selectPopupOpen}
              aria-haspopup="dialog"
              title={selectTitle}
              onClick={() => {
                setWherePopupOpen(false);
                setSortPopupOpen(false);
                setSelectPopupOpen((open) => !open);
              }}
            >
              {hiddenCount === 0
                ? "*"
                : `[${visibleColumnStates.length}/${columnStates.length} cols]`}
            </button>
            {selectPopupOpen && (
              <ColumnPicker
                columns={pickerColumns}
                onHideAll={hideAllColumns}
                onShowAll={showAllColumns}
                onToggle={setColumnVisibility}
                onTogglePinned={(sourceIndex, pinned) =>
                  updateColumn(sourceIndex, { pinned, hidden: false })
                }
              />
            )}
          </div>
          <span className="query-keyword">FROM</span>
          <span className="query-slot">this</span>
          <div ref={wherePopupAnchorRef} className="query-where-wrap">
            <span className="query-keyword">WHERE</span>
            <button
              className={`query-where ${whereClause.length === 0 ? "query-empty-slot" : ""}`}
              type="button"
              aria-expanded={wherePopupOpen}
              onClick={toggleWherePopup}
            >
              {whereClause || "⋯"}
            </button>
          </div>
          <div ref={sortPopupRef} className="query-order-wrap">
            <span className="query-keyword">ORDER BY</span>
            <button
              className={`query-order ${orderByClause.length === 0 ? "query-empty-slot" : ""}`}
              type="button"
              aria-expanded={sortPopupOpen}
              onClick={() => {
                setSelectPopupOpen(false);
                setWherePopupOpen(false);
                setSortDraft([
                  ...(pendingViewRef.current?.sort ??
                    activeViewRef.current.sort),
                ]);
                setSortPopupOpen((open) => !open);
              }}
            >
              {orderByClause || "⋯"}
            </button>
            {sortPopupOpen && (
              <div
                className="sort-popup"
                role="dialog"
                aria-label="ORDER BY columns"
              >
                {sortDraft.length === 0 ? (
                  <p>No ORDER BY columns.</p>
                ) : (
                  <ol>
                    {sortDraft.map((column, index) => (
                      <li key={column.sourceIndex}>
                        <code>{source.schema[column.sourceIndex]?.name}</code>
                        <select
                          aria-label={`Direction for ${source.schema[column.sourceIndex]?.name}`}
                          value={column.direction}
                          onChange={(event) =>
                            setSortDraft((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? {
                                      ...item,
                                      direction: event.target.value as
                                        "ascending" | "descending",
                                    }
                                  : item,
                              ),
                            )
                          }
                        >
                          <option value="ascending">ASC</option>
                          <option value="descending">DESC</option>
                        </select>
                        <button
                          type="button"
                          aria-label={`Move ${source.schema[column.sourceIndex]?.name} earlier`}
                          disabled={index === 0}
                          onClick={() =>
                            setSortDraft((current) =>
                              moveSortColumn(current, index, index - 1),
                            )
                          }
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={`Move ${source.schema[column.sourceIndex]?.name} later`}
                          disabled={index === sortDraft.length - 1}
                          onClick={() =>
                            setSortDraft((current) =>
                              moveSortColumn(current, index, index + 1),
                            )
                          }
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove sort ${source.schema[column.sourceIndex]?.name}`}
                          onClick={() =>
                            setSortDraft((current) =>
                              current.filter(
                                (_item, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
                <label>
                  Add column
                  <select
                    value=""
                    onChange={(event) => {
                      const sourceIndex = Number(event.target.value);
                      if (Number.isInteger(sourceIndex)) {
                        setSortDraft((current) => [
                          ...current,
                          { sourceIndex, direction: "ascending" },
                        ]);
                      }
                    }}
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {source.schema.map((field, sourceIndex) => (
                      <option
                        key={sourceIndex}
                        value={sourceIndex}
                        disabled={sortDraft.some(
                          (column) => column.sourceIndex === sourceIndex,
                        )}
                      >
                        {field.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sort-popup-actions">
                  <button type="button" onClick={() => setSortPopupOpen(false)}>
                    Cancel
                  </button>
                  <button type="button" onClick={() => changeSort(sortDraft)}>
                    Apply
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <span className="query-count" role="status">
          {pendingView !== null ? (
            <>
              preparing view…{" "}
              <button type="button" onClick={cancelPendingView}>
                cancel
              </button>
            </>
          ) : (
            `${activeView.rowCount.toLocaleString("en-US")} rows`
          )}
        </span>
        <button
          className="query-fit-widths"
          type="button"
          aria-label="Fit column widths"
          title="Fit column widths"
          onClick={fitVisibleColumnWidths}
        >
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
          >
            <path
              d="M2 2v12M14 2v12M2 8h12M5 5 2 8l3 3M11 5l3 3-3 3"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <button
          className="query-clear"
          type="button"
          aria-label="Clear WHERE and ORDER BY"
          title="Clear WHERE and ORDER BY"
          disabled={filters.length === 0 && sort.length === 0}
          onClick={() => applyView([], [])}
        >
          ×
        </button>
      </div>
      {((hiddenCount > 0 && visibleColumnStates.length > 0) ||
        copyLimit !== null) && (
        <div className="grid-controls">
          {copyLimit !== null && (
            <span role="status">
              {`This operation is limited to the first ${copyLimit.toLocaleString()} rows of the selection.`}
            </span>
          )}
          {hiddenCount > 0 && visibleColumnStates.length > 0 && (
            <>
              <span>{hiddenCount} hidden</span>
              <button type="button" onClick={showAllColumns}>
                Show all columns
              </button>
            </>
          )}
        </div>
      )}
      {loadError !== null && (
        <ViewErrorAlert
          key={loadError.diagnostics ?? loadError.message}
          error={loadError}
          dismissLabel="Dismiss window error"
          onRetry={failedRequestRef.current === null ? undefined : retryWindow}
          onDismiss={() => {
            failedRequestRef.current = null;
            setLoadError(null);
          }}
        />
      )}
      {horizontalExtentError !== null && (
        <ViewErrorAlert
          error={{ message: horizontalExtentError }}
          onDismiss={() => setHorizontalExtentError(null)}
        />
      )}
      {viewError !== null && (
        <ViewErrorAlert
          key={viewError.diagnostics ?? viewError.message}
          error={viewError}
          onDismiss={() => setViewError(null)}
        />
      )}
      <div className="data-grid-layout">
        <SchemaSidebar
          open={sidebarOpen}
          selectedColumn={selectedSchemaColumn}
          source={source}
          onSelectColumn={selectSchemaColumn}
        />
        {visibleColumnStates.length === 0 ? (
          <div className="filtered-empty-state">
            <p>No columns selected.</p>
            <button type="button" onClick={showAllColumns}>
              Show all columns
            </button>
          </div>
        ) : gridRowCount === 0 && filters.length > 0 ? (
          <div className="filtered-empty-state">
            <p>No rows match these conditions.</p>
            <button type="button" onClick={() => applyView([], sort)}>
              Clear filters
            </button>
          </div>
        ) : gridRowCount === 0 ? (
          <div className="filtered-empty-state">
            <p>This file has no rows.</p>
          </div>
        ) : (
          <div className="grid-container">
            <ViewdaGrid
              ref={gridRef}
              diagnostics={diagnostics}
              columns={columns}
              rowCount={gridRowCount}
              selection={selection}
              contentRevision={contentRevision}
              onSelectionChange={updateSelection}
              getCellContent={getCellContent}
              onCopy={copySelection}
              onCellContextMenu={(cell, bounds) => {
                const sourceIndex =
                  visibleColumnStates[cell.column]?.sourceIndex;
                if (sourceIndex === undefined) {
                  return;
                }
                setHeaderMenu(null);
                setGridMenu({
                  bounds,
                  row: cell.row,
                  sourceIndex,
                  left: Math.max(
                    4,
                    Math.min(bounds.x + bounds.width, window.innerWidth - 318),
                  ),
                  top: Math.max(
                    4,
                    Math.min(bounds.y, window.innerHeight - 148),
                  ),
                });
              }}
              onSort={(visibleIndex, additive) => {
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
                  const currentSort =
                    pendingViewRef.current?.sort ?? activeViewRef.current.sort;
                  changeSort(nextSort(currentSort, sourceIndex, additive));
                }
              }}
              onFilter={(visibleIndex, bounds) => {
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
                  setHeaderMenu(null);
                  setFilterEditor({
                    sourceIndex,
                    left: Math.max(
                      4,
                      Math.min(bounds.x, window.innerWidth - 292),
                    ),
                    top: Math.max(
                      4,
                      Math.min(
                        bounds.y + bounds.height,
                        window.innerHeight - 268,
                      ),
                    ),
                    gridAnchor: { kind: "header" },
                  });
                }
              }}
              onHeaderContextMenu={(visibleIndex, bounds) => {
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
                  setGridMenu(null);
                  setHeaderMenu({
                    sourceIndex,
                    left: Math.max(
                      4,
                      Math.min(bounds.x, window.innerWidth - 164),
                    ),
                    top: Math.max(
                      4,
                      Math.min(
                        bounds.y + bounds.height,
                        window.innerHeight - 108,
                      ),
                    ),
                  });
                }
              }}
              onViewportChange={(viewport) => {
                visibleViewportRef.current = viewport;
                requestRows(viewport.rowStart, viewport.rowCount);
                setHeaderMenu((current) =>
                  current !== null &&
                  gridAnchorIsMounted(
                    current.sourceIndex,
                    undefined,
                    visibleColumnStates,
                    viewport,
                  )
                    ? current
                    : null,
                );
                setGridMenu((current) =>
                  current !== null &&
                  gridAnchorIsMounted(
                    current.sourceIndex,
                    current.row,
                    visibleColumnStates,
                    viewport,
                  )
                    ? current
                    : null,
                );
                setFilterEditor((current) => {
                  if (current?.gridAnchor === undefined) {
                    return current;
                  }
                  const row =
                    current.gridAnchor.kind === "cell"
                      ? current.gridAnchor.row
                      : undefined;
                  return gridAnchorIsMounted(
                    current.sourceIndex,
                    row,
                    visibleColumnStates,
                    viewport,
                  )
                    ? current
                    : null;
                });
              }}
              onColumnResize={resizeColumn}
              onColumnAutoFit={fitColumnWidth}
              onHorizontalExtentChange={updateHorizontalExtent}
              onEscape={() => {
                setHeaderMenu(null);
                setGridMenu(null);
                setFilterEditor(null);
              }}
            />
          </div>
        )}
      </div>
      {wherePopupOpen && (
        <div
          ref={wherePopupRef}
          className="where-popup"
          role="dialog"
          aria-label="WHERE conditions"
          style={wherePopupPosition}
        >
          {filters.length === 0 ? (
            <p>No WHERE conditions.</p>
          ) : (
            <ol>
              {filters.map((filter, index) => {
                const field = source.schema[filter.columnIndex];
                if (field === undefined) {
                  return null;
                }
                const condition = formatFilterCondition(filter, field);
                return (
                  <li key={`${index}:${filter.columnIndex}`}>
                    <code>{condition}</code>
                    <span className="where-condition-actions">
                      <button
                        type="button"
                        onClick={(event) =>
                          editFilter(index, event.currentTarget)
                        }
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove filter ${condition}`}
                        onClick={() =>
                          changeFilters(
                            filters.filter(
                              (_condition, conditionIndex) =>
                                conditionIndex !== index,
                            ),
                          )
                        }
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      {headerMenu !== null && menuColumn !== undefined && (
        <div
          ref={menuRef}
          className="column-menu"
          role="menu"
          aria-label={`${menuColumn.title} column`}
          style={{ left: headerMenu.left, top: headerMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              updateColumn(menuColumn.sourceIndex, {
                pinned: !menuColumn.pinned,
              })
            }
          >
            {menuColumn.pinned ? "Unpin column" : "Pin column"}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={visibleColumnStates.length === 1}
            onClick={() =>
              updateColumn(menuColumn.sourceIndex, {
                hidden: true,
                pinned: false,
              })
            }
          >
            Hide column
          </button>
        </div>
      )}
      {gridMenu !== null && (
        <div
          ref={gridMenuRef}
          className="grid-menu"
          role="menu"
          aria-label="Data export"
          style={{ left: gridMenu.left, top: gridMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              openFilterForCell(
                gridMenu.sourceIndex,
                gridMenu.row,
                gridMenu.bounds,
              );
              setGridMenu(null);
            }}
          >
            Filter by this value…
          </button>
          <div className="grid-menu-separator" role="separator" />
          {selectedExport !== null && (
            <button
              type="button"
              role="menuitem"
              disabled={exportBusy}
              onClick={() => void startExport("selection")}
            >
              <span>
                {exportBusy
                  ? runningExportLabel
                  : `Export selection (${formatCount(selectedExport.rowCount)} × ${formatCount(selectedExport.columnCount)})…`}
              </span>
              {!exportBusy && (
                <span className="menu-shortcut">{shortcutModifier}Shift+E</span>
              )}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={exportBusy}
            onClick={() => void startExport("view")}
          >
            <span>
              {exportBusy
                ? runningExportLabel
                : `Export current view (${formatCount(gridRowCount)} rows)…`}
            </span>
            {!exportBusy && selectedExport === null && (
              <span className="menu-shortcut">{shortcutModifier}Shift+E</span>
            )}
          </button>
        </div>
      )}
      {(exportStatus !== null || exportError !== null) && (
        <ExportProgressPill
          status={exportStatus}
          error={exportError}
          onCancel={(id) => {
            void cancelDataExport(id).then(
              refreshExportStatus,
              refreshExportStatus,
            );
          }}
          onDismiss={(id) => {
            if (id === null) {
              setExportError(null);
              return;
            }
            const clearDismissed = () => {
              setExportStatus((current) =>
                current?.id === id ? null : current,
              );
            };
            void dismissDataExport(id).then(clearDismissed, clearDismissed);
          }}
          onReveal={(id) => {
            void revealDataExport(id).catch((error: unknown) => {
              setExportError({
                action: "reveal",
                code:
                  error instanceof DataExportCommandError
                    ? error.code
                    : "queryFailed",
              });
            });
          }}
        />
      )}
      {filterEditor !== null && filterEditorField !== undefined && (
        <FilterEditor
          request={filterEditor}
          field={filterEditorField}
          sourceGeneration={source.generation}
          nextSuggestionRevision={nextSuggestionRevision}
          onApply={(filter) =>
            changeFilters(
              filterEditor.filterIndex === undefined
                ? [...filters, filter]
                : filters.map((current, index) =>
                    index === filterEditor.filterIndex ? filter : current,
                  ),
            )
          }
          onCancel={() => setFilterEditor(null)}
        />
      )}
    </section>
  );
}

function ExportProgressPill({
  status,
  error,
  onCancel,
  onDismiss,
  onReveal,
}: {
  status: DataExportStatus | null;
  error: ExportUiError | null;
  onCancel: (id: number) => void;
  onDismiss: (id: number | null) => void;
  onReveal: (id: number) => void;
}) {
  if (error !== null) {
    return (
      <div className="export-progress is-error" role="alert">
        <span>{exportUiErrorMessage(error)}</span>
        <button type="button" onClick={() => onDismiss(null)}>
          Dismiss
        </button>
      </div>
    );
  }
  if (status === null) {
    return null;
  }
  if (status.state === "running") {
    return (
      <div className="export-progress" role="status" aria-live="off">
        <span>
          <strong>{status.fileName}</strong>
          {` · ${formatBytes(status.bytesWritten)} written`}
        </span>
        <button type="button" onClick={() => onCancel(status.id)}>
          Cancel
        </button>
      </div>
    );
  }
  if (status.state === "completed") {
    return (
      <div className="export-progress is-complete" role="status">
        <span>
          <strong>{status.fileName}</strong>
          {` · ${formatBytes(status.bytesWritten)} exported`}
        </span>
        <button type="button" onClick={() => onReveal(status.id)}>
          Reveal in folder
        </button>
        <button
          className="export-dismiss"
          type="button"
          aria-label="Dismiss export"
          onClick={() => onDismiss(status.id)}
        >
          ×
        </button>
      </div>
    );
  }
  return (
    <div
      className={`export-progress${status.state === "failed" ? " is-error" : ""}`}
      role={status.state === "failed" ? "alert" : "status"}
    >
      <span>
        {status.state === "cancelled"
          ? EXPORT_CANCELLED_MESSAGE
          : dataExportErrorMessage(status.error)}
      </span>
      <button type="button" onClick={() => onDismiss(status.id)}>
        Dismiss
      </button>
    </div>
  );
}

function formatCount(count: number): string {
  return count >= 1_000_000
    ? new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(count)
    : count.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_000) {
    return `${bytes.toLocaleString("en-US")} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1_000;
  let unit = units[0] ?? "KB";
  for (const next of units.slice(1)) {
    if (value < 1_000) {
      break;
    }
    value /= 1_000;
    unit = next;
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`;
}

const EXPORT_CANCELLED_MESSAGE = "Export cancelled · no file written.";

function exportUiErrorMessage(error: ExportUiError): string {
  if (error.action === "status") {
    return "Viewda could not refresh the export status.";
  }
  if (error.action === "reveal") {
    switch (error.code) {
      case "notFound":
        return "The exported file is no longer available.";
      case "permissionDenied":
        return "Viewda does not have permission to reveal the exported file.";
      default:
        return "The exported file could not be revealed.";
    }
  }
  return dataExportErrorMessage(error.code);
}

function dataExportErrorMessage(code: DataExportErrorCode): string {
  switch (code) {
    case "permissionDenied":
      return "Viewda does not have permission to write this file.";
    case "diskFull":
      return "There is not enough disk space to finish the export.";
    case "resourceExhausted":
      return "There is not enough memory to finish the export.";
    case "cancelled":
      return EXPORT_CANCELLED_MESSAGE;
    case "notFound":
    case "noSourceOpen":
      return "The source file is no longer available.";
    case "sourceChanged":
      return "The open file changed before the export started.";
    case "viewChanged":
      return "The data view changed before the export started.";
    case "notParquet":
    case "corruptSource":
      return "The open Parquet file is damaged or incomplete.";
    case "alreadyRunning":
      return "Another export is already running.";
    case "invalidRequest":
      return "This selection cannot be exported.";
    case "unsupported":
      return "This view cannot be exported.";
    case "queryEngineUnavailable":
      return "The packaged query engine could not start.";
    case "queryFailed":
      return "The query engine could not export this view.";
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement)
  );
}

function moveSortColumn(
  sort: readonly SortColumn[],
  from: number,
  to: number,
): SortColumn[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= sort.length ||
    to >= sort.length
  ) {
    return [...sort];
  }
  const next = [...sort];
  const [column] = next.splice(from, 1);
  if (column !== undefined) {
    next.splice(to, 0, column);
  }
  return next;
}

function emptySelection(): GridSelection {
  return {
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
  };
}

function clearColumnSelection(selection: GridSelection): GridSelection {
  if (
    selection.current === undefined &&
    selection.columns.length === 0 &&
    selection.columnAnchor === undefined
  ) {
    return selection;
  }
  const cleared: GridSelection = {
    columns: CompactSelection.empty(),
    rows: selection.rows,
  };
  if (selection.rowAnchor !== undefined) {
    cleared.rowAnchor = selection.rowAnchor;
  }
  return cleared;
}

function gridAnchorIsMounted(
  sourceIndex: number,
  row: number | undefined,
  visibleColumns: readonly ColumnState[],
  viewport: GridViewport,
): boolean {
  const visibleIndex = visibleColumnIndex(sourceIndex, visibleColumns);
  if (visibleIndex < 0) {
    return false;
  }
  if (!viewport.mountedColumnIndices.includes(visibleIndex)) {
    return false;
  }
  return (
    row === undefined ||
    (row >= viewport.mountedRowStart &&
      row < viewport.mountedRowStart + viewport.mountedRowCount)
  );
}

function visibleColumnIndex(
  sourceIndex: number,
  visibleColumns: readonly ColumnState[],
): number {
  return visibleColumns.findIndex(
    (column) => column.sourceIndex === sourceIndex,
  );
}

function sameColumnOrder(
  previous: readonly number[],
  current: readonly number[],
): boolean {
  return previous.every((sourceIndex, index) => sourceIndex === current[index]);
}

function sameColumnSet(
  previous: readonly number[],
  current: readonly number[],
): boolean {
  return (
    previous.length === current.length && projectionContains(previous, current)
  );
}

function projectionFingerprint(sourceIndices: readonly number[]): string {
  let hash = 0x811c9dc5;
  let contiguous = true;
  for (let index = 0; index < sourceIndices.length; index += 1) {
    const sourceIndex = sourceIndices[index] ?? 0;
    hash = Math.imul(hash ^ sourceIndex, 0x01000193) >>> 0;
    if (index > 0 && sourceIndex !== (sourceIndices[index - 1] ?? 0) + 1) {
      contiguous = false;
    }
  }
  return `${sourceIndices[0] ?? "-"}:${sourceIndices.at(-1) ?? "-"}:${
    contiguous ? "c" : "s"
  }:${hash.toString(16).padStart(8, "0")}`;
}

function loadingCell(): GridCell {
  return { kind: "loading" };
}

interface CopySelectionShape {
  rows: number[];
  columnIndices: number[];
  rowLimit: number;
  truncated: boolean;
}

function copySelectionShape(
  selection: GridSelection,
  rowCount: number,
  columnCount: number,
): CopySelectionShape | null {
  if (rowCount === 0 || columnCount === 0) {
    return null;
  }
  const scope = boundedSelectionScope(selection, rowCount, columnCount);
  if (scope === null) {
    return null;
  }
  const rowLimit = copyRowLimit(scope.columnIndices.length);
  const rows: number[] = [];
  for (const [start, end] of scope.rowRanges) {
    for (let row = start; row < end && rows.length < rowLimit; row += 1) {
      rows.push(row);
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return {
    rows,
    columnIndices: scope.columnIndices,
    rowLimit,
    truncated: scope.rowCount > rows.length,
  };
}

function dataWindowErrorMessage(error: unknown): string {
  if (error instanceof DataWindowCommandError) {
    if (error.code === "sourceChanged") {
      return "The open file changed before this window finished loading.";
    }
    if (error.code === "notFound" || error.code === "noSourceOpen") {
      return "The open file is no longer available.";
    }
    if (error.code === "permissionDenied") {
      return "Viewda no longer has permission to read this file.";
    }
    if (error.code === "corruptSource" || error.code === "notParquet") {
      return "The open Parquet file is damaged or incomplete.";
    }
    if (error.code === "invalidFilter") {
      return "This condition does not match its column type or exceeds the limits of 32 conditions, 100 list values, and 4 KB per value.";
    }
    if (error.code === "resourceExhausted") {
      return "There is not enough memory or temporary disk space to prepare this view.";
    }
    if (error.code === "memoryExhausted") {
      return error.diagnostics?.operation === "window"
        ? "There is not enough memory to load this window."
        : "There is not enough memory to prepare this view.";
    }
    if (error.code === "temporaryStorageExhausted") {
      return error.diagnostics?.operation === "window"
        ? "There is not enough temporary disk space to load this window."
        : "There is not enough temporary disk space to prepare this view.";
    }
    if (error.code === "queryFailed") {
      return "The query engine could not read this data.";
    }
    if (error.code === "invalidSort") {
      return "This sort order is invalid. Use each column once and at most 32 columns.";
    }
  }
  return "This data window could not be loaded.";
}

function dataViewErrorState(error: unknown): ViewErrorState {
  const message = dataWindowErrorMessage(error);
  if (
    !(error instanceof DataWindowCommandError) ||
    error.diagnostics === undefined ||
    (error.code !== "memoryExhausted" &&
      error.code !== "temporaryStorageExhausted")
  ) {
    return { message };
  }
  return {
    message,
    diagnostics: formatDataViewResourceDiagnostics(
      error.code,
      error.diagnostics,
    ),
  };
}

function formatDataViewResourceDiagnostics(
  code: "memoryExhausted" | "temporaryStorageExhausted",
  diagnostics: DataViewResourceDiagnostics,
): string {
  const sortColumns = diagnostics.sortColumns
    .map((column) => {
      const logicalType =
        column.logicalType === null ? "" : ` · ${column.logicalType}`;
      return `${column.physicalType}${logicalType} ${column.direction.toUpperCase()}`;
    })
    .join(", ");
  return [
    `Viewda: ${diagnostics.applicationVersion}`,
    `Platform: ${diagnostics.operatingSystem} ${diagnostics.architecture}`,
    `DuckDB: ${diagnostics.queryEngineVersion}`,
    `Operation: ${diagnostics.operation}`,
    `Failure: ${code === "memoryExhausted" ? "memory" : "temporary storage"}`,
    `DuckDB message: ${diagnostics.message}`,
    `Memory limit: ${diagnostics.memoryLimit}`,
    `Temporary storage limit: ${diagnostics.maxTemporaryDirectorySize}`,
    `Threads: ${diagnostics.threads}`,
    `Source size: ${diagnostics.sourceSizeBytes} bytes`,
    `Rows: ${diagnostics.rowCount}`,
    `Row groups: ${diagnostics.rowGroupCount}`,
    `Columns: ${diagnostics.columnCount}`,
    `Filters: ${diagnostics.filterCount}`,
    `Sort: ${sortColumns.length === 0 ? "none" : sortColumns}`,
  ].join("\n");
}

function clampedWherePopupPosition(
  anchor: Pick<DOMRect, "left" | "bottom">,
  viewportWidth: number,
  viewportHeight: number,
): { left: number; top: number } {
  const popupWidth = Math.min(
    WHERE_POPUP_MAX_WIDTH,
    Math.max(0, viewportWidth - WHERE_POPUP_MARGIN * 2),
  );
  return {
    left: Math.max(
      WHERE_POPUP_MARGIN,
      Math.min(
        anchor.left + WHERE_POPUP_OFFSET,
        viewportWidth - WHERE_POPUP_MARGIN - popupWidth,
      ),
    ),
    top: Math.max(
      WHERE_POPUP_MARGIN,
      Math.min(anchor.bottom + 8, viewportHeight - WHERE_POPUP_MARGIN),
    ),
  };
}
