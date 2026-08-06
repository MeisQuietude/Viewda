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
  type Theme,
} from "@glideapps/glide-data-grid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelFilteredRowCount,
  DataWindowCommandError,
  getDataWindow,
  getFilteredRowCount,
  shortcutModifier,
  type DataFilter,
  type SourceSummary,
} from "../desktop";
import {
  decodeArrowWindow,
  windowContainsRow,
  windowDataType,
  windowValue,
  type ArrowDataWindow,
} from "./arrow-window";
import { copyRowLimit } from "./copy-limit";
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
  formatWhereClause,
} from "./filter-query";
import {
  nextScrollState,
  requestContainsVisibleRows,
  requestSatisfiesRequest,
  rowRequest,
  windowSatisfiesRequest,
  type RowRequest,
  type ScrollState,
} from "./row-window";
import { SchemaSidebar } from "./SchemaSidebar";

import "@glideapps/glide-data-grid/dist/index.css";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const INITIAL_ROWS = 64;
const COPY_CHUNK_ROWS = 512;
const MAX_CACHED_CELLS = 20_000;
const WHERE_POPUP_MARGIN = 16;
const WHERE_POPUP_MAX_WIDTH = 680;
const WHERE_POPUP_OFFSET = -42;
const GRID_HEADER_FONT_STYLE = "600 12px";
const UI_FONT_FAMILY =
  'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const MONOSPACE_FONT = 'ui-monospace, "SFMono-Regular", Consolas, monospace';

const drawGridHeader: DrawHeaderCallback = ({ ctx }, drawContent) => {
  ctx.font = `${GRID_HEADER_FONT_STYLE} ${UI_FONT_FAMILY}`;
  drawContent();
};

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
  filters: DataFilter[];
}

type CountState = "ready" | "counting" | "error" | "unavailable";

export function DataGrid({ source }: { source: SourceSummary }) {
  const [columnStates, setColumnStates] = useState<ColumnState[]>(() =>
    source.schema.map((field, sourceIndex) => ({
      sourceIndex,
      title: field.name,
      width: Math.min(280, Math.max(120, field.name.length * 8 + 48)),
      pinned: false,
      hidden: false,
    })),
  );
  const [monospaceColumns, setMonospaceColumns] = useState<ReadonlySet<number>>(
    () => new Set(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<GridSelection>(() =>
    emptySelection(),
  );
  const [copyLimit, setCopyLimit] = useState<number | null>(null);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
  const [filterEditor, setFilterEditor] = useState<FilterEditorRequest | null>(
    null,
  );
  const [filters, setFilters] = useState<DataFilter[]>([]);
  const [matchCount, setMatchCount] = useState<number | null>(source.rowCount);
  const [countState, setCountState] = useState<CountState>("ready");
  const [provisionalRowCount, setProvisionalRowCount] = useState<number | null>(
    source.rowCount,
  );
  const [wherePopupOpen, setWherePopupOpen] = useState(false);
  const [wherePopupLeft, setWherePopupLeft] = useState(WHERE_POPUP_OFFSET);
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
  const copyWindowsRef = useRef(new Map<number, Promise<ArrowDataWindow>>());
  const pendingRequestRef = useRef<VersionedRowRequest | null>(null);
  const activeRequestRef = useRef<VersionedRowRequest | null>(null);
  const failedRequestRef = useRef<VersionedRowRequest | null>(null);
  const filterRevisionRef = useRef(0);
  const countRequestedRevisionRef = useRef<number | null>(null);
  const scrollStateRef = useRef<ScrollState>({ direction: 0, boundary: 0 });
  const aliveRef = useRef(true);
  const schemaLoadedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wherePopupRef = useRef<HTMLDivElement>(null);

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
  const filteredRowCount = filters.length === 0 ? source.rowCount : matchCount;
  const gridRowCount =
    filters.length === 0
      ? source.rowCount
      : (matchCount ?? provisionalRowCount ?? 0);
  const whereClause = useMemo(
    () => formatWhereClause(filters, source.schema),
    [filters, source.schema],
  );

  const columns = useMemo<GridColumn[]>(
    () =>
      visibleColumnStates.map((column) => {
        return {
          id: String(column.sourceIndex),
          title: column.title,
          width: column.width,
          hasMenu: true,
          themeOverride: monospaceColumns.has(column.sourceIndex)
            ? { fontFamily: MONOSPACE_FONT }
            : undefined,
        };
      }),
    [monospaceColumns, visibleColumnStates],
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

  const requestFilteredCount = useCallback(
    (revision: number, queryFilters: DataFilter[]) => {
      if (countRequestedRevisionRef.current === revision) {
        return;
      }
      countRequestedRevisionRef.current = revision;
      setCountState("counting");
      void getFilteredRowCount(source.generation, revision, queryFilters).then(
        (count) => {
          if (aliveRef.current && filterRevisionRef.current === revision) {
            setMatchCount(count);
            setCountState("ready");
          }
        },
        (error: unknown) => {
          if (
            error instanceof DataWindowCommandError &&
            error.code === "cancelled"
          ) {
            return;
          }
          if (aliveRef.current && filterRevisionRef.current === revision) {
            setCountState("error");
          }
        },
      );
    },
    [source.generation],
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
          request.rows.offset,
          request.rows.count,
          request.filters,
        );
        const decoded = decodeArrowWindow(bytes, request.rows.offset);
        if (
          !aliveRef.current ||
          request.revision !== filterRevisionRef.current
        ) {
          continue;
        }
        if (!schemaLoadedRef.current) {
          schemaLoadedRef.current = true;
          setMonospaceColumns(
            new Set(
              decoded.table.schema.fields
                .map((field, index) =>
                  usesMonospaceCells(field.type) ? index : undefined,
                )
                .filter((index): index is number => index !== undefined),
            ),
          );
        }
        const pending = readAfterAwait(pendingRequestRef);
        if (
          pending !== null &&
          pending.revision === request.revision &&
          requestSatisfiesRequest(request.rows, pending.rows)
        ) {
          pendingRequestRef.current = null;
        }
        const latest = readAfterAwait(pendingRequestRef);
        if (
          latest === null ||
          latest.revision !== request.revision ||
          requestContainsVisibleRows(request.rows, latest.rows)
        ) {
          dataWindowRef.current = decoded;
          failedRequestRef.current = null;
          cellCacheRef.current.clear();
          gridRef.current?.updateCells(
            loadedWindowDamage(decoded, visibleRegionsRef.current),
          );
          setLoadError(null);
          if (request.filters.length > 0 && request.rows.offset === 0) {
            setProvisionalRowCount(decoded.rowCount);
            if (
              decoded.rowCount < request.rows.count ||
              request.rows.count >= source.rowCount
            ) {
              setMatchCount(decoded.rowCount);
              setCountState("ready");
            } else {
              requestFilteredCount(request.revision, request.filters);
            }
          }
        }
      } catch (error) {
        if (
          aliveRef.current &&
          request.revision === filterRevisionRef.current &&
          pendingRequestRef.current === null
        ) {
          failedRequestRef.current = request;
          if (
            request.filters.length > 0 &&
            countRequestedRevisionRef.current !== request.revision
          ) {
            setCountState("unavailable");
          }
          setLoadError(dataWindowErrorMessage(error));
        }
      } finally {
        activeRequestRef.current = null;
      }
    }
  }, [requestFilteredCount, source.generation, source.rowCount]);

  const requestRows = useCallback(
    (
      visibleStart: number,
      visibleCount: number,
      planningRowCount = gridRowCount,
    ) => {
      const scrollState = nextScrollState(scrollStateRef.current, visibleStart);
      scrollStateRef.current = scrollState;
      const request = rowRequest(
        planningRowCount,
        visibleStart,
        visibleCount,
        scrollState.direction,
      );
      const current = dataWindowRef.current;
      if (
        current !== null &&
        windowSatisfiesRequest(current.rowOffset, current.rowCount, request)
      ) {
        return;
      }
      const pending = pendingRequestRef.current;
      const revision = filterRevisionRef.current;
      if (
        pending !== null &&
        pending.revision === revision &&
        requestSatisfiesRequest(pending.rows, request)
      ) {
        return;
      }
      const active = activeRequestRef.current;
      if (
        active !== null &&
        active.revision === revision &&
        requestSatisfiesRequest(active.rows, request)
      ) {
        return;
      }
      pendingRequestRef.current = { rows: request, revision, filters };
      void drainRequests();
    },
    [drainRequests, filters, gridRowCount],
  );

  const retryWindow = useCallback(() => {
    const failed = failedRequestRef.current;
    if (failed === null || failed.revision !== filterRevisionRef.current) {
      return;
    }
    failedRequestRef.current = null;
    pendingRequestRef.current = failed;
    setLoadError(null);
    if (
      failed.filters.length > 0 &&
      countRequestedRevisionRef.current !== failed.revision
    ) {
      setCountState("counting");
    }
    void drainRequests();
  }, [drainRequests]);

  useEffect(() => {
    aliveRef.current = true;
    if (
      filters.length > 0 &&
      matchCount === null &&
      provisionalRowCount === null &&
      source.rowCount > 0
    ) {
      requestRows(0, INITIAL_ROWS, Math.min(COPY_CHUNK_ROWS, source.rowCount));
    } else if (gridRowCount > 0) {
      requestRows(0, Math.min(INITIAL_ROWS, gridRowCount));
    }
    return () => {
      aliveRef.current = false;
      pendingRequestRef.current = null;
      failedRequestRef.current = null;
    };
  }, [
    filters.length,
    gridRowCount,
    matchCount,
    provisionalRowCount,
    requestRows,
    source.rowCount,
  ]);

  useEffect(
    () => () => {
      const revision = filterRevisionRef.current;
      if (countRequestedRevisionRef.current === revision) {
        void cancelFilteredRowCount(source.generation, revision).catch(
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

  const changeFilters = useCallback(
    (nextFilters: DataFilter[]) => {
      const previousRevision = filterRevisionRef.current;
      if (countRequestedRevisionRef.current === previousRevision) {
        void cancelFilteredRowCount(source.generation, previousRevision).catch(
          () => undefined,
        );
      }
      filterRevisionRef.current += 1;
      countRequestedRevisionRef.current = null;
      pendingRequestRef.current = null;
      failedRequestRef.current = null;
      dataWindowRef.current = null;
      cellCacheRef.current.clear();
      copyWindowsRef.current.clear();
      scrollStateRef.current = { direction: 0, boundary: 0 };
      setFilters(nextFilters);
      setMatchCount(
        nextFilters.length === 0 || source.rowCount === 0
          ? source.rowCount
          : null,
      );
      setCountState(
        nextFilters.length === 0 || source.rowCount === 0
          ? "ready"
          : "counting",
      );
      setProvisionalRowCount(
        nextFilters.length === 0
          ? source.rowCount
          : source.rowCount === 0
            ? 0
            : null,
      );
      setSelection(emptySelection());
      setCopyLimit(null);
      setLoadError(null);
      setHeaderMenu(null);
      setFilterEditor(null);
      setWherePopupOpen(false);
      gridRef.current?.updateCells(
        visibleRegionDamage(visibleRegionsRef.current),
      );
    },
    [source.generation, source.rowCount],
  );

  const retryFilteredCount = useCallback(() => {
    const revision = filterRevisionRef.current;
    countRequestedRevisionRef.current = null;
    requestFilteredCount(revision, filters);
  }, [filters, requestFilteredCount]);

  const loadCopyWindow = useCallback(
    (row: number, abortSignal: AbortSignal): Promise<ArrowDataWindow> => {
      const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
      const existing = copyWindowsRef.current.get(offset);
      if (existing !== undefined) {
        return existing;
      }

      const count = Math.min(COPY_CHUNK_ROWS, gridRowCount - offset);
      const request = copyTailRef.current.then(async () => {
        if (abortSignal.aborted) {
          throw new DOMException("Copy was cancelled.", "AbortError");
        }
        const bytes = await getDataWindow(
          source.generation,
          offset,
          count,
          filters,
        );
        return decodeArrowWindow(bytes, offset);
      });
      copyTailRef.current = request.then(
        () => undefined,
        () => undefined,
      );
      copyWindowsRef.current.set(offset, request);
      const release = () => {
        queueMicrotask(() => {
          if (copyWindowsRef.current.get(offset) === request) {
            copyWindowsRef.current.delete(offset);
          }
        });
      };
      void request.then(release, release);
      return request;
    },
    [filters, gridRowCount, source.generation],
  );

  const getCellsForSelection = useCallback(
    (rectangle: Rectangle, abortSignal: AbortSignal) => async () => {
      const selectedColumns = visibleColumnStates.slice(
        rectangle.x,
        rectangle.x + rectangle.width,
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
        const window = await loadCopyWindow(offset, abortSignal);
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
          <span className="query-keyword">ORDER BY</span>
          <span className="query-empty-slot">⋯</span>
        </div>
        <span className="query-count" role="status">
          {countState === "error" ? (
            <button type="button" onClick={retryFilteredCount}>
              retry
            </button>
          ) : countState === "counting" ? (
            "counting…"
          ) : countState === "unavailable" ? (
            "count unavailable"
          ) : (
            `${(matchCount ?? source.rowCount).toLocaleString("en-US")} rows`
          )}
        </span>
        <button
          className="query-clear"
          type="button"
          aria-label="Clear WHERE conditions"
          title="Clear WHERE conditions"
          disabled={filters.length === 0}
          onClick={() => changeFilters([])}
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
        <p className="grid-error" role="alert">
          <span>{loadError}</span>
          <button type="button" onClick={retryWindow}>
            Retry window
          </button>
        </p>
      )}
      <div className="data-grid-layout">
        <SchemaSidebar
          open={sidebarOpen}
          selectedColumn={selectedSchemaColumn}
          source={source}
          onSelectColumn={selectSchemaColumn}
        />
        {filters.length > 0 && filteredRowCount === 0 ? (
          <div className="filtered-empty-state">
            <p>No rows match these conditions.</p>
            <button type="button" onClick={() => changeFilters([])}>
              Clear filters
            </button>
          </div>
        ) : filters.length > 0 && gridRowCount === 0 ? (
          <p className="data-grid-loading" role="status">
            {loadError === null
              ? "Loading matching rows…"
              : "Matching rows could not be loaded."}
          </p>
        ) : (
          <div className="grid-canvas">
            <DataEditor
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
                        ? { ...column, width }
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

// TypeScript keeps the pre-await narrowing of ref.current, but scroll callbacks
// can replace this value while a native window request is pending.
function readAfterAwait<T>(ref: { readonly current: T }): T {
  return ref.current;
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
      return "There is not enough memory to complete this query.";
    }
    if (error.code === "queryFailed") {
      return "The query engine could not read this data.";
    }
  }
  return "This data window could not be loaded.";
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
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    const updateTheme = () => setTheme(readGridTheme());
    colorScheme.addEventListener("change", updateTheme);
    return () => colorScheme.removeEventListener("change", updateTheme);
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
