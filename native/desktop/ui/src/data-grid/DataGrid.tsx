import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  type CellArray,
  type DataEditorRef,
  type DrawHeaderCallback,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Rectangle,
  type SpriteMap,
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelDataView,
  DataWindowCommandError,
  getDataWindow,
  getDataViewStatus,
  prepareDataView,
  shortcutModifier,
  type DataFilter,
  type DataViewSettings,
  type DataViewResourceDiagnostics,
  type SortColumn,
  type SourceSummary,
} from "../desktop";
import { THEME_CHANGED_EVENT } from "../theme";
import {
  decodeArrowWindow,
  windowContainsRow,
  windowDataType,
  windowValue,
  type ArrowDataWindow,
} from "./arrow-window";
import { copyRowLimit } from "./copy-limit";
import { projectedSourceIndices, projectionContains } from "./column-window";
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
import { GridScrollViewport } from "./GridScrollViewport";
import { SchemaSidebar } from "./SchemaSidebar";
import { nextSort, sortedColumnIcon } from "./sort";

import "@glideapps/glide-data-grid/dist/index.css";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const INITIAL_ROWS = 64;
const INITIAL_COLUMNS = 8;
const COPY_CHUNK_ROWS = 512;
const MAX_CACHED_CELLS = 20_000;
const MIN_COLUMN_WIDTH = 112;
const SORT_HEADER_HITBOX_START = 4;
const SORT_HEADER_HITBOX_END = 32;
const WHERE_POPUP_MARGIN = 16;
const WHERE_POPUP_MAX_WIDTH = 680;
const WHERE_POPUP_OFFSET = -42;
const GRID_HEADER_FONT_STYLE = "600 12px";
const UI_FONT_FAMILY =
  'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONOSPACE_FONT = 'ui-monospace, "SFMono-Regular", Consolas, monospace';
const DEFAULT_DATA_VIEW_SETTINGS: DataViewSettings = { memoryLimit: "mb384" };

const drawGridHeader: DrawHeaderCallback = ({ ctx }, drawContent) => {
  ctx.font = `${GRID_HEADER_FONT_STYLE} ${UI_FONT_FAMILY}`;
  drawContent();
};

function sortHeaderSprite(
  direction: "neutral" | "ascending" | "descending",
  priority?: number,
): SpriteMap[string] {
  return ({ bgColor, fgColor }) => {
    const arrow =
      direction === "neutral"
        ? '<path d="M7 7l3-3 3 3M10 4v12M7 13l3 3 3-3"/>'
        : direction === "ascending"
          ? '<path d="M6.5 9.5 10 6l3.5 3.5M10 6v9"/>'
          : '<path d="M6.5 10.5 10 14l3.5-3.5M10 5v9"/>';
    const badge =
      priority === undefined
        ? ""
        : `<circle cx="15.5" cy="15.5" r="4" fill="${bgColor}" stroke="none"/><text x="15.5" y="17.4" fill="${fgColor}" stroke="none" text-anchor="middle" font-family="sans-serif" font-size="${priority >= 10 ? 5 : 6}" font-weight="700">${priority}</text>`;
    return `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="${bgColor}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${arrow}</g>${badge}</svg>`;
  };
}

const sortHeaderIcons: SpriteMap = {
  "viewda-sort-neutral": sortHeaderSprite("neutral"),
  "viewda-sort-ascending": sortHeaderSprite("ascending"),
  "viewda-sort-descending": sortHeaderSprite("descending"),
};
for (let priority = 1; priority <= 32; priority += 1) {
  sortHeaderIcons[`viewda-sort-ascending-${priority}`] = sortHeaderSprite(
    "ascending",
    priority,
  );
  sortHeaderIcons[`viewda-sort-descending-${priority}`] = sortHeaderSprite(
    "descending",
    priority,
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

interface VersionedRowRequest {
  rows: RowRequest;
  revision: number;
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
  const [viewError, setViewError] = useState<ViewErrorState | null>(null);
  const [selection, setSelection] = useState<GridSelection>(() =>
    emptySelection(),
  );
  const [copyLimit, setCopyLimit] = useState<number | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
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
  const [wherePopupOpen, setWherePopupOpen] = useState(false);
  const [wherePopupLeft, setWherePopupLeft] = useState(WHERE_POPUP_OFFSET);
  const [sortPopupOpen, setSortPopupOpen] = useState(false);
  const [sortDraft, setSortDraft] = useState<SortColumn[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSchemaColumn, setSelectedSchemaColumn] = useState<
    number | null
  >(null);
  const [schemaFocusRequest, setSchemaFocusRequest] = useState(0);
  const gridRef = useRef<DataEditorRef>(null);
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
  const scrollStateRef = useRef<ScrollState>({ direction: 0, boundary: 0 });
  const aliveRef = useRef(true);
  const menuRef = useRef<HTMLDivElement>(null);
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
  const gridTheme = useGridTheme();
  activeViewRef.current = activeView;
  pendingViewRef.current = pendingView;
  const filters = activeView.filters;
  const sort = activeView.sort;
  const gridRowCount = activeView.rowCount;
  const whereClause = useMemo(
    () => formatWhereClause(filters, source.schema),
    [filters, source.schema],
  );
  const orderByClause = useMemo(
    () => formatOrderByClause(sort, source.schema),
    [sort, source.schema],
  );

  const columns = useMemo<GridColumn[]>(
    () =>
      visibleColumnStates.map((column) => {
        return {
          id: String(column.sourceIndex),
          title: column.title,
          icon: sortedColumnIcon(sort, column.sourceIndex),
          width: column.width,
          hasMenu: true,
          themeOverride: monospaceColumns.has(column.sourceIndex)
            ? { fontFamily: MONOSPACE_FONT }
            : undefined,
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
        allowOverlay: false,
        readonly: true,
        data: formatted.copyData || formatted.displayData,
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
        // Glide's virtual scroller retains its logical offset when rows shrink below the
        // current viewport. Remount only in that case so the canvas can reach the clamped row.
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
      gridRef.current?.updateCells(
        visibleRegionDamage(visibleRegionsRef.current),
      );
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
          request.revision !== activeViewRef.current.revision
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
          latest === null ||
          latest.revision !== request.revision ||
          requestContainsVisibleWindow(request, latest)
        ) {
          dataWindowRef.current = decoded;
          failedRequestRef.current = null;
          cellCacheRef.current.clear();
          gridRef.current?.updateCells(
            loadedWindowDamage(decoded, visibleRegionsRef.current),
          );
          setLoadError(null);
        }
      } catch (error) {
        if (
          aliveRef.current &&
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
    if (failed === null || failed.revision !== activeViewRef.current.revision) {
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
        gridRef.current?.scrollTo(0, visibleStart, "vertical", 0, 0, {
          vAlign: "start",
        });
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
    gridRef.current?.scrollTo(visibleIndex, 0, "horizontal", 16);
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
    (rectangle: Rectangle, abortSignal: AbortSignal) => async () => {
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

  const updateSelection = useCallback(
    (next: GridSelection) => {
      const rowLimit = copyRowLimit(visibleColumnStates.length);
      if (next.rows.length > rowLimit) {
        setSelection({ ...next, rows: takeSelection(next.rows, rowLimit) });
        setCopyLimit(rowLimit);
      } else {
        setSelection(next);
        setCopyLimit(null);
      }
    },
    [visibleColumnStates.length],
  );

  const updateColumn = useCallback(
    (sourceIndex: number, update: Partial<ColumnState>) => {
      setColumnStates((current) =>
        current.map((column) =>
          column.sourceIndex === sourceIndex
            ? { ...column, ...update }
            : column,
        ),
      );
      setSelection(emptySelection());
      setHeaderMenu(null);
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
          : filterInputFromCell(value, dataType);
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
          <span className="query-slot">
            {hiddenCount === 0
              ? "*"
              : `[${visibleColumnStates.length}/${columnStates.length} cols]`}
          </span>
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
      {(hiddenCount > 0 || copyLimit !== null) && (
        <div className="grid-controls">
          {copyLimit !== null && (
            <span role="status">
              {`This operation is limited to the first ${copyLimit.toLocaleString()} rows of the selection.`}
            </span>
          )}
          {hiddenCount > 0 && (
            <>
              <span>{hiddenCount} hidden</span>
              <button
                type="button"
                onClick={() => {
                  setColumnStates((current) =>
                    current.map((column) => ({ ...column, hidden: false })),
                  );
                  setSelection(emptySelection());
                }}
              >
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
        {gridRowCount === 0 && filters.length > 0 ? (
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
          <GridScrollViewport headerHeight={HEADER_HEIGHT}>
            <DataEditor
              key={gridInstanceKey}
              ref={gridRef}
              columns={columns}
              rows={gridRowCount}
              width="100%"
              height="100%"
              rowHeight={ROW_HEIGHT}
              headerHeight={HEADER_HEIGHT}
              rowMarkers={{ kind: "clickable-number", startIndex: 1 }}
              rangeSelect="multi-rect"
              rowSelect="multi"
              columnSelect="multi"
              gridSelection={selection}
              onGridSelectionChange={updateSelection}
              getCellContent={getCellContent}
              getCellsForSelection={getCellsForSelection}
              drawHeader={drawGridHeader}
              headerIcons={sortHeaderIcons}
              copyHeaders={false}
              freezeColumns={pinnedCount}
              fixedShadowX={false}
              fixedShadowY={false}
              overscrollX={0}
              overscrollY={0}
              preventDiagonalScrolling
              smoothScrollX
              smoothScrollY={false}
              theme={gridTheme}
              onCellContextMenu={(cell, event) => {
                event.preventDefault();
                openFilterForCell(cell, event.bounds);
              }}
              onHeaderClicked={(visibleIndex, event) => {
                if (
                  event.isEdge ||
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
              onVisibleRegionChanged={(range, _tx, _ty, extras) => {
                visibleRegionsRef.current = [
                  range,
                  ...(extras.freezeRegions ?? []),
                ];
                requestRows(range.y, range.height);
              }}
              onColumnResizeEnd={(_column, width, visibleIndex) => {
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
                  setColumnStates((current) =>
                    current.map((column) =>
                      column.sourceIndex === sourceIndex
                        ? {
                            ...column,
                            width: Math.max(MIN_COLUMN_WIDTH, width),
                          }
                        : column,
                    ),
                  );
                }
              }}
              onHeaderMenuClick={(visibleIndex, bounds) => {
                const sourceIndex =
                  visibleColumnStates[visibleIndex]?.sourceIndex;
                if (sourceIndex !== undefined) {
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
          </GridScrollViewport>
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
      {filterEditor !== null && filterEditorField !== undefined && (
        <FilterEditor
          request={filterEditor}
          field={filterEditorField}
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

function takeSelection(
  selection: CompactSelection,
  limit: number,
): CompactSelection {
  let result = CompactSelection.empty();
  let count = 0;
  for (const index of selection) {
    result = result.add(index);
    count += 1;
    if (count === limit) {
      break;
    }
  }
  return result;
}

function loadingCell(): GridCell {
  return { kind: GridCellKind.Loading, allowOverlay: false };
}

function loadedWindowDamage(
  window: ArrowDataWindow,
  visibleRegions: readonly Rectangle[],
): { cell: readonly [number, number] }[] {
  const damaged = new Map<string, { cell: readonly [number, number] }>();
  const windowEnd = window.rowOffset + window.rowCount;

  for (const region of visibleRegions) {
    const rowStart = Math.max(window.rowOffset, region.y);
    const rowEnd = Math.min(windowEnd, region.y + region.height);
    const columnStart = Math.max(0, region.x);
    const columnEnd = Math.max(columnStart, region.x + region.width);
    for (let row = rowStart; row < rowEnd; row += 1) {
      for (let column = columnStart; column < columnEnd; column += 1) {
        const cell = [column, row] as const;
        damaged.set(`${column}:${row}`, { cell });
      }
    }
  }

  return [...damaged.values()];
}

function visibleRegionDamage(
  visibleRegions: readonly Rectangle[],
): { cell: readonly [number, number] }[] {
  return visibleRegions.flatMap((region) => {
    const damage: { cell: readonly [number, number] }[] = [];
    for (let row = region.y; row < region.y + region.height; row += 1) {
      for (
        let column = region.x;
        column < region.x + region.width;
        column += 1
      ) {
        damage.push({ cell: [column, row] });
      }
    }
    return damage;
  });
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

function useGridTheme(): Partial<Theme> {
  const [theme, setTheme] = useState<Partial<Theme>>(readGridTheme);

  useEffect(() => {
    const updateTheme = () => setTheme(readGridTheme());
    window.addEventListener(THEME_CHANGED_EVENT, updateTheme);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, updateTheme);
  }, []);

  return theme;
}

function readGridTheme(): Partial<Theme> {
  const styles = getComputedStyle(document.documentElement);
  const value = (name: string) => styles.getPropertyValue(name).trim();
  return {
    accentColor: value("--grid-selection-strong"),
    accentFg: value("--grid-selection-text"),
    accentLight: value("--grid-selection"),
    bgCell: value("--grid-cell"),
    bgCellMedium: value("--grid-cell-muted"),
    bgHeader: value("--grid-header"),
    bgHeaderHasFocus: value("--grid-header-active"),
    bgHeaderHovered: value("--grid-header-hover"),
    borderColor: value("--grid-border"),
    horizontalBorderColor: value("--grid-border-soft"),
    headerBottomBorderColor: value("--grid-border"),
    textDark: value("--grid-text"),
    textMedium: value("--grid-text-muted"),
    textLight: value("--grid-text-faint"),
    textHeader: value("--grid-text-muted"),
    textHeaderSelected: value("--grid-text"),
    baseFontStyle: "12px",
    headerFontStyle: GRID_HEADER_FONT_STYLE,
    fontFamily: UI_FONT_FAMILY,
    cellHorizontalPadding: 10,
    cellVerticalPadding: 4,
    roundingRadius: 0,
  };
}
