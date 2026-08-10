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
import { THEME_CHANGED_EVENT } from "../theme";
import {
  decodeArrowWindow,
  windowContainsRow,
  windowDataType,
  windowValue,
  type ArrowDataWindow,
} from "./arrow-window";
import { writeClipboardContents } from "./clipboard";
import { copyRowLimit } from "./copy-limit";
import { projectedSourceIndices, projectionContains } from "./column-window";
import { exportSelectionShape } from "./export-selection";
import { formatCellValue, usesMonospaceCells } from "./format-cell";
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
import { nextSort, sortIndicator } from "./sort";
import { ColumnPicker } from "./ColumnPicker";
import {
  CompactSelection,
  getCopyBufferContents,
  GridCellKind,
  type CellArray,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Rectangle,
} from "./grid-model";
import {
  GRID_CELL_HORIZONTAL_PADDING,
  GRID_ESTIMATED_CHARACTER_WIDTH,
  GRID_FONT_SIZE,
  GRID_HEADER_FONT_WEIGHT,
  GRID_HEADER_RESERVED_SPACE,
} from "./grid-layout";
import { RegularTableGrid, type RegularTableGridRef } from "./RegularTableGrid";

const INITIAL_ROWS = 64;
const INITIAL_COLUMNS = 8;
const COPY_CHUNK_ROWS = 512;
const EXPORT_STATUS_POLL_MS = 1_000;
const MAX_CACHED_CELLS = 20_000;
const MIN_COLUMN_WIDTH = 64;
const MAX_COLUMN_WIDTH = 500;
const SORT_HEADER_HITBOX_START = 4;
const SORT_HEADER_HITBOX_END = 32;
const WHERE_POPUP_MARGIN = 16;
const WHERE_POPUP_MAX_WIDTH = 680;
const WHERE_POPUP_OFFSET = -42;
const SELECT_TOOLTIP_COLUMN_LIMIT = 50;
const DEFAULT_COLUMN_WIDTH = 280;
const COLUMN_SCROLL_PADDING = 16;
const GRID_HEADER_FONT_STYLE = `${GRID_HEADER_FONT_WEIGHT} ${GRID_FONT_SIZE}px`;
const GRID_BASE_FONT_STYLE = `${GRID_FONT_SIZE}px`;
const GRID_FIT_SAFETY = 8;
const DEFAULT_DATA_VIEW_SETTINGS: DataViewSettings = { memoryLimit: "mb384" };

function fittedColumnWidth(
  title: string,
  displayData: readonly string[],
  headerFontFamily: string,
  cellFontFamily: string,
  context: CanvasRenderingContext2D | null,
) {
  if (context !== null) {
    context.font = `${GRID_HEADER_FONT_STYLE} ${headerFontFamily}`;
  }
  const headerTextWidth =
    context?.measureText(title).width ??
    title.length * GRID_ESTIMATED_CHARACTER_WIDTH;
  let contentWidth = 0;
  if (context !== null) {
    context.font = `${GRID_BASE_FONT_STYLE} ${cellFontFamily}`;
  }
  for (const value of displayData) {
    const line = value.split("\n", 1)[0] ?? "";
    const textWidth =
      context?.measureText(line).width ??
      line.length * GRID_ESTIMATED_CHARACTER_WIDTH;
    contentWidth = Math.max(
      contentWidth,
      textWidth + GRID_CELL_HORIZONTAL_PADDING * 2 + GRID_FIT_SAFETY,
    );
  }
  return Math.min(
    MAX_COLUMN_WIDTH,
    Math.max(
      MIN_COLUMN_WIDTH,
      Math.ceil(
        Math.max(
          headerTextWidth + GRID_HEADER_RESERVED_SPACE + GRID_FIT_SAFETY,
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

interface ColumnResizeGesture {
  visibleIndex: number;
  moved: boolean;
}

interface HeaderMenu {
  sourceIndex: number;
  left: number;
  top: number;
}

interface GridMenu {
  bounds: Rectangle;
  cell: readonly [number, number];
  left: number;
  top: number;
}

interface ExportUiError {
  action: "export" | "reveal" | "status";
  code: DataExportErrorCode;
}

interface VersionedRowRequest {
  rows: RowRequest;
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
    candidate.revision === requested.revision &&
    candidate.projectionRevision === requested.projectionRevision &&
    requestSatisfiesRequest(candidate.rows, requested.rows) &&
    projectionContains(candidate.sourceIndices, requested.sourceIndices)
  );
}

function requestContainsVisibleWindow(
  candidate: VersionedRowRequest,
  requested: VersionedRowRequest,
): boolean {
  return (
    candidate.revision === requested.revision &&
    candidate.projectionRevision === requested.projectionRevision &&
    requestContainsVisibleRows(candidate.rows, requested.rows) &&
    projectionContains(candidate.sourceIndices, requested.sourceIndices)
  );
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
}: {
  source: SourceSummary;
  viewSettings?: DataViewSettings;
}) {
  const [columnStates, setColumnStates] = useState<ColumnState[]>(() =>
    source.schema.map((field, sourceIndex) => ({
      sourceIndex,
      title: field.name,
      width: Math.min(
        DEFAULT_COLUMN_WIDTH,
        Math.max(
          MIN_COLUMN_WIDTH,
          field.name.length * GRID_ESTIMATED_CHARACTER_WIDTH +
            GRID_HEADER_RESERVED_SPACE,
        ),
      ),
      pinned: false,
      hidden: false,
    })),
  );
  const [monospaceColumns, setMonospaceColumns] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [loadError, setLoadError] = useState<ViewErrorState | null>(null);
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
  const [filterEditor, setFilterEditor] = useState<FilterEditorRequest | null>(
    null,
  );
  const [activeView, setActiveView] = useState<ActiveView>(() => ({
    revision: 0,
    filters: [],
    sort: [],
    rowCount: source.rowCount,
  }));
  const [gridInstanceKey, setGridInstanceKey] = useState(0);
  const [pendingView, setPendingView] = useState<PendingView | null>(null);
  const [selectPopupOpen, setSelectPopupOpen] = useState(false);
  const [wherePopupOpen, setWherePopupOpen] = useState(false);
  const [wherePopupLeft, setWherePopupLeft] = useState(WHERE_POPUP_OFFSET);
  const [sortPopupOpen, setSortPopupOpen] = useState(false);
  const [sortDraft, setSortDraft] = useState<SortColumn[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSchemaColumn, setSelectedSchemaColumn] = useState<
    number | null
  >(null);
  const [schemaFocusRequest, setSchemaFocusRequest] = useState(0);
  const gridRef = useRef<RegularTableGridRef>(null);
  const gridCanvasRef = useRef<HTMLDivElement>(null);
  const schemaFocusColumnRef = useRef<number | null>(null);
  const visibleColumnStatesRef = useRef<readonly ColumnState[]>([]);
  const dataWindowRef = useRef<ArrowDataWindow | null>(null);
  const visibleRegionsRef = useRef<readonly Rectangle[]>([]);
  const cellCacheRef = useRef(new Map<number, GridCell>());
  const copyTailRef = useRef<Promise<void>>(Promise.resolve());
  const copyWindowsRef = useRef(new Map<string, Promise<ArrowDataWindow>>());
  const pendingRequestRef = useRef<VersionedRowRequest | null>(null);
  const activeRequestRef = useRef<VersionedRowRequest | null>(null);
  const failedRequestRef = useRef<VersionedRowRequest | null>(null);
  const activeViewRef = useRef(activeView);
  const pendingViewRef = useRef<PendingView | null>(null);
  const nextViewRevisionRef = useRef(0);
  const nextSuggestionRevisionRef = useRef(0);
  const projectionRevisionRef = useRef(0);
  const previousProjectionRef = useRef<readonly number[] | null>(null);
  const scrollStateRef = useRef<ScrollState>({ direction: 0, boundary: 0 });
  const aliveRef = useRef(true);
  const exportStatusFailuresRef = useRef(0);
  const suppressHeaderMenuRef = useRef(false);
  const suppressHeaderMenuTimerRef = useRef<number | null>(null);
  const columnResizeGestureRef = useRef<ColumnResizeGesture | null>(null);
  const columnFitRequestRef = useRef(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const gridMenuRef = useRef<HTMLDivElement>(null);
  const selectPopupRef = useRef<HTMLDivElement>(null);
  const wherePopupRef = useRef<HTMLDivElement>(null);
  const sortPopupRef = useRef<HTMLDivElement>(null);

  const visibleColumnStates = useMemo(
    () => [
      ...columnStates.filter((column) => column.pinned && !column.hidden),
      ...columnStates.filter((column) => !column.pinned && !column.hidden),
    ],
    [columnStates],
  );
  visibleColumnStatesRef.current = visibleColumnStates;
  const hiddenCount = columnStates.length - visibleColumnStates.length;
  const pinnedCount = visibleColumnStates.filter(
    (column) => column.pinned,
  ).length;
  const gridFonts = useGridFonts();
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
        gridRef.current?.refresh();
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const columns = useMemo<GridColumn[]>(
    () =>
      visibleColumnStates.map((column) => {
        return {
          title: column.title,
          width: column.width,
          monospace: monospaceColumns.has(column.sourceIndex),
          sort: sortIndicator(sort, column.sourceIndex),
        };
      }),
    [monospaceColumns, sort, visibleColumnStates],
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
        kind: GridCellKind.Text,
        displayData: formatted.displayData,
        copyData: formatted.copyData,
        contentAlign: formatted.align,
        style: formatted.faded ? "faded" : "normal",
      };
    },
    [visibleColumnStates],
  );

  const getCellContent = useCallback(
    ([column, row]: readonly [number, number]): GridCell => {
      const current = dataWindowRef.current;
      const sourceIndex = visibleColumnStates[column]?.sourceIndex;
      if (current === null || sourceIndex === undefined) {
        return loadingCell();
      }
      const key =
        (row - current.rowOffset) * source.schema.length + sourceIndex;
      const cached = cellCacheRef.current.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const cell = readCell(current, column, row);
      if (cellCacheRef.current.size >= MAX_CACHED_CELLS) {
        cellCacheRef.current.clear();
      }
      cellCacheRef.current.set(key, cell);
      return cell;
    },
    [readCell, source.schema.length, visibleColumnStates],
  );

  const promoteView = useCallback(
    (
      revision: number,
      rowCount: number,
      filters: DataFilter[],
      sort: SortColumn[],
    ) => {
      const next = { revision, rowCount, filters, sort };
      const visible = visibleRegionsRef.current[0];
      if (
        visible !== undefined &&
        clampedVisibleStart(rowCount, visible.y, visible.height) !== visible.y
      ) {
        // Remount when the active view shrinks past the current logical offset so the
        // virtual table can reach the clamped row.
        setGridInstanceKey((current) => current + 1);
      }
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
      pendingRequestRef.current = null;
      failedRequestRef.current = null;
      dataWindowRef.current = null;
      cellCacheRef.current.clear();
      copyWindowsRef.current.clear();
      setSelection(emptySelection());
      setCopyLimit(null);
      setGridMenu(null);
      gridRef.current?.refresh();
    },
    [],
  );

  const drainRequests = useCallback(async () => {
    if (activeRequestRef.current !== null) {
      return;
    }

    while (aliveRef.current && pendingRequestRef.current !== null) {
      const request = pendingRequestRef.current;
      pendingRequestRef.current = null;
      activeRequestRef.current = request;
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
        if (
          !aliveRef.current ||
          request.revision !== activeViewRef.current.revision ||
          request.projectionRevision !== projectionRevisionRef.current
        ) {
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
        const pending = pendingRequestRef.current as VersionedRowRequest | null;
        if (pending !== null && requestSatisfiesWindow(request, pending)) {
          pendingRequestRef.current = null;
        }
        const latest = pendingRequestRef.current as VersionedRowRequest | null;
        if (
          (latest === null ||
            latest.revision !== request.revision ||
            requestContainsVisibleWindow(request, latest)) &&
          windowCoversVisibleViewport(
            decoded,
            visibleColumnStatesRef.current,
            visibleRegionsRef.current,
            activeViewRef.current.rowCount,
          )
        ) {
          dataWindowRef.current = decoded;
          failedRequestRef.current = null;
          cellCacheRef.current.clear();
          gridRef.current?.refresh();
          setLoadError(null);
        }
      } catch (error) {
        if (
          !aliveRef.current ||
          request.projectionRevision !== projectionRevisionRef.current
        ) {
          continue;
        }
        if (
          error instanceof DataWindowCommandError &&
          error.code === "viewChanged"
        ) {
          try {
            const status = await getDataViewStatus(source.generation);
            const pending = pendingViewRef.current;
            const active = activeViewRef.current;
            if (pending?.revision === status.revision) {
              promoteView(
                status.revision,
                status.rowCount,
                pending.filters,
                pending.sort,
              );
            } else if (active.revision === status.revision) {
              pendingRequestRef.current = {
                rows: request.rows,
                revision: active.revision,
                projectionRevision: request.projectionRevision,
                sourceIndices: request.sourceIndices,
              };
            } else {
              setLoadError({
                message: "The active data view could not be synchronized.",
              });
            }
          } catch (statusError) {
            setLoadError(dataViewErrorState(statusError));
          }
          continue;
        }
        if (
          aliveRef.current &&
          request.revision === activeViewRef.current.revision &&
          request.projectionRevision === projectionRevisionRef.current &&
          pendingRequestRef.current === null
        ) {
          failedRequestRef.current = request;
          setLoadError(dataViewErrorState(error));
        }
      } finally {
        activeRequestRef.current = null;
      }
    }
  }, [promoteView, source.generation]);

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
        visibleRegionsRef.current,
        INITIAL_COLUMNS,
      );
      if (sourceIndices.length === 0) {
        return;
      }
      const requestedWindow: VersionedRowRequest = {
        rows: request,
        revision: activeView.revision,
        projectionRevision: projectionRevisionRef.current,
        sourceIndices,
      };
      const current = dataWindowRef.current;
      if (
        current !== null &&
        windowSatisfiesRequest(current.rowOffset, current.rowCount, request) &&
        projectionContains(current.sourceIndices, sourceIndices)
      ) {
        return;
      }
      const pending = pendingRequestRef.current;
      if (
        pending !== null &&
        requestSatisfiesWindow(pending, requestedWindow)
      ) {
        return;
      }
      const active = activeRequestRef.current;
      if (active !== null && requestSatisfiesWindow(active, requestedWindow)) {
        return;
      }
      pendingRequestRef.current = requestedWindow;
      void drainRequests();
    },
    [drainRequests],
  );

  const retryWindow = useCallback(() => {
    const failed = failedRequestRef.current;
    if (
      failed === null ||
      failed.revision !== activeViewRef.current.revision ||
      failed.projectionRevision !== projectionRevisionRef.current
    ) {
      return;
    }
    failedRequestRef.current = null;
    pendingRequestRef.current = failed;
    setLoadError(null);
    void drainRequests();
  }, [drainRequests]);

  const reloadActiveWindow = useCallback(() => {
    const active = activeViewRef.current;
    failedRequestRef.current = null;
    pendingRequestRef.current = null;
    dataWindowRef.current = null;
    cellCacheRef.current.clear();
    if (active.rowCount === 0) {
      return;
    }
    const visible = visibleRegionsRef.current[0];
    requestRows(
      visible?.y ?? 0,
      visible?.height ?? Math.min(INITIAL_ROWS, active.rowCount),
    );
  }, [requestRows]);

  useEffect(() => {
    const previous = previousProjectionRef.current;
    previousProjectionRef.current = visibleSourceIndices;
    if (previous === null) {
      return;
    }
    if (
      previous.length === visibleSourceIndices.length &&
      projectionContains(previous, visibleSourceIndices)
    ) {
      if (!sameColumnOrder(previous, visibleSourceIndices)) {
        setSelection(clearColumnSelection);
        setCopyLimit(null);
        setGridMenu(null);
      }
      return;
    }
    projectionRevisionRef.current += 1;
    pendingRequestRef.current = null;
    failedRequestRef.current = null;
    dataWindowRef.current = null;
    cellCacheRef.current.clear();
    copyWindowsRef.current.clear();
    setLoadError(null);
    setSelection(clearColumnSelection);
    setCopyLimit(null);
    setGridMenu(null);
    gridRef.current?.refresh();
  }, [visibleSourceIndices]);

  useEffect(() => {
    aliveRef.current = true;
    if (activeView.rowCount > 0) {
      const visible = visibleRegionsRef.current[0];
      const visibleCount =
        visible?.height ?? Math.min(INITIAL_ROWS, activeView.rowCount);
      const visibleStart = clampedVisibleStart(
        activeView.rowCount,
        visible?.y ?? 0,
        visibleCount,
      );
      if (visible !== undefined && visibleStart !== visible.y) {
        visibleRegionsRef.current = visibleRegionsRef.current.map((region) => ({
          ...region,
          y: visibleStart,
          height: Math.min(region.height, activeView.rowCount - visibleStart),
        }));
        scrollStateRef.current = { direction: 0, boundary: visibleStart };
        gridRef.current?.scrollToRow(visibleStart);
      }
      requestRows(visibleStart, visibleCount);
    }
    return () => {
      aliveRef.current = false;
      pendingRequestRef.current = null;
      failedRequestRef.current = null;
    };
  }, [
    activeView.revision,
    activeView.rowCount,
    requestRows,
    visibleColumnStates,
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
    void getDataExportStatus().then(
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
      if (!wherePopupRef.current?.contains(event.target as Node)) {
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
  }, []);

  useEffect(() => {
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
  }, [selectedExport, startExport]);

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
    gridRef.current?.scrollToColumn(visibleIndex, COLUMN_SCROLL_PADDING);
    setSelection({
      columns: CompactSelection.fromSingleSelection(visibleIndex),
      rows: CompactSelection.empty(),
    });
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

  const getCellsForSelection = useCallback(
    async (rectangle: Rectangle, abortSignal: AbortSignal) => {
      const selectedColumns = visibleColumnStates.slice(
        rectangle.x,
        rectangle.x + rectangle.width,
      );
      const selectedSourceIndices = selectedColumns.map(
        (column) => column.sourceIndex,
      );
      const rows: GridCell[][] = [];
      const rowLimit = copyRowLimit(
        selection.columns.length > 0
          ? selection.columns.length
          : rectangle.width,
      );
      const requestedEnd = Math.min(
        gridRowCount,
        rectangle.y + rectangle.height,
      );
      const end = Math.min(requestedEnd, rectangle.y + rowLimit);
      if (end < requestedEnd) {
        setCopyLimit(rowLimit);
      }

      for (let offset = rectangle.y; offset < end;) {
        if (abortSignal.aborted) {
          return [];
        }
        const window = await loadCopyWindow(
          offset,
          selectedSourceIndices,
          abortSignal,
        );
        const windowEnd = Math.min(end, window.rowOffset + window.rowCount);
        for (let row = offset; row < windowEnd; row += 1) {
          rows.push(
            selectedColumns.map((_, column) =>
              readCell(window, column, row, selectedColumns, true),
            ),
          );
        }
        if (windowEnd <= offset) {
          break;
        }
        offset = windowEnd;
      }

      return rows satisfies CellArray;
    },
    [
      loadCopyWindow,
      readCell,
      selection.columns.length,
      gridRowCount,
      visibleColumnStates,
    ],
  );

  const copyCappedRowSelection = useCallback(
    async (rowLimit: number) => {
      const selectedRows = takeCompactSelection(selection.rows, rowLimit);
      const rowsByWindow = new Map<number, number[]>();
      for (const row of selectedRows) {
        const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
        const rows = rowsByWindow.get(offset) ?? [];
        rows.push(row);
        rowsByWindow.set(offset, rows);
      }
      const abortController = new AbortController();
      const cells: GridCell[][] = [];
      for (const rows of rowsByWindow.values()) {
        const dataWindow = await loadCopyWindow(
          rows[0] ?? 0,
          visibleSourceIndices,
          abortController.signal,
        );
        for (const row of rows) {
          cells.push(
            visibleColumnStates.map((_, column) =>
              readCell(dataWindow, column, row, visibleColumnStates, true),
            ),
          );
        }
      }
      const columnIndices = visibleColumnStates.map((_, index) => index);
      return getCopyBufferContents(cells, columnIndices);
    },
    [
      loadCopyWindow,
      readCell,
      selection.rows,
      visibleColumnStates,
      visibleSourceIndices,
    ],
  );

  useEffect(() => {
    const copyRows = (event: ClipboardEvent) => {
      const rowLimit = copyRowLimit(visibleColumnStates.length);
      if (
        selection.current !== undefined ||
        selection.rows.length <= rowLimit ||
        !gridCanvasRef.current?.contains(document.activeElement)
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setCopyLimit(rowLimit);
      void writeClipboardContents(copyCappedRowSelection(rowLimit)).catch(
        () => {
          failedRequestRef.current = null;
          setLoadError({ message: "The selected rows could not be copied." });
        },
      );
    };
    window.addEventListener("copy", copyRows, true);
    return () => window.removeEventListener("copy", copyRows, true);
  }, [copyCappedRowSelection, selection, visibleColumnStates.length]);

  const updateSelection = useCallback((next: GridSelection) => {
    setSelection(next);
    setCopyLimit(null);
  }, []);

  const resizeColumn = useCallback((width: number, visibleIndex: number) => {
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

  const clearColumnResize = useCallback(() => {
    if (suppressHeaderMenuTimerRef.current !== null) {
      window.clearTimeout(suppressHeaderMenuTimerRef.current);
      suppressHeaderMenuTimerRef.current = null;
    }
    columnResizeGestureRef.current = null;
    suppressHeaderMenuRef.current = false;
  }, []);

  const startColumnResize = useCallback(
    (visibleIndex: number) => {
      clearColumnResize();
      columnResizeGestureRef.current = { visibleIndex, moved: false };
      suppressHeaderMenuRef.current = true;
      setHeaderMenu(null);
    },
    [clearColumnResize],
  );

  const resizeColumnDuringGesture = useCallback(
    (width: number, visibleIndex: number) => {
      const gesture = columnResizeGestureRef.current;
      if (gesture === null || visibleIndex !== gesture.visibleIndex) {
        return;
      }
      gesture.moved = true;
      resizeColumn(width, visibleIndex);
    },
    [resizeColumn],
  );

  const finishColumnResize = useCallback(
    (width: number, visibleIndex: number) => {
      // An end event is valid only after the primary column emitted a resize.
      if (columnResizeGestureRef.current?.moved === true) {
        resizeColumn(width, visibleIndex);
      }
      columnResizeGestureRef.current = null;
      if (suppressHeaderMenuTimerRef.current !== null) {
        window.clearTimeout(suppressHeaderMenuTimerRef.current);
      }
      // Keep the menu guard through the click synthesized from mouseup.
      suppressHeaderMenuTimerRef.current = window.setTimeout(() => {
        suppressHeaderMenuRef.current = false;
        suppressHeaderMenuTimerRef.current = null;
      }, 0);
    },
    [resizeColumn],
  );

  useEffect(
    () => () => {
      if (suppressHeaderMenuTimerRef.current !== null) {
        window.clearTimeout(suppressHeaderMenuTimerRef.current);
      }
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
              ).displayData,
            );
          }
        }
        widths.set(
          column.sourceIndex,
          fittedColumnWidth(
            column.title,
            displayData,
            gridFonts.fontFamily,
            dataType !== undefined && usesMonospaceCells(dataType)
              ? gridFonts.monospaceFontFamily
              : gridFonts.fontFamily,
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
    [gridFonts.fontFamily, gridFonts.monospaceFontFamily],
  );

  const autoFitColumn = useCallback(
    async (
      visibleIndex: number,
      rowStart: number,
      rowCount: number,
      abortSignal: AbortSignal,
    ) => {
      const column = visibleColumnStatesRef.current[visibleIndex];
      if (column === undefined) {
        return;
      }
      const view = activeViewRef.current;
      const request = columnFitRequestRef.current + 1;
      columnFitRequestRef.current = request;
      try {
        const bytes = await getDataWindow(
          source.generation,
          view.revision,
          rowStart,
          rowCount,
          [column.sourceIndex],
        );
        if (abortSignal.aborted) {
          return;
        }
        const dataWindow = decodeArrowWindow(bytes, rowStart, [
          column.sourceIndex,
        ]);
        if (
          request === columnFitRequestRef.current &&
          view.revision === activeViewRef.current.revision
        ) {
          applyFittedColumnWidths([column], dataWindow, rowStart, rowCount);
        }
      } catch (error) {
        if (!abortSignal.aborted) {
          setLoadError(dataViewErrorState(error));
        }
      }
    },
    [applyFittedColumnWidths, source.generation],
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

  const fitVisibleColumnWidths = useCallback(() => {
    const visibleColumns = visibleColumnStatesRef.current;
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

    const visibleRegion = visibleRegionsRef.current[0];
    const firstVisibleRow = visibleRegion?.y ?? 0;
    const sampleOffset = Math.min(
      Math.max(0, firstVisibleRow),
      view.rowCount - 1,
    );
    const sampleCount = Math.min(
      Math.max(1, visibleRegion?.height ?? INITIAL_ROWS),
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
  }, [applyFittedColumnWidths, source.generation]);

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
    ([visibleColumn, row]: readonly [number, number], bounds: Rectangle) => {
      const sourceIndex = visibleColumnStates[visibleColumn]?.sourceIndex;
      const field =
        sourceIndex === undefined ? undefined : source.schema[sourceIndex];
      const current = dataWindowRef.current;
      if (
        sourceIndex === undefined ||
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
      });
    },
    [source.schema, visibleColumnStates],
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
      const anchorLeft = wherePopupRef.current?.getBoundingClientRect().left;
      if (anchorLeft !== undefined) {
        setWherePopupLeft(clampedPopupLeft(anchorLeft, window.innerWidth));
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
          <div ref={wherePopupRef} className="query-where-wrap">
            <span className="query-keyword">WHERE</span>
            <button
              className={`query-where ${whereClause.length === 0 ? "query-empty-slot" : ""}`}
              type="button"
              aria-expanded={wherePopupOpen}
              onClick={toggleWherePopup}
            >
              {whereClause || "⋯"}
            </button>
            {wherePopupOpen && (
              <div
                className="where-popup"
                role="dialog"
                aria-label="WHERE conditions"
                style={{ left: wherePopupLeft }}
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
          <div ref={gridCanvasRef} className="grid-canvas">
            <RegularTableGrid
              key={gridInstanceKey}
              ref={gridRef}
              columns={columns}
              rows={gridRowCount}
              gridSelection={selection}
              onGridSelectionChange={updateSelection}
              getCellContent={getCellContent}
              getCellsForSelection={getCellsForSelection}
              freezeColumns={pinnedCount}
              minColumnWidth={MIN_COLUMN_WIDTH}
              maxColumnWidth={MAX_COLUMN_WIDTH}
              onCellContextMenu={(cell, event) => {
                event.preventDefault();
                setHeaderMenu(null);
                setGridMenu({
                  bounds: event.bounds,
                  cell,
                  left: Math.max(
                    4,
                    Math.min(
                      event.bounds.x + event.localEventX,
                      window.innerWidth - 318,
                    ),
                  ),
                  top: Math.max(
                    4,
                    Math.min(
                      event.bounds.y + event.localEventY,
                      window.innerHeight - 148,
                    ),
                  ),
                });
              }}
              onHeaderClicked={(visibleIndex, event) => {
                clearColumnResize();
                if (
                  event.localEventX < SORT_HEADER_HITBOX_START ||
                  event.localEventX >= SORT_HEADER_HITBOX_END
                ) {
                  return;
                }
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
                  const currentSort =
                    pendingViewRef.current?.sort ?? activeViewRef.current.sort;
                  changeSort(
                    nextSort(
                      currentSort,
                      sourceIndex,
                      event.shiftKey || event.metaKey || event.ctrlKey,
                    ),
                  );
                }
              }}
              onVisibleRegionChanged={(range, extras) => {
                visibleRegionsRef.current = [
                  range,
                  ...(extras.freezeRegions ?? []),
                ];
                requestRows(range.y, range.height);
              }}
              onColumnResize={resizeColumnDuringGesture}
              onColumnResizeStart={startColumnResize}
              onColumnResizeEnd={finishColumnResize}
              onColumnAutoFit={autoFitColumn}
              onHeaderMenuClick={(visibleIndex, bounds) => {
                if (suppressHeaderMenuRef.current) {
                  return;
                }
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
            />
          </div>
        )}
      </div>
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
            onClick={() => {
              setFilterEditor({
                sourceIndex: menuColumn.sourceIndex,
                left: Math.max(
                  4,
                  Math.min(headerMenu.left, window.innerWidth - 292),
                ),
                top: Math.max(
                  4,
                  Math.min(headerMenu.top, window.innerHeight - 268),
                ),
              });
              setHeaderMenu(null);
            }}
          >
            Filter…
          </button>
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
              openFilterForCell(gridMenu.cell, gridMenu.bounds);
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
  if (selection.current === undefined && selection.columns.length === 0) {
    return selection;
  }
  return {
    columns: CompactSelection.empty(),
    rows: selection.rows,
  };
}

function sameColumnOrder(
  previous: readonly number[],
  current: readonly number[],
): boolean {
  return previous.every((sourceIndex, index) => sourceIndex === current[index]);
}

function takeCompactSelection(
  selection: CompactSelection,
  limit: number,
): number[] {
  const rows: number[] = [];
  for (const row of selection) {
    rows.push(row);
    if (rows.length === limit) {
      break;
    }
  }
  return rows;
}

function loadingCell(): GridCell {
  return { kind: GridCellKind.Loading };
}

function windowCoversVisibleViewport(
  window: ArrowDataWindow,
  columns: readonly Pick<ColumnState, "sourceIndex">[],
  regions: readonly Rectangle[],
  rowCount: number,
): boolean {
  const visible = regions[0];
  if (visible === undefined) {
    return true;
  }
  const visibleStart = Math.max(0, Math.floor(visible.y));
  const visibleEnd = Math.min(rowCount, Math.ceil(visible.y + visible.height));
  return (
    window.rowOffset <= visibleStart &&
    window.rowOffset + window.rowCount >= visibleEnd &&
    projectionContains(
      window.sourceIndices,
      projectedSourceIndices(columns, regions, INITIAL_COLUMNS),
    )
  );
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

function clampedPopupLeft(anchorLeft: number, viewportWidth: number): number {
  const popupWidth = Math.min(
    WHERE_POPUP_MAX_WIDTH,
    Math.max(0, viewportWidth - WHERE_POPUP_MARGIN * 2),
  );
  const viewportLeft = Math.max(
    WHERE_POPUP_MARGIN,
    Math.min(
      anchorLeft + WHERE_POPUP_OFFSET,
      viewportWidth - WHERE_POPUP_MARGIN - popupWidth,
    ),
  );
  return viewportLeft - anchorLeft;
}

interface GridFonts {
  readonly fontFamily: string;
  readonly monospaceFontFamily: string;
}

function useGridFonts(): GridFonts {
  const [fonts, setFonts] = useState<GridFonts>(readGridFonts);

  useEffect(() => {
    const updateTheme = () => setFonts(readGridFonts());
    window.addEventListener(THEME_CHANGED_EVENT, updateTheme);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, updateTheme);
  }, []);

  return fonts;
}

function readGridFonts(): GridFonts {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    fontFamily: value("--font-ui"),
    monospaceFontFamily: value("--font-mono"),
  };
}
