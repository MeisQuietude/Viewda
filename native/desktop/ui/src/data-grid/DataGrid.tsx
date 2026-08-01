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
  DataWindowCommandError,
  getDataWindow,
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

import "@glideapps/glide-data-grid/dist/index.css";

const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 32;
const ROW_RESERVE = 24;
const INITIAL_ROWS = 64;
const COPY_CHUNK_ROWS = 512;
// Must match data-engine's MAX_WINDOW_ROWS; Rust validates every command at the boundary.
const MAX_WINDOW_ROWS = 512;
const MAX_CACHED_CELLS = 20_000;
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

interface RowRequest {
  offset: number;
  count: number;
  visibleStart: number;
  visibleEnd: number;
}

interface HeaderMenu {
  sourceIndex: number;
  left: number;
  top: number;
}

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
  const gridRef = useRef<DataEditorRef>(null);
  const dataWindowRef = useRef<ArrowDataWindow | null>(null);
  const visibleRegionsRef = useRef<readonly Rectangle[]>([]);
  const cellCacheRef = useRef(new Map<number, GridCell>());
  const copyTailRef = useRef<Promise<void>>(Promise.resolve());
  const copyWindowsRef = useRef(new Map<number, Promise<ArrowDataWindow>>());
  const pendingRequestRef = useRef<RowRequest | null>(null);
  const requestActiveRef = useRef(false);
  const aliveRef = useRef(true);
  const schemaLoadedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const visibleColumnStates = useMemo(
    () => [
      ...columnStates.filter((column) => column.pinned && !column.hidden),
      ...columnStates.filter((column) => !column.pinned && !column.hidden),
    ],
    [columnStates],
  );
  const hiddenCount = columnStates.length - visibleColumnStates.length;
  const pinnedCount = visibleColumnStates.filter(
    (column) => column.pinned,
  ).length;
  const gridTheme = useGridTheme();

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

  const drainRequests = useCallback(async () => {
    if (requestActiveRef.current) {
      return;
    }
    requestActiveRef.current = true;

    while (aliveRef.current && pendingRequestRef.current !== null) {
      const request = pendingRequestRef.current;
      pendingRequestRef.current = null;
      try {
        const bytes = await getDataWindow(
          source.generation,
          request.offset,
          request.count,
        );
        const decoded = decodeArrowWindow(bytes, request.offset);
        if (!aliveRef.current) {
          break;
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
        const pending = pendingRequestRef.current;
        if (pending === null || requestContainsVisibleRows(request, pending)) {
          dataWindowRef.current = decoded;
          cellCacheRef.current.clear();
          gridRef.current?.updateCells(
            loadedWindowDamage(decoded, visibleRegionsRef.current),
          );
          setLoadError(null);
        }
      } catch (error) {
        if (aliveRef.current && pendingRequestRef.current === null) {
          setLoadError(dataWindowErrorMessage(error));
        }
      }
    }

    requestActiveRef.current = false;
  }, [source.generation]);

  const requestRows = useCallback(
    (visibleStart: number, visibleCount: number) => {
      const request = rowRequest(source.rowCount, visibleStart, visibleCount);
      const current = dataWindowRef.current;
      if (
        current !== null &&
        request.visibleStart >= current.rowOffset &&
        request.visibleEnd <= current.rowOffset + current.rowCount
      ) {
        return;
      }
      pendingRequestRef.current = request;
      void drainRequests();
    },
    [drainRequests, source.rowCount],
  );

  useEffect(() => {
    aliveRef.current = true;
    requestRows(0, Math.min(INITIAL_ROWS, source.rowCount));
    return () => {
      aliveRef.current = false;
      pendingRequestRef.current = null;
    };
  }, [requestRows, source.rowCount]);

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

  const loadCopyWindow = useCallback(
    (row: number, abortSignal: AbortSignal): Promise<ArrowDataWindow> => {
      const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
      const existing = copyWindowsRef.current.get(offset);
      if (existing !== undefined) {
        return existing;
      }

      const count = Math.min(COPY_CHUNK_ROWS, source.rowCount - offset);
      const request = copyTailRef.current.then(async () => {
        if (abortSignal.aborted) {
          throw new DOMException("Copy was cancelled.", "AbortError");
        }
        const bytes = await getDataWindow(source.generation, offset, count);
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
    [source.generation, source.rowCount],
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
        source.rowCount,
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
      source.rowCount,
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

  const menuColumn =
    headerMenu === null
      ? undefined
      : columnStates.find(
          (column) => column.sourceIndex === headerMenu.sourceIndex,
        );

  return (
    <section className="data-grid-view" aria-label="Data">
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
          {loadError}
        </p>
      )}
      <div className="grid-canvas">
        <DataEditor
          ref={gridRef}
          columns={columns}
          rows={source.rowCount}
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
          onVisibleRegionChanged={(range, _tx, _ty, extras) => {
            visibleRegionsRef.current = [
              range,
              ...(extras.freezeRegions ?? []),
            ];
            requestRows(range.y, range.height);
          }}
          onColumnResizeEnd={(_column, width, visibleIndex) => {
            const sourceIndex = visibleColumnStates[visibleIndex]?.sourceIndex;
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
            const sourceIndex = visibleColumnStates[visibleIndex]?.sourceIndex;
            if (sourceIndex !== undefined) {
              setHeaderMenu({
                sourceIndex,
                left: Math.max(4, Math.min(bounds.x, window.innerWidth - 164)),
                top: Math.max(
                  4,
                  Math.min(bounds.y + bounds.height, window.innerHeight - 76),
                ),
              });
            }
          }}
        />
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
    </section>
  );
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

function rowRequest(
  totalRows: number,
  visibleStart: number,
  visibleCount: number,
): RowRequest {
  if (totalRows === 0) {
    return { offset: 0, count: 0, visibleStart: 0, visibleEnd: 0 };
  }
  const safeStart = Math.max(0, Math.min(totalRows - 1, visibleStart));
  const safeCount = Math.max(1, visibleCount);
  const offset = Math.max(0, safeStart - ROW_RESERVE);
  const visibleEnd = Math.min(totalRows, safeStart + safeCount);
  const end = Math.min(
    totalRows,
    offset + MAX_WINDOW_ROWS,
    visibleEnd + ROW_RESERVE,
  );
  return { offset, count: end - offset, visibleStart: safeStart, visibleEnd };
}

function requestContainsVisibleRows(
  request: RowRequest,
  pending: RowRequest,
): boolean {
  return (
    pending.visibleStart >= request.offset &&
    pending.visibleEnd <= request.offset + request.count
  );
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
  }
  return "This data window could not be loaded.";
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
