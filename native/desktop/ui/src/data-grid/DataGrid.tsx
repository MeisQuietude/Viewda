import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Type, type DataType } from "@uwdata/flechette";

import {
  cancelDataExport,
  cancelDataView,
  DataExportCommandError,
  DataWindowCommandError,
  dismissDataExport,
  getDataExportStatus,
  getDataWindow,
  getDataViewStatus,
  getSourceSchemaPage,
  prepareDataView,
  revealDataExport,
  shortcutModifier,
  startDataExport,
  type DataExportErrorCode,
  type DataExportRequest,
  type DataExportScope,
  type DataExportStatus,
  type DataFilter,
  type FieldPath,
  type DataViewSettings,
  type DataViewResourceDiagnostics,
  type SortColumn,
  type SchemaField,
  type SourceSummary,
} from "../desktop";
import { loadBundledEmojiFont } from "../fonts";
import { LIST_MAP_COLUMN_REASON } from "../SchemaTree";
import {
  decodeArrowWindow,
  windowArrowValueAt,
  windowContainsRow,
  windowDataType,
  windowDataTypeAt,
  windowValue,
  windowValueAt,
  type ArrowDataWindow,
} from "./arrow-window";
import { copyRowLimit } from "./copy-limit";
import { projectedFieldPaths, projectionContains } from "./column-window";
import { exportSelectionShape } from "./export-selection";
import {
  formatTypedScalarCopyData,
  formatTypedCellValue,
  usesMonospaceCells,
} from "./format-cell";
import {
  CompactSelection,
  CopyBufferLimitError,
  IncrementalCopyBuffer,
  type GridAddress,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Rectangle,
} from "./grid-model";
import { ChunkScheduler } from "./chunk-scheduler";
import { createGridClipboard } from "./grid-clipboard";
import {
  gridDiagnosticsNoopSink,
  type GridDataWindowRequestReason,
  type GridDiagnosticsSink,
} from "./grid-performance-report";
import { GRID_INITIAL_COLUMNS, GRID_INITIAL_ROWS } from "./grid-layout";
import {
  boundedSelectionScope,
  selectCell,
  selectColumn,
} from "./grid-selection";
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
import { formatDataTypeLabel, SchemaSidebar } from "./SchemaSidebar";
import { nextSort } from "./sort";
import {
  fieldPathKey,
  fieldPathStartsWith,
  formatFieldPath,
  formatFieldPathSegment,
  resolveSchemaField,
  sameFieldPath,
} from "./field-path";
import { ColumnPicker, type ColumnPickerColumn } from "./ColumnPicker";
import { ValuePeek } from "./ValuePeek";
import { arrowTypedValue, typedValue, type TypedValue } from "./value-format";
import {
  createValueCopySerializer,
  VALUE_COPY_CHARACTER_LIMIT,
  ValueCopyLimitError,
} from "./value-json-serializer";
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
const WHERE_POPUP_EMPTY_WIDTH = 140;
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
const EMPTY_LOGICAL_DATA_TYPES: ReadonlyMap<string, DataType> = new Map();
const EMPTY_SOURCE_INDICES: ReadonlySet<number> = new Set();

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
  key: string;
  sourceIndex: number;
  fieldPath: FieldPath;
  field: SchemaField;
  title: string;
  width: number;
  pinned: boolean;
}

interface SchemaPathEntry {
  field: SchemaField;
  sourceIndex: number;
  rank: number;
}

interface ColumnNotice {
  message: string;
  kind: "status" | "alert";
}

interface HeaderMenu {
  columnKey: string;
  fieldPath: FieldPath;
  left: number;
  top: number;
}

interface GridMenu {
  bounds: Rectangle;
  column: number;
  row: number;
  columnKey: string;
  fieldPath: FieldPath;
  left: number;
  top: number;
}

interface PeekState {
  address: GridAddress;
  bounds: Rectangle;
}

interface PeekValue {
  label: string;
  value: TypedValue;
}

interface ActiveCellValueCache {
  fieldKey: string;
  row: number;
  dataWindow: ArrowDataWindow;
  value: TypedValue;
  dataType: DataType;
}

interface PeekValueCache {
  fieldKey: string;
  row: number;
  dataWindow: ArrowDataWindow;
  label: string;
  logicalType: string | null | undefined;
  peekValue: PeekValue;
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
  fieldPaths: readonly FieldPath[];
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
  fieldPaths: readonly FieldPath[];
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
  recovery?: "reloadDataset";
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
    projectionContains(candidate.fieldPaths, requested.fieldPaths)
  );
}

function sameFieldContract(
  left: SchemaField | undefined,
  right: SchemaField | undefined,
): boolean {
  if (left === undefined || right === undefined) return false;
  if (
    left.name !== right.name ||
    left.physicalType !== right.physicalType ||
    left.logicalType !== right.logicalType ||
    left.children.length !== right.children.length
  ) {
    return false;
  }
  return left.children.every((child, index) =>
    sameFieldContract(child, right.children[index]),
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
      projectionContains(candidate.fieldPaths, desired.fieldPaths)
    );
  }
  return (
    base !== null &&
    windowSatisfiesRequest(base.rowOffset, base.rowCount, desired.rows) &&
    !projectionContains(base.fieldPaths, desired.fieldPaths) &&
    candidate.rows.offset >= base.rowOffset &&
    candidate.rows.offset + candidate.rows.count <=
      base.rowOffset + base.rowCount &&
    requestSatisfiesRequest(candidate.rows, desired.supplementRows) &&
    projectionContains(
      [...base.fieldPaths, ...candidate.fieldPaths],
      desired.fieldPaths,
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
    projectionContains(candidate.fieldPaths, desired.fieldPaths)
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
  if (projectionContains(base.fieldPaths, desired.fieldPaths)) {
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
      [...base.fieldPaths, ...supplement.fieldPaths],
      desired.fieldPaths,
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
        sameFieldPath(filter.fieldPath, next.fieldPath) &&
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
        sameFieldPath(column.fieldPath, next.fieldPath) &&
        column.direction === next.direction
      );
    })
  );
}

function ViewErrorAlert({
  error,
  onDismiss,
  onRetry,
  onReloadDataset,
  dismissLabel = "Dismiss view error",
}: {
  error: ViewErrorState;
  onDismiss: () => void;
  onRetry?: () => void;
  onReloadDataset?: () => void;
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
      {error.recovery === "reloadDataset" && onReloadDataset !== undefined && (
        <button type="button" onClick={onReloadDataset}>
          Reload dataset
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
  contentIdentity,
  requestedRow = null,
  viewSettings = DEFAULT_DATA_VIEW_SETTINGS,
  diagnostics = gridDiagnosticsNoopSink,
  active = true,
  exportEnabled = true,
  defaultPinnedSourceIndices = EMPTY_SOURCE_INDICES,
  onOperationChange,
  onReloadDataset,
}: {
  source: SourceSummary;
  contentIdentity?: string;
  requestedRow?: { row: number; request: number } | null;
  viewSettings?: DataViewSettings;
  diagnostics?: GridDiagnosticsSink;
  active?: boolean;
  exportEnabled?: boolean;
  defaultPinnedSourceIndices?: ReadonlySet<number>;
  onOperationChange?: (running: boolean) => void;
  onReloadDataset?: () => void;
}) {
  const [schema, setSchema] = useState(() => source.schema);
  const [schemaTotal, setSchemaTotal] = useState<number | null>(null);
  const [schemaPageLoading, setSchemaPageLoading] = useState(false);
  const [schemaPageError, setSchemaPageError] = useState(false);
  const schemaPageRequest = useRef(0);
  const schemaPageActive = useRef(false);
  const schemaSource = useMemo(() => ({ ...source, schema }), [schema, source]);
  const [columnStates, setColumnStates] = useState<ColumnState[]>(() => {
    const duplicateNames = duplicateTopLevelNames(source.schema);
    return source.schema.map((field, sourceIndex) =>
      sourceColumnState(
        source.schema,
        duplicateNames,
        field,
        sourceIndex,
        defaultPinnedSourceIndices.has(sourceIndex),
      ),
    );
  });
  const columnMemoryRef = useRef(
    new Map(columnStates.map((column) => [column.key, column])),
  );
  useEffect(() => {
    for (const column of columnStates) {
      columnMemoryRef.current.set(column.key, column);
    }
  }, [columnStates]);
  const [columnNotice, setColumnNotice] = useState<ColumnNotice | null>(null);
  const [monospaceColumns, setMonospaceColumns] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [logicalSchema, setLogicalSchema] = useState<{
    generation: number;
    dataTypes: ReadonlyMap<string, DataType>;
  }>(() => ({ generation: source.generation, dataTypes: new Map() }));
  const logicalDataTypes =
    logicalSchema.generation === source.generation
      ? logicalSchema.dataTypes
      : EMPTY_LOGICAL_DATA_TYPES;
  const [loadError, setLoadError] = useState<ViewErrorState | null>(null);
  const [horizontalExtentError, setHorizontalExtentError] = useState<
    string | null
  >(null);
  const [viewError, setViewError] = useState<ViewErrorState | null>(null);
  const [selection, setSelection] = useState<GridSelection>(() =>
    emptySelection(),
  );
  const [copyLimit, setCopyLimit] = useState<number | null>(null);
  const [copyingSelection, setCopyingSelection] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
  const [gridMenu, setGridMenu] = useState<GridMenu | null>(null);
  const [peek, setPeek] = useState<PeekState | null>(null);
  const [resolvedPeek, setResolvedPeek] = useState<{
    address: GridAddress;
    value: PeekValue;
  } | null>(null);
  const [peekFocusRequest, setPeekFocusRequest] = useState(0);
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
  const [selectedSchemaPath, setSelectedSchemaPath] =
    useState<FieldPath | null>(null);
  const [schemaFocusRequest, setSchemaFocusRequest] = useState(0);
  const gridRef = useRef<ViewdaGridHandle>(null);
  useEffect(() => {
    if (!active) setPeek(null);
  }, [active]);
  const appliedRequestedRow = useRef<number | null>(null);
  useEffect(() => {
    if (
      requestedRow === null ||
      appliedRequestedRow.current === requestedRow.request
    ) {
      return;
    }
    appliedRequestedRow.current = requestedRow.request;
    gridRef.current?.scrollToRow(requestedRow.row);
  }, [requestedRow]);
  const schemaFocusPathRef = useRef<FieldPath | null>(null);
  const visibleColumnStatesRef = useRef<readonly ColumnState[]>([]);
  // The display cache holds one row window and one column supplement. The row
  // window owns the prefetch range. The supplement holds columns missing from
  // that window for the mounted rows. Leaving the prefetched range replaces both.
  // This reuses shared columns while keeping Arrow memory bounded for wide values.
  const baseWindowRef = useRef<ArrowDataWindow | null>(null);
  const supplementWindowRef = useRef<ArrowDataWindow | null>(null);
  const activeCellValueCacheRef = useRef<ActiveCellValueCache | null>(null);
  const peekValueCacheRef = useRef<PeekValueCache | null>(null);
  const [activeCellRef] = useState(() => ({
    current: selection.current?.cell as GridAddress | undefined,
  }));
  const visibleViewportRef = useRef<GridViewport | null>(null);
  const copyTailRef = useRef<Promise<void>>(Promise.resolve());
  const [copyWindowsRef] = useState(() => ({
    current: new Map<string, Promise<ArrowDataWindow>>(),
  }));
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
  const contentIdentityRef = useRef(contentIdentity);
  const sourceSchemaRef = useRef(source.schema);
  const projectionRevisionRef = useRef(0);
  const previousProjectionRef = useRef<readonly FieldPath[] | null>(null);
  const requestedProjectionRef = useRef<readonly FieldPath[]>([]);
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

  const replaceDataWindow = useCallback(
    (
      windowRef: { current: ArrowDataWindow | null },
      next: ArrowDataWindow | null,
    ) => {
      const previous = windowRef.current;
      if (
        previous !== next &&
        activeCellValueCacheRef.current?.dataWindow === previous
      ) {
        activeCellValueCacheRef.current = null;
      }
      if (
        previous !== next &&
        peekValueCacheRef.current?.dataWindow === previous
      ) {
        peekValueCacheRef.current = null;
      }
      windowRef.current = next;
    },
    [],
  );

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
      ...columnStates.filter((column) => column.pinned),
      ...columnStates.filter((column) => !column.pinned),
    ],
    [columnStates],
  );
  const ambiguousTopLevelNames = useMemo(
    () => duplicateTopLevelNames(schema),
    [schema],
  );
  const schemaPathIndex = useMemo(() => indexSchemaPaths(schema), [schema]);
  const pathActionsAvailable = ambiguousTopLevelNames.size === 0;
  const identitySchemaPending =
    !pathActionsAvailable &&
    source.schemaIsTruncated &&
    (schemaTotal === null || schema.length < schemaTotal);
  const identityFieldPaths = useMemo(
    () => schema.map((field) => [field.name]),
    [schema],
  );
  visibleColumnStatesRef.current = visibleColumnStates;
  const activeCell = selection.current?.cell;
  useLayoutEffect(() => {
    if (
      activeCellRef.current?.column !== activeCell?.column ||
      activeCellRef.current?.row !== activeCell?.row
    ) {
      activeCellValueCacheRef.current = null;
    }
    activeCellRef.current = activeCell;
  }, [activeCell, activeCellRef]);
  const selectIsIdentity =
    visibleColumnStates.length === schema.length &&
    visibleColumnStates.every(
      (column, index) =>
        column.sourceIndex === index &&
        column.fieldPath.length === 1 &&
        column.fieldPath[0] === schema[index]?.name,
    );
  const omittedRootCount = useMemo(() => {
    const projectedSourceIndices = new Set(
      columnStates.map((column) => column.sourceIndex),
    );
    return schema.reduce(
      (count, _field, sourceIndex) =>
        count + (projectedSourceIndices.has(sourceIndex) ? 0 : 1),
      0,
    );
  }, [columnStates, schema]);
  activeViewRef.current = activeView;

  const nextSuggestionRevision = useCallback(() => {
    nextSuggestionRevisionRef.current += 1;
    return nextSuggestionRevisionRef.current;
  }, []);
  pendingViewRef.current = pendingView;
  const filters = activeView.filters;
  const sort = activeView.sort;
  const gridRowCount = activeView.rowCount;
  const visibleFieldPaths = useMemo(
    () => visibleColumnStates.map((column) => column.fieldPath),
    [visibleColumnStates],
  );
  const visibleProjectionKey = useMemo(
    () => visibleFieldPaths.map(fieldPathKey).join("\0"),
    [visibleFieldPaths],
  );
  const visibleColumnKeys = useMemo(
    () => visibleColumnStates.map((column) => column.key),
    [visibleColumnStates],
  );
  const previousVisibleColumnKeysRef = useRef(visibleColumnKeys);
  useLayoutEffect(() => {
    const previous = previousVisibleColumnKeysRef.current;
    previousVisibleColumnKeysRef.current = visibleColumnKeys;
    setPeek((current) => {
      if (
        current === null ||
        previous[current.address.column] ===
          visibleColumnKeys[current.address.column]
      ) {
        return current;
      }
      peekValueCacheRef.current = null;
      return null;
    });
  }, [visibleColumnKeys]);
  const selectTitle = useMemo(() => {
    if (selectIsIdentity) {
      return "*";
    }
    if (!pathActionsAvailable) {
      return "All source columns in file order";
    }
    if (visibleFieldPaths.length > SELECT_TOOLTIP_COLUMN_LIMIT) {
      return `${visibleFieldPaths.length.toLocaleString("en-US")} projected columns`;
    }
    return formatSelectClause(visibleFieldPaths, schema);
  }, [pathActionsAvailable, schema, selectIsIdentity, visibleFieldPaths]);
  const pickerColumns = useMemo(
    () => projectionPickerColumns(schema, columnStates, pathActionsAvailable),
    [columnStates, pathActionsAvailable, schema],
  );
  const selectedExport = useMemo(
    () => exportSelectionShape(selection, visibleFieldPaths, gridRowCount),
    [gridRowCount, selection, visibleFieldPaths],
  );
  const whereClause = useMemo(
    () => formatWhereClause(filters, schema),
    [filters, schema],
  );
  const orderByClause = useMemo(
    () => formatOrderByClause(sort, schema),
    [sort, schema],
  );
  const railMetadataByColumnKey = useMemo(
    () => flattenedRailMetadata(visibleColumnStates, schema, logicalDataTypes),
    [logicalDataTypes, schema, visibleColumnStates],
  );
  const flattenedPathKeys = useMemo(
    () => projectedStructPathKeys(columnStates),
    [columnStates],
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
        const sortIndex = displayedSort.findIndex((entry) =>
          sameFieldPath(entry.fieldPath, column.fieldPath),
        );
        const key = column.key;
        const groupRail = railMetadataByColumnKey.get(key);
        return {
          id: key,
          title: column.title,
          ...fieldPathTitleParts(column.fieldPath),
          ...(groupRail === undefined ? {} : { groupRail }),
          width: column.width,
          monospace: monospaceColumns.has(key),
          pinned: column.pinned,
          pending: pendingView !== null && sortIndex >= 0,
          sortable: pathActionsAvailable,
          filterable: pathActionsAvailable,
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
    [
      monospaceColumns,
      pendingView,
      pathActionsAvailable,
      railMetadataByColumnKey,
      sort,
      visibleColumnStates,
    ],
  );

  const materializeCellValue = useCallback(
    (
      dataWindow: ArrowDataWindow,
      column: ColumnState,
      row: number,
      useActiveCellCache: boolean,
    ): { value: TypedValue; dataType: DataType } | undefined => {
      const cache = activeCellValueCacheRef.current;
      const fieldKey = column.key;
      if (
        useActiveCellCache &&
        cache !== null &&
        cache.fieldKey === fieldKey &&
        cache.row === row &&
        cache.dataWindow === dataWindow
      ) {
        return cache;
      }
      const columnOffset = pathActionsAvailable
        ? dataWindow.fieldColumnOffsets.get(fieldKey)
        : column.sourceIndex;
      if (columnOffset === undefined) return undefined;
      const dataType = windowDataTypeAt(dataWindow, columnOffset);
      if (dataType === undefined) return undefined;
      const arrowValue = windowArrowValueAt(dataWindow, columnOffset, row);
      const result = {
        value:
          arrowValue === undefined
            ? typedValue(windowValueAt(dataWindow, columnOffset, row), dataType)
            : arrowTypedValue(arrowValue),
        dataType,
      };
      if (useActiveCellCache) {
        activeCellValueCacheRef.current = {
          fieldKey,
          row,
          dataWindow,
          ...result,
        };
      }
      return result;
    },
    [pathActionsAvailable],
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
      const activeCell = activeCellRef.current;
      const cacheActiveCell =
        !includeRawCopy &&
        activeCell?.column === visibleColumn &&
        activeCell.row === row;
      const materialized = materializeCellValue(
        window,
        column,
        row,
        cacheActiveCell,
      );
      if (materialized === undefined) return loadingCell();
      const formatted = formatTypedCellValue(
        materialized.value,
        includeRawCopy,
      );
      return {
        kind: "text",
        displayData: formatted.displayData,
        copyData: formatted.copyData,
        alignment: formatted.align,
        faded: formatted.faded,
        ...(formatted.segments === undefined
          ? {}
          : { segments: formatted.segments }),
      };
    },
    [materializeCellValue, visibleColumnStates],
  );

  const getCellContent = useCallback(
    ({ column, row }: GridAddress): GridCell => {
      const visible = visibleColumnStatesRef.current[column];
      const supplement = supplementWindowRef.current;
      if (
        visible !== undefined &&
        supplement !== null &&
        windowContainsRow(supplement, row) &&
        (pathActionsAvailable ||
          supplement.table.schema.fields[visible.sourceIndex] !== undefined) &&
        (pathActionsAvailable
          ? supplement.fieldColumnOffsets.has(visible.key)
          : true)
      ) {
        return readCell(supplement, column, row);
      }
      const base = baseWindowRef.current;
      return base === null ? loadingCell() : readCell(base, column, row);
    },
    [readCell],
  );

  const readPeekValue = useCallback(
    (address: GridAddress): PeekValue | undefined => {
      const column = visibleColumnStatesRef.current[address.column];
      if (column === undefined) return undefined;
      const supplement = supplementWindowRef.current;
      const base = baseWindowRef.current;
      const dataWindow =
        supplement !== null &&
        windowContainsRow(supplement, address.row) &&
        (pathActionsAvailable
          ? supplement.fieldColumnOffsets.has(column.key)
          : supplement.table.schema.fields[column.sourceIndex] !== undefined)
          ? supplement
          : base;
      if (dataWindow === null || !windowContainsRow(dataWindow, address.row)) {
        return undefined;
      }
      const materialized = materializeCellValue(
        dataWindow,
        column,
        address.row,
        true,
      );
      if (materialized === undefined) return undefined;
      const logicalType = column.field.logicalType;
      const fieldKey = column.key;
      const cached = peekValueCacheRef.current;
      if (
        cached !== null &&
        cached.dataWindow === dataWindow &&
        cached.fieldKey === fieldKey &&
        cached.row === address.row &&
        cached.label === column.title &&
        cached.logicalType === logicalType
      ) {
        return cached.peekValue;
      }
      const peekValue = {
        label: column.title,
        value:
          materialized.value.kind === "arrow"
            ? arrowTypedValue(materialized.value, logicalType)
            : materialized.value.kind === "value"
              ? typedValue(
                  materialized.value.value,
                  materialized.dataType,
                  logicalType,
                )
              : materialized.value,
      };
      peekValueCacheRef.current = {
        fieldKey,
        row: address.row,
        dataWindow,
        label: column.title,
        logicalType,
        peekValue,
      };
      return peekValue;
    },
    [materializeCellValue, pathActionsAvailable],
  );

  const openPeek = useCallback(
    (
      address: GridAddress,
      bounds: Rectangle,
      behavior: "toggle" | "open" = "toggle",
    ) => {
      setHeaderMenu(null);
      setGridMenu(null);
      setFilterEditor(null);
      setPeek((current) =>
        behavior === "toggle" &&
        current !== null &&
        current.address.row === address.row &&
        current.address.column === address.column
          ? null
          : { address, bounds },
      );
    },
    [],
  );

  const queueRequestTrace = useCallback(
    (request: VersionedRowRequest) => {
      if (!diagnostics.isEnabled()) return null;
      const view = activeViewRef.current;
      return diagnostics.queueRequest({
        reason: request.reason,
        rowOffset: request.rows.offset,
        rowCount: request.rows.count,
        projectionCount: request.fieldPaths.length,
        projectionKey: projectionFingerprint(request.fieldPaths),
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
      replaceDataWindow(baseWindowRef, null);
      replaceDataWindow(supplementWindowRef, null);
      copyWindowsRef.current.clear();
      copyAbortRef.current?.abort();
      setSelection(emptySelection());
      setCopyLimit(null);
      setHeaderMenu(null);
      setGridMenu(null);
      setPeek(null);
      setContentRevision((current) => current + 1);
    },
    [clearDeferredProjection, diagnostics, replaceDataWindow],
  );

  const loadMoreSchema = useCallback(async () => {
    if (schemaPageActive.current) return;
    schemaPageActive.current = true;
    const request = ++schemaPageRequest.current;
    const offset = schema.length;
    setSchemaPageLoading(true);
    setSchemaPageError(false);
    try {
      const page = await getSourceSchemaPage(source.generation, offset, 256);
      if (schemaPageRequest.current === request && page.offset === offset) {
        setSchemaTotal(page.totalCount);
        setSchema((current) => {
          const merged = [...current];
          page.columns.forEach((field, pageIndex) => {
            merged[page.offset + pageIndex] = field;
          });
          return merged;
        });
        const completeSchema = [...schema, ...page.columns];
        const duplicateNames = duplicateTopLevelNames(completeSchema);
        if (duplicateNames.size > 0) {
          const currentView = pendingViewRef.current ?? activeViewRef.current;
          if (
            pendingViewRef.current !== null ||
            currentView.revision !== 0 ||
            currentView.filters.length > 0 ||
            currentView.sort.length > 0
          ) {
            void cancelDataView(source.generation, currentView.revision).catch(
              () => {
                // Revision zero remains readable even if the prepared view has
                // already finished and can no longer be cancelled.
              },
            );
          }
          projectionRevisionRef.current += 1;
          promoteView(0, source.rowCount, [], []);
          setColumnNotice(null);
          setColumnStates((current) =>
            completeSchema.map((field, sourceIndex) => {
              const previous =
                current.find(
                  (column) =>
                    column.sourceIndex === sourceIndex &&
                    column.fieldPath.length === 1,
                ) ??
                current.find((column) => column.sourceIndex === sourceIndex) ??
                [...columnMemoryRef.current.values()].find(
                  (column) =>
                    column.sourceIndex === sourceIndex &&
                    column.fieldPath.length === 1,
                );
              const restored = sourceColumnState(
                completeSchema,
                duplicateNames,
                field,
                sourceIndex,
                defaultPinnedSourceIndices.has(sourceIndex),
              );
              return previous === undefined
                ? restored
                : {
                    ...restored,
                    width: previous.width,
                    pinned: previous.pinned,
                  };
            }),
          );
        } else {
          setColumnStates((current) => {
            const loadedSourceIndices = new Set(
              current.map((column) => column.sourceIndex),
            );
            const retained = current.map((column) => ({
              ...column,
              key:
                column.fieldPath.length === 1
                  ? sourceColumnKey(
                      completeSchema,
                      duplicateNames,
                      column.sourceIndex,
                    )
                  : column.key,
            }));
            const added = page.columns.flatMap((field, pageIndex) => {
              const sourceIndex = page.offset + pageIndex;
              const key = sourceColumnKey(
                completeSchema,
                duplicateNames,
                sourceIndex,
              );
              return loadedSourceIndices.has(sourceIndex) ||
                columnMemoryRef.current.has(key)
                ? []
                : [
                    sourceColumnState(
                      completeSchema,
                      duplicateNames,
                      field,
                      sourceIndex,
                      defaultPinnedSourceIndices.has(sourceIndex),
                    ),
                  ];
            });
            return [...retained, ...added];
          });
        }
      }
    } catch {
      if (schemaPageRequest.current === request) setSchemaPageError(true);
    } finally {
      if (schemaPageRequest.current === request) {
        schemaPageActive.current = false;
        setSchemaPageLoading(false);
      }
    }
  }, [
    defaultPinnedSourceIndices,
    promoteView,
    schema,
    source.generation,
    source.rowCount,
  ]);

  useEffect(() => {
    if (
      active &&
      source.schemaIsTruncated &&
      (schemaTotal === null ||
        (!pathActionsAvailable && schema.length < schemaTotal))
    ) {
      void loadMoreSchema();
    }
  }, [
    active,
    loadMoreSchema,
    pathActionsAvailable,
    schema.length,
    schemaTotal,
    source.schemaIsTruncated,
  ]);

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
          request.fieldPaths,
        );
        const decoded = decodeArrowWindow(
          bytes,
          request.rows.offset,
          request.fieldPaths,
          pathActionsAvailable
            ? undefined
            : { allowDuplicateTopLevelIdentity: true },
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
            const fieldPath = decoded.fieldPaths[columnOffset];
            if (fieldPath !== undefined && usesMonospaceCells(field.type)) {
              next.add(
                pathActionsAvailable
                  ? fieldPathKey(fieldPath)
                  : sourceColumnKey(
                      schema,
                      ambiguousTopLevelNames,
                      columnOffset,
                    ),
              );
            }
          });
          return next.size === current.size ? current : next;
        });
        setLogicalSchema((current) => {
          const next = new Map(
            current.generation === source.generation
              ? current.dataTypes
              : EMPTY_LOGICAL_DATA_TYPES,
          );
          decoded.table.schema.fields.forEach((field, columnOffset) => {
            const fieldPath = decoded.fieldPaths[columnOffset];
            if (fieldPath !== undefined) {
              next.set(fieldPathKey(fieldPath), field.type);
            }
          });
          return { generation: source.generation, dataTypes: next };
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
          replaceDataWindow(baseWindowRef, decoded);
          replaceDataWindow(supplementWindowRef, null);
        } else {
          replaceDataWindow(supplementWindowRef, decoded);
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
                fieldPaths: request.fieldPaths,
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
    replaceDataWindow,
    pathActionsAvailable,
    schema,
    source.generation,
  ]);

  const requestRows = useCallback(
    (
      visibleStart: number,
      visibleCount: number,
      planningRowCount = activeViewRef.current.rowCount,
    ) => {
      if (identitySchemaPending) return;
      const scrollState = nextScrollState(scrollStateRef.current, visibleStart);
      scrollStateRef.current = scrollState;
      const request = rowRequest(
        planningRowCount,
        visibleStart,
        visibleCount,
        scrollState.direction,
      );
      const activeView = activeViewRef.current;
      const fieldPaths = pathActionsAvailable
        ? projectedFieldPaths(
            visibleColumnStatesRef.current,
            visibleViewportRef.current?.mountedColumnIndices ?? [],
            GRID_INITIAL_COLUMNS,
          )
        : identityFieldPaths;
      if (fieldPaths.length === 0) {
        return;
      }
      const previousProjection = requestedProjectionRef.current;
      const projectionChanged = !sameColumnSet(previousProjection, fieldPaths);
      requestedProjectionRef.current = fieldPaths;
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
        fieldPaths,
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
          ? fieldPaths
          : fieldPaths.filter(
              (fieldPath) =>
                !base.fieldColumnOffsets.has(fieldPathKey(fieldPath)),
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
        fieldPaths:
          cacheSlot === "columnSupplement" ? missingFromBase : fieldPaths,
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
    [
      clearDeferredProjection,
      diagnostics,
      drainRequests,
      identityFieldPaths,
      identitySchemaPending,
      pathActionsAvailable,
      queueRequestTrace,
    ],
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
    replaceDataWindow(baseWindowRef, null);
    replaceDataWindow(supplementWindowRef, null);
    setContentRevision((current) => current + 1);
    if (active.rowCount === 0) {
      return;
    }
    const visible = visibleViewportRef.current;
    requestRows(
      visible?.rowStart ?? 0,
      visible?.rowCount ?? Math.min(GRID_INITIAL_ROWS, active.rowCount),
    );
  }, [clearDeferredProjection, diagnostics, replaceDataWindow, requestRows]);

  useEffect(() => {
    const previous = previousProjectionRef.current;
    previousProjectionRef.current = visibleFieldPaths;
    if (previous === null) {
      return;
    }
    if (
      previous.length === visibleFieldPaths.length &&
      projectionContains(previous, visibleFieldPaths)
    ) {
      if (!sameColumnOrder(previous, visibleFieldPaths)) {
        setSelection(clearColumnSelection);
        setCopyLimit(null);
      }
      return;
    }
    copyAbortRef.current?.abort();
    projectionRevisionRef.current += 1;
    diagnostics.disposeRequest(
      pendingRequestRef.current?.traceId ?? null,
      "invalidatedBeforeStart",
    );
    pendingRequestRef.current = null;
    clearDeferredProjection("invalidatedBeforeStart");
    failedRequestRef.current = null;
    desiredRequestRef.current = null;
    replaceDataWindow(baseWindowRef, null);
    replaceDataWindow(supplementWindowRef, null);
    copyWindowsRef.current.clear();
    setLoadError(null);
    setSelection(clearColumnSelection);
    setCopyLimit(null);
    setContentRevision((current) => current + 1);
  }, [
    clearDeferredProjection,
    diagnostics,
    replaceDataWindow,
    visibleFieldPaths,
  ]);

  useEffect(() => {
    setHeaderMenu((current) =>
      current !== null &&
      visibleColumnKeyIndex(current.columnKey, visibleColumnStates) >= 0
        ? current
        : null,
    );
    setGridMenu((current) =>
      current !== null &&
      visibleColumnKeyIndex(current.columnKey, visibleColumnStates) >= 0
        ? current
        : null,
    );
    setFilterEditor((current) => {
      if (current?.gridAnchor === undefined) {
        return current;
      }
      return visibleColumnIndex(current.fieldPath, visibleColumnStates) >= 0
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
  }, [source.generation]);

  useEffect(() => {
    if (!exportEnabled) {
      setExportStatus(null);
      setExportError(null);
      return;
    }
    refreshExportStatus();
  }, [exportEnabled, refreshExportStatus]);

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
      if (
        !pathActionsAvailable ||
        !exportEnabled ||
        exportStarting ||
        exportStatus?.state === "running"
      ) {
        return;
      }
      const shape = scope === "selection" ? selectedExport : null;
      if (scope === "selection" && shape === null) {
        return;
      }
      const request: DataExportRequest = {
        fieldPaths:
          shape?.fieldPaths ??
          visibleColumnStates.map(({ fieldPath }) => fieldPath),
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
      exportEnabled,
      exportStatus?.state,
      pathActionsAvailable,
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
    const fieldPath = schemaFocusPathRef.current;
    if (fieldPath === null) {
      return;
    }
    const visibleIndex = visibleColumnStatesRef.current.findIndex((column) =>
      sameFieldPath(column.fieldPath, fieldPath),
    );
    if (visibleIndex < 0) {
      return;
    }
    gridRef.current?.scrollToColumn(visibleIndex, 16);
    setSelection(selectColumn(emptySelection(), visibleIndex, false, false));
  }, [schemaFocusRequest]);

  const applyView = useCallback(
    (
      nextFilters: DataFilter[],
      nextSort: SortColumn[],
      forceSourceRefresh = false,
    ) => {
      const current = pendingViewRef.current ?? activeViewRef.current;
      if (
        !forceSourceRefresh &&
        viewDefinitionEquals(current, nextFilters, nextSort)
      ) {
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
      if (!forceSourceRefresh && source.rowCount === 0) {
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
      setPeek(null);
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

  useEffect(() => {
    if (contentIdentityRef.current === contentIdentity) return;
    contentIdentityRef.current = contentIdentity;
    schemaPageRequest.current += 1;
    schemaPageActive.current = false;
    setSchemaPageLoading(false);
    setSchemaPageError(false);
    setSchemaTotal(null);
    setColumnNotice(null);
    const previousSchema = sourceSchemaRef.current;
    sourceSchemaRef.current = source.schema;
    const current = pendingViewRef.current ?? activeViewRef.current;
    const fieldStillMatches = (fieldPath: FieldPath) =>
      sameFieldContract(
        resolveSchemaField(previousSchema, fieldPath),
        resolveSchemaField(source.schema, fieldPath),
      );
    const nextFilters = current.filters.filter(({ fieldPath }) =>
      fieldStillMatches(fieldPath),
    );
    const nextSort = current.sort.filter(({ fieldPath }) =>
      fieldStillMatches(fieldPath),
    );
    const viewContractChanged =
      nextFilters.length !== current.filters.length ||
      nextSort.length !== current.sort.length;
    const nextDuplicateNames = duplicateTopLevelNames(source.schema);

    setSchema(source.schema);
    setSelectedSchemaPath((selected) =>
      selected !== null && fieldStillMatches(selected) ? selected : null,
    );
    setColumnStates((previous) => {
      const retained = previous.flatMap((existing) => {
        const field = resolveSchemaField(source.schema, existing.fieldPath);
        if (field === undefined || !fieldStillMatches(existing.fieldPath)) {
          return [];
        }
        return {
          ...existing,
          field,
        };
      });
      const retainedKeys = new Set(retained.map((column) => column.key));
      const added = source.schema.flatMap((field, sourceIndex) => {
        const fieldPath = [field.name];
        const key = sourceColumnKey(
          source.schema,
          nextDuplicateNames,
          sourceIndex,
        );
        const rootRepresented = retained.some(
          (column) => column.sourceIndex === sourceIndex,
        );
        return retainedKeys.has(key) ||
          rootRepresented ||
          columnMemoryRef.current.has(key)
          ? []
          : [
              {
                key,
                sourceIndex,
                fieldPath,
                field,
                title: formatFieldPath(fieldPath),
                width: Math.min(
                  280,
                  Math.max(MIN_COLUMN_WIDTH, field.name.length * 8 + 48),
                ),
                pinned: defaultPinnedSourceIndices.has(sourceIndex),
              },
            ];
      });
      return [...retained, ...added];
    });
    applyView(nextFilters, nextSort, true);
    if (viewContractChanged) {
      setViewError({
        message:
          "Some preview filters or sort columns were reset because the complete schema changed.",
      });
    }
  }, [applyView, contentIdentity, defaultPinnedSourceIndices, source.schema]);

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

  const flattenPath = useCallback(
    (fieldPath: FieldPath) => {
      setColumnStates((current) => {
        const index = current.findIndex((column) =>
          sameFieldPath(column.fieldPath, fieldPath),
        );
        const parent = current[index];
        if (parent === undefined || !isStructField(parent.field)) {
          const parentPath = fieldPath.slice(0, -1);
          setColumnNotice({
            message:
              parent === undefined
                ? current.some(
                    (column) =>
                      column.fieldPath.length > fieldPath.length &&
                      fieldPathStartsWith(column.fieldPath, fieldPath),
                  )
                  ? `${formatFieldPath(fieldPath)} is already flattened.`
                  : `Flatten ${formatFieldPath(parentPath) || "the parent struct"} first.`
                : `${formatFieldPath(fieldPath)} is not a struct field.`,
            kind: "status",
          });
          return current;
        }
        const duplicateChild = duplicateChildName(parent.field);
        if (duplicateChild !== undefined) {
          setColumnNotice({
            message: `${formatFieldPath(fieldPath)} cannot be flattened because it contains multiple fields named ${formatFieldPathSegment(duplicateChild)}.`,
            kind: "status",
          });
          return current;
        }
        const children = parent.field.children.map((field) => {
          const childPath = [...parent.fieldPath, field.name];
          return projectedColumnState(
            schema,
            schemaPathIndex,
            ambiguousTopLevelNames,
            childPath,
            defaultPinnedSourceIndices.has(parent.sourceIndex),
            columnMemoryRef.current,
            parent,
          )!;
        });
        setColumnNotice({
          message: `Flattened ${formatFieldPath(fieldPath)} into ${children.length.toLocaleString("en-US")} ${children.length === 1 ? "column" : "columns"}.`,
          kind: "status",
        });
        setSelection(clearColumnSelection);
        setCopyLimit(null);
        return [
          ...current.slice(0, index),
          ...children,
          ...current.slice(index + 1),
        ];
      });
      setHeaderMenu(null);
    },
    [
      ambiguousTopLevelNames,
      defaultPinnedSourceIndices,
      schema,
      schemaPathIndex,
    ],
  );

  const unflattenPath = useCallback(
    (fieldPath: FieldPath) => {
      const entry = schemaPathIndex.get(fieldPathKey(fieldPath));
      if (entry === undefined) return;
      const { sourceIndex } = entry;
      setColumnStates((current) => {
        const descendantIndices = current.flatMap((column, index) =>
          fieldPathStartsWith(column.fieldPath, fieldPath) &&
          column.fieldPath.length > fieldPath.length
            ? [index]
            : [],
        );
        if (descendantIndices.length === 0) return current;
        const insertion = descendantIndices[0] ?? current.length;
        const retained = current.filter(
          (column) =>
            !(
              fieldPathStartsWith(column.fieldPath, fieldPath) &&
              column.fieldPath.length > fieldPath.length
            ),
        );
        const parent = projectedColumnState(
          schema,
          schemaPathIndex,
          ambiguousTopLevelNames,
          fieldPath,
          defaultPinnedSourceIndices.has(sourceIndex),
          columnMemoryRef.current,
          current[descendantIndices[0]!],
        );
        if (parent === undefined) return current;
        return [
          ...retained.slice(0, insertion),
          parent,
          ...retained.slice(insertion),
        ];
      });
      const current = pendingViewRef.current ?? activeViewRef.current;
      const dependentFilter = (filter: DataFilter) =>
        filter.fieldPath.length > fieldPath.length &&
        fieldPathStartsWith(filter.fieldPath, fieldPath);
      const dependentSort = (column: SortColumn) =>
        column.fieldPath.length > fieldPath.length &&
        fieldPathStartsWith(column.fieldPath, fieldPath);
      const removedFilterPaths = current.filters
        .filter(dependentFilter)
        .map((filter) => filter.fieldPath);
      const removedSortPaths = current.sort
        .filter(dependentSort)
        .map((column) => column.fieldPath);
      if (removedFilterPaths.length + removedSortPaths.length > 0) {
        applyView(
          current.filters.filter((filter) => !dependentFilter(filter)),
          current.sort.filter((column) => !dependentSort(column)),
        );
      }
      setColumnNotice({
        message:
          removedFilterPaths.length + removedSortPaths.length === 0
            ? `Unflattened ${formatFieldPath(fieldPath)} into one column.`
            : `Unflattened ${formatFieldPath(fieldPath)} into one column; removed ${formatDroppedPathNotice(removedFilterPaths, removedSortPaths)}.`,
        kind:
          removedFilterPaths.length + removedSortPaths.length === 0
            ? "status"
            : "alert",
      });
      setSelection(clearColumnSelection);
      setCopyLimit(null);
      setHeaderMenu(null);
    },
    [
      ambiguousTopLevelNames,
      applyView,
      defaultPinnedSourceIndices,
      schema,
      schemaPathIndex,
    ],
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
      selectedFieldPaths: readonly FieldPath[],
    ): Promise<ArrowDataWindow> => {
      if (identitySchemaPending) {
        return Promise.reject(
          new Error("The complete source schema is still loading."),
        );
      }
      const offset = Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
      const view = activeViewRef.current;
      const fieldPaths = pathActionsAvailable
        ? [...selectedFieldPaths].sort((left, right) =>
            fieldPathKey(left).localeCompare(fieldPathKey(right)),
          )
        : identityFieldPaths;
      const key = `${view.revision}:${offset}:${fieldPaths.map(fieldPathKey).join("\0")}`;
      const existing = copyWindowsRef.current.get(key);
      if (existing !== undefined) {
        return existing;
      }

      const count = Math.min(COPY_CHUNK_ROWS, view.rowCount - offset);
      const request = copyTailRef.current.then(async () => {
        const bytes = await getDataWindow(
          source.generation,
          view.revision,
          offset,
          count,
          fieldPaths,
        );
        return decodeArrowWindow(
          bytes,
          offset,
          fieldPaths,
          pathActionsAvailable
            ? undefined
            : { allowDuplicateTopLevelIdentity: true },
        );
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
    [
      identityFieldPaths,
      identitySchemaPending,
      pathActionsAvailable,
      source.generation,
    ],
  );

  const loadCopyContents = useCallback(
    (
      rows: readonly number[],
      columnIndices: readonly number[],
      abortSignal: AbortSignal,
    ) => {
      const selectedColumns = columnIndices.flatMap((index) => {
        const column = visibleColumnStates[index];
        return column === undefined ? [] : [column];
      });
      const fieldPaths = selectedColumns.map((column) => column.fieldPath);
      const scheduler = new ChunkScheduler();
      const buffer = new IncrementalCopyBuffer();
      return new Promise<{ textPlain: string; textHtml: string }>(
        (resolve, reject) => {
          let rowIndex = 0;
          let columnIndex = 0;
          let dataWindow: ArrowDataWindow | null = null;
          let serializer: ReturnType<typeof createValueCopySerializer> | null =
            null;
          let cellPending = false;
          let settled = false;
          const settle = (
            result:
              | { contents: { textPlain: string; textHtml: string } }
              | { error: unknown },
          ) => {
            if (settled) return;
            settled = true;
            abortSignal.removeEventListener("abort", cancel);
            scheduler.cancel();
            if ("error" in result) reject(result.error);
            else resolve(result.contents);
          };
          const cancel = () =>
            settle({
              error: new DOMException("Copy was cancelled.", "AbortError"),
            });
          if (abortSignal.aborted) {
            cancel();
            return;
          }
          abortSignal.addEventListener("abort", cancel, { once: true });
          scheduler.start({
            runChunk: (deadline, maxUnits) => {
              try {
                let units = 0;
                while (
                  rowIndex < rows.length &&
                  units < maxUnits &&
                  (units === 0 || performance.now() < deadline)
                ) {
                  throwIfCopyAborted(abortSignal);
                  const row = rows[rowIndex]!;
                  const expectedOffset =
                    Math.floor(row / COPY_CHUNK_ROWS) * COPY_CHUNK_ROWS;
                  if (dataWindow?.rowOffset !== expectedOffset) {
                    scheduler.pause();
                    void loadCopyWindow(row, fieldPaths).then(
                      (loaded) => {
                        if (abortSignal.aborted) {
                          cancel();
                          return;
                        }
                        dataWindow = loaded;
                        scheduler.resume();
                      },
                      (error: unknown) => settle({ error }),
                    );
                    return false;
                  }
                  if (serializer !== null) {
                    const previousUnits = serializer.units;
                    const serialized = serializer.stepUntil(
                      deadline,
                      () => performance.now(),
                      Math.max(1, maxUnits - units),
                    );
                    units += serializer.units - previousUnits;
                    if (serialized.status === "pending") return false;
                    if (serialized.status === "limit") {
                      settle({
                        error: new CopyBufferLimitError(
                          VALUE_COPY_CHARACTER_LIMIT,
                        ),
                      });
                      return true;
                    }
                    buffer.beginCell(
                      serialized.text,
                      columnIndex === 0,
                      rowIndex === 0,
                    );
                    serializer = null;
                    cellPending = true;
                  }
                  if (cellPending) {
                    if (
                      units >= maxUnits ||
                      (units > 0 && performance.now() >= deadline)
                    ) {
                      return false;
                    }
                    const step = buffer.stepCell(
                      deadline,
                      Math.max(1, maxUnits - units),
                    );
                    units += step.units;
                    if (!step.done) return false;
                    cellPending = false;
                    columnIndex += 1;
                    if (columnIndex >= selectedColumns.length) {
                      buffer.endRow();
                      columnIndex = 0;
                      rowIndex += 1;
                    }
                    continue;
                  }
                  const selected = selectedColumns[columnIndex];
                  const materialized =
                    selected === undefined
                      ? undefined
                      : materializeCellValue(dataWindow, selected, row, false);
                  units += 1;
                  if (materialized === undefined) {
                    buffer.beginCell("", columnIndex === 0, rowIndex === 0);
                    cellPending = true;
                    continue;
                  }
                  const nested = isNestedDataType(materialized.dataType);
                  const streamingRaw =
                    isStreamingRawCopyType(materialized.dataType) &&
                    (materialized.value.kind === "arrow" ||
                      materialized.dataType.typeId === Type.Dictionary);
                  if (nested || streamingRaw) {
                    serializer = createValueCopySerializer(
                      {
                        value: materialized.value,
                        format: nested ? "json" : "raw",
                      },
                      buffer.remainingCharacters,
                    );
                    continue;
                  }
                  buffer.beginCell(
                    formatTypedScalarCopyData(materialized.value),
                    columnIndex === 0,
                    rowIndex === 0,
                  );
                  cellPending = true;
                }
                if (rowIndex >= rows.length) {
                  throwIfCopyAborted(abortSignal);
                  settle({ contents: buffer.finish() });
                  return true;
                }
                return false;
              } catch (error) {
                settle({ error });
                return true;
              }
            },
          });
        },
      );
    },
    [loadCopyWindow, materializeCellValue, visibleColumnStates],
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
      setCopyingSelection(true);
      setCopyLimit(shape.truncated ? shape.rowLimit : null);
      const contents = loadCopyContents(
        shape.rows,
        shape.columnIndices,
        abortController.signal,
      );
      void gridClipboard
        .write(contents)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            failedRequestRef.current = null;
            setLoadError({
              message:
                error instanceof ValueCopyLimitError ||
                error instanceof CopyBufferLimitError
                  ? error.message
                  : "The selection could not be copied.",
            });
          }
        })
        .finally(() => {
          if (copyAbortRef.current === abortController) {
            copyAbortRef.current = null;
            setCopyingSelection(false);
          }
        });
    },
    [gridRowCount, loadCopyContents, selection, visibleColumnStates.length],
  );

  const updateSelection = useCallback((next: GridSelection) => {
    setSelection(next);
    setCopyLimit(null);
    const address = next.current?.cell;
    if (address !== undefined) {
      setPeek((current) => (current === null ? null : { ...current, address }));
    }
  }, []);

  const updatePeekBounds = useCallback(
    (address: GridAddress, bounds: Rectangle) => {
      setPeek((current) =>
        current === null ||
        current.address.row !== address.row ||
        current.address.column !== address.column ||
        sameRectangle(current.bounds, bounds)
          ? current
          : { ...current, bounds },
      );
    },
    [],
  );

  const resizeColumn = useCallback((visibleIndex: number, width: number) => {
    const key = visibleColumnStatesRef.current[visibleIndex]?.key;
    if (key === undefined) {
      return;
    }
    const clampedWidth = Math.min(
      MAX_COLUMN_WIDTH,
      Math.max(MIN_COLUMN_WIDTH, width),
    );
    setColumnStates((current) =>
      current.map((column) =>
        column.key === key ? { ...column, width: clampedWidth } : column,
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
      const widths = new Map<string, number>();
      for (const column of visibleColumns) {
        const dataType =
          dataWindow === null
            ? undefined
            : pathActionsAvailable
              ? windowDataType(dataWindow, column.fieldPath)
              : windowDataTypeAt(dataWindow, column.sourceIndex);
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
            const value = materializeCellValue(dataWindow, column, row, false);
            if (value !== undefined) {
              displayData.push(
                formatTypedCellValue(value.value, false).displayData,
              );
            }
          }
        }
        widths.set(
          column.key,
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
          const width = widths.get(column.key);
          return width === undefined ? column : { ...column, width };
        }),
      );
    },
    [materializeCellValue, pathActionsAvailable],
  );

  const setColumnProjection = useCallback(
    (id: string, selected: boolean) => {
      const option = pickerColumns.find((column) => column.id === id);
      if (option === undefined || option.disabledReason !== undefined) return;
      setColumnStates((current) => {
        if (!selected) {
          return current.filter((column) =>
            pathActionsAvailable
              ? !fieldPathStartsWith(column.fieldPath, option.fieldPath)
              : column.key !== option.id,
          );
        }
        if (!pathActionsAvailable) {
          if (current.some((column) => column.key === option.id))
            return current;
          const field = schema[option.sourceIndex];
          return field === undefined
            ? current
            : [
                ...current,
                sourceColumnState(
                  schema,
                  ambiguousTopLevelNames,
                  field,
                  option.sourceIndex,
                  defaultPinnedSourceIndices.has(option.sourceIndex),
                  columnMemoryRef.current.get(option.id),
                ),
              ].sort((left, right) => left.sourceIndex - right.sourceIndex);
        }
        const field = schemaPathIndex.get(
          fieldPathKey(option.fieldPath),
        )?.field;
        if (field === undefined) return current;
        const targetPaths = isStructField(field)
          ? addressableLeafPaths(field, option.fieldPath)
          : [option.fieldPath];
        return replaceProjectedSubtree(
          current,
          schema,
          schemaPathIndex,
          ambiguousTopLevelNames,
          option.fieldPath,
          targetPaths,
          defaultPinnedSourceIndices,
          columnMemoryRef.current,
        );
      });
      setSelection(clearColumnSelection);
      setCopyLimit(null);
    },
    [
      ambiguousTopLevelNames,
      defaultPinnedSourceIndices,
      pathActionsAvailable,
      pickerColumns,
      schema,
      schemaPathIndex,
    ],
  );

  const fitColumnWidths = useCallback(
    (visibleColumns: readonly ColumnState[]) => {
      if (visibleColumns.length === 0 || identitySchemaPending) {
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
      const fieldPaths = pathActionsAvailable
        ? visibleColumns.map((column) => column.fieldPath)
        : identityFieldPaths;
      void getDataWindow(
        source.generation,
        view.revision,
        sampleOffset,
        sampleCount,
        fieldPaths,
      )
        .then((bytes) =>
          decodeArrowWindow(
            bytes,
            sampleOffset,
            fieldPaths,
            pathActionsAvailable
              ? undefined
              : { allowDuplicateTopLevelIdentity: true },
          ),
        )
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
    [
      applyFittedColumnWidths,
      identityFieldPaths,
      identitySchemaPending,
      pathActionsAvailable,
      source.generation,
    ],
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
    setColumnStates(() =>
      schema.map((field, sourceIndex) =>
        sourceColumnState(
          schema,
          ambiguousTopLevelNames,
          field,
          sourceIndex,
          defaultPinnedSourceIndices.has(sourceIndex),
          columnMemoryRef.current.get(
            sourceColumnKey(schema, ambiguousTopLevelNames, sourceIndex),
          ),
        ),
      ),
    );
  }, [ambiguousTopLevelNames, defaultPinnedSourceIndices, schema]);

  const hideAllColumns = useCallback(() => {
    setColumnStates([]);
    setSelection(clearColumnSelection);
    setCopyLimit(null);
  }, []);

  const updateColumn = useCallback(
    (id: string, update: Partial<ColumnState>) => {
      setColumnStates((current) =>
        current.map((column) =>
          column.key === id ? { ...column, ...update } : column,
        ),
      );
      setHeaderMenu(null);
      setGridMenu(null);
    },
    [],
  );

  const selectSchemaPath = useCallback((fieldPath: FieldPath) => {
    schemaFocusPathRef.current = fieldPath;
    setSelectedSchemaPath(fieldPath);
    setSchemaFocusRequest((request) => request + 1);
  }, []);

  const flattenFromSidebar = useCallback(
    (fieldPath: FieldPath) => {
      const field = columnStates.find((column) =>
        sameFieldPath(column.fieldPath, fieldPath),
      )?.field;
      selectSchemaPath(fieldPath);
      flattenPath(fieldPath);
      if (
        field !== undefined &&
        isStructField(field) &&
        duplicateChildName(field) === undefined &&
        field.children[0] !== undefined
      ) {
        const childPath = [...fieldPath, field.children[0].name];
        schemaFocusPathRef.current = childPath;
        setSelectedSchemaPath(childPath);
        setSchemaFocusRequest((request) => request + 1);
      }
    },
    [columnStates, flattenPath, selectSchemaPath],
  );

  const unflattenFromSidebar = useCallback(
    (fieldPath: FieldPath) => {
      unflattenPath(fieldPath);
      selectSchemaPath(fieldPath);
    },
    [selectSchemaPath, unflattenPath],
  );

  const promoteFieldToColumn = useCallback(
    (fieldPath: FieldPath) => {
      const field = schemaPathIndex.get(fieldPathKey(fieldPath))?.field;
      if (field === undefined || !isStructField(field)) return;
      setColumnStates((current) =>
        replaceProjectedSubtree(
          current,
          schema,
          schemaPathIndex,
          ambiguousTopLevelNames,
          fieldPath,
          [fieldPath],
          defaultPinnedSourceIndices,
          columnMemoryRef.current,
        ),
      );
      setSelection(clearColumnSelection);
      setCopyLimit(null);
      setPeek(null);
      schemaFocusPathRef.current = fieldPath;
      setSelectedSchemaPath(fieldPath);
      setSchemaFocusRequest((request) => request + 1);
    },
    [
      ambiguousTopLevelNames,
      defaultPinnedSourceIndices,
      schema,
      schemaPathIndex,
    ],
  );

  const openFilterForCell = useCallback(
    (fieldPath: FieldPath, row: number, bounds: Rectangle) => {
      const field = resolveSchemaField(schema, fieldPath);
      const supplement = supplementWindowRef.current;
      const base = baseWindowRef.current;
      const current =
        supplement !== null &&
        windowContainsRow(supplement, row) &&
        supplement.fieldColumnOffsets.has(fieldPathKey(fieldPath))
          ? supplement
          : base;
      if (
        field === undefined ||
        current === null ||
        !windowContainsRow(current, row)
      ) {
        return;
      }
      const value = windowValue(current, fieldPath, row);
      const dataType = windowDataType(current, fieldPath);
      const kind = columnFilterKind(field);
      const initialValue =
        value === null || value === undefined || dataType === undefined
          ? undefined
          : filterInputFromCell(value, dataType, field);
      setHeaderMenu(null);
      setFilterEditor({
        fieldPath,
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
    [schema],
  );

  const menuColumn =
    headerMenu === null
      ? undefined
      : columnStates.find((column) => column.key === headerMenu.columnKey);
  const menuColumnDuplicateChild =
    menuColumn === undefined ? undefined : duplicateChildName(menuColumn.field);
  const menuUnflattenAction = useMemo(() => {
    if (menuColumn === undefined || menuColumn.fieldPath.length < 2) {
      return undefined;
    }
    const path = [menuColumn.fieldPath[0]!];
    return { path };
  }, [menuColumn]);
  const peekValue = resolvedPeek?.value;
  const peekLoading =
    peek !== null &&
    (resolvedPeek === null ||
      resolvedPeek.address.row !== peek.address.row ||
      resolvedPeek.address.column !== peek.address.column);

  useEffect(() => {
    if (peek === null) {
      peekValueCacheRef.current = null;
      setResolvedPeek(null);
      return;
    }
    const value = readPeekValue(peek.address);
    if (value !== undefined) {
      setResolvedPeek({ address: peek.address, value });
    }
  }, [contentRevision, peek, readPeekValue]);
  const filterEditorField =
    filterEditor === null
      ? undefined
      : resolveSchemaField(schema, filterEditor.fieldPath);
  const exportBusy = exportStarting || exportStatus?.state === "running";
  const exportUnavailableLabel = pathActionsAvailable
    ? "Export is available after dataset inspection finishes"
    : "Export is unavailable because this file repeats column names";
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
        fieldPath: filter.fieldPath,
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
            filters.length === 0
              ? WHERE_POPUP_EMPTY_WIDTH
              : WHERE_POPUP_MAX_WIDTH,
          ),
        );
      }
    }
    setWherePopupOpen((open) => !open);
  }, [filters.length, wherePopupOpen]);

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
        {!schemaPageError &&
          source.schemaIsTruncated &&
          schemaTotal !== null &&
          schema.length < schemaTotal && (
            <button
              className="schema-sidebar-toggle"
              type="button"
              disabled={schemaPageLoading}
              onClick={() => void loadMoreSchema()}
            >
              {schemaPageLoading ? "Loading columns…" : "Load more columns"}
            </button>
          )}
        {schemaPageError && (
          <span className="status-error" role="alert">
            More columns could not be loaded.{" "}
            <button type="button" onClick={() => void loadMoreSchema()}>
              Retry loading columns
            </button>
          </span>
        )}
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
              {selectIsIdentity
                ? "*"
                : `[${visibleColumnStates.length.toLocaleString("en-US")} cols]`}
            </button>
            {selectPopupOpen && (
              <ColumnPicker
                columns={pickerColumns}
                projectedCount={columnStates.length}
                onHideAll={hideAllColumns}
                onShowAll={showAllColumns}
                onToggle={setColumnProjection}
                onTogglePinned={(id, pinned) => updateColumn(id, { pinned })}
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
              disabled={!pathActionsAvailable}
              aria-label={
                pathActionsAvailable
                  ? undefined
                  : "WHERE unavailable: duplicate column names"
              }
              title={
                pathActionsAvailable
                  ? undefined
                  : "WHERE is unavailable because this source has duplicate column names."
              }
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
              disabled={!pathActionsAvailable}
              aria-label={
                pathActionsAvailable
                  ? undefined
                  : "ORDER BY unavailable: duplicate column names"
              }
              title={
                pathActionsAvailable
                  ? undefined
                  : "ORDER BY is unavailable because this source has duplicate column names."
              }
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
                      <li key={fieldPathKey(column.fieldPath)}>
                        <code>{formatFieldPath(column.fieldPath)}</code>
                        <select
                          aria-label={`Direction for ${formatFieldPath(column.fieldPath)}`}
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
                          aria-label={`Move ${formatFieldPath(column.fieldPath)} earlier`}
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
                          aria-label={`Move ${formatFieldPath(column.fieldPath)} later`}
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
                          aria-label={`Remove sort ${formatFieldPath(column.fieldPath)}`}
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
                      const column = columnStates.find(
                        (candidate) => candidate.key === event.target.value,
                      );
                      if (column !== undefined) {
                        setSortDraft((current) => [
                          ...current,
                          {
                            fieldPath: column.fieldPath,
                            direction: "ascending",
                          },
                        ]);
                      }
                    }}
                  >
                    <option value="" disabled>
                      Select…
                    </option>
                    {columnStates.map((column) => (
                      <option
                        key={column.key}
                        value={column.key}
                        disabled={sortDraft.some((sorted) =>
                          sameFieldPath(sorted.fieldPath, column.fieldPath),
                        )}
                      >
                        {column.title}
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
          disabled={identitySchemaPending}
          aria-label={
            identitySchemaPending
              ? "Fit column widths after duplicate columns finish loading"
              : "Fit column widths"
          }
          title={
            identitySchemaPending
              ? "Fit column widths after duplicate columns finish loading"
              : "Fit column widths"
          }
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
      {(omittedRootCount > 0 ||
        !pathActionsAvailable ||
        columnNotice?.kind === "status" ||
        copyLimit !== null ||
        copyingSelection) && (
        <div className="grid-controls">
          {copyingSelection && <span role="status">Preparing copy…</span>}
          {columnNotice?.kind === "status" && (
            <span role="status">
              {columnNotice.message}{" "}
              <button type="button" onClick={() => setColumnNotice(null)}>
                Dismiss
              </button>
            </span>
          )}
          {!pathActionsAvailable && (
            <span role="status">
              This file repeats column names, so Viewda identifies columns by
              position. Filtering, sorting, flattening, statistics, and export
              need unique names and are unavailable.
              {identitySchemaPending &&
                " Viewda is loading every column before showing rows."}
            </span>
          )}
          {copyLimit !== null && (
            <span role="status">
              {`This operation is limited to the first ${copyLimit.toLocaleString()} rows of the selection.`}
            </span>
          )}
          {omittedRootCount > 0 && visibleColumnStates.length > 0 && (
            <>
              <span>
                {omittedRootCount.toLocaleString("en-US")} unprojected
              </span>
              <button type="button" onClick={showAllColumns}>
                Show all columns
              </button>
            </>
          )}
        </div>
      )}
      {columnNotice?.kind === "alert" && (
        <ViewErrorAlert
          error={{ message: columnNotice.message }}
          dismissLabel="Dismiss Unflatten alert"
          onDismiss={() => setColumnNotice(null)}
        />
      )}
      {loadError !== null && (
        <ViewErrorAlert
          key={loadError.diagnostics ?? loadError.message}
          error={loadError}
          dismissLabel="Dismiss window error"
          onRetry={
            (loadError.recovery === "reloadDataset" &&
              onReloadDataset !== undefined) ||
            failedRequestRef.current === null
              ? undefined
              : retryWindow
          }
          onReloadDataset={onReloadDataset}
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
          onReloadDataset={onReloadDataset}
          onDismiss={() => setViewError(null)}
        />
      )}
      <div className="data-grid-layout">
        <SchemaSidebar
          key={`${source.generation}:${contentIdentity ?? "source"}`}
          open={sidebarOpen}
          selectedPath={selectedSchemaPath}
          source={schemaSource}
          dataTypes={logicalDataTypes}
          pathActionsEnabled={pathActionsAvailable}
          flattenedPathKeys={flattenedPathKeys}
          onSelectPath={selectSchemaPath}
          onFlattenPath={flattenFromSidebar}
          onUnflattenPath={unflattenFromSidebar}
        />
        {identitySchemaPending ? (
          <div className="filtered-empty-state" role="status">
            <p>Preparing columns…</p>
          </div>
        ) : visibleColumnStates.length === 0 ? (
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
              onCellPeek={openPeek}
              onActiveCellBoundsChange={
                !active || peek === null ? undefined : updatePeekBounds
              }
              onPeekFocus={
                !active || peekValue === undefined
                  ? undefined
                  : () => setPeekFocusRequest((current) => current + 1)
              }
              onScrollInteraction={() => setPeek(null)}
              onCellContextMenu={(cell, bounds) => {
                const column = visibleColumnStates[cell.column];
                if (column === undefined) {
                  return;
                }
                setHeaderMenu(null);
                setGridMenu({
                  bounds,
                  column: cell.column,
                  row: cell.row,
                  columnKey: column.key,
                  fieldPath: column.fieldPath,
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
                if (!pathActionsAvailable) return;
                const fieldPath = visibleColumnStates[visibleIndex]?.fieldPath;
                if (fieldPath !== undefined) {
                  const currentSort =
                    pendingViewRef.current?.sort ?? activeViewRef.current.sort;
                  changeSort(nextSort(currentSort, fieldPath, additive));
                }
              }}
              onFilter={(visibleIndex, bounds) => {
                if (!pathActionsAvailable) return;
                const fieldPath = visibleColumnStates[visibleIndex]?.fieldPath;
                if (fieldPath !== undefined) {
                  setHeaderMenu(null);
                  setFilterEditor({
                    fieldPath,
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
                const column = visibleColumnStates[visibleIndex];
                if (column !== undefined) {
                  setGridMenu(null);
                  setHeaderMenu({
                    columnKey: column.key,
                    fieldPath: column.fieldPath,
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
                    current.fieldPath,
                    undefined,
                    visibleColumnStates,
                    viewport,
                    current.columnKey,
                  )
                    ? current
                    : null,
                );
                setGridMenu((current) =>
                  current !== null &&
                  gridAnchorIsMounted(
                    current.fieldPath,
                    current.row,
                    visibleColumnStates,
                    viewport,
                    current.columnKey,
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
                    current.fieldPath,
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
                setPeek(null);
              }}
            />
          </div>
        )}
      </div>
      {active && peek !== null && peekValue !== undefined && (
        <ValuePeek
          value={peekValue.value}
          label={peekValue.label}
          fieldPath={
            visibleColumnStates[peek.address.column]?.fieldPath ?? [
              peekValue.label,
            ]
          }
          anchor={peek.bounds}
          focusRequest={peekFocusRequest}
          loading={peekLoading}
          showCopyPath={pathActionsAvailable}
          onPromoteField={
            pathActionsAvailable ? promoteFieldToColumn : undefined
          }
          onClose={() => setPeek(null)}
          onReturnFocus={() => gridRef.current?.focus()}
          onCopyIntent={(text) =>
            gridClipboard.writeText(text).then(() => undefined)
          }
        />
      )}
      {wherePopupOpen && (
        <div
          ref={wherePopupRef}
          className={`where-popup${filters.length === 0 ? " is-empty" : ""}`}
          role="dialog"
          aria-label="WHERE conditions"
          style={wherePopupPosition}
        >
          {filters.length === 0 ? (
            <p>No conditions yet.</p>
          ) : (
            <ol>
              {filters.map((filter, index) => {
                const field = resolveSchemaField(schema, filter.fieldPath);
                if (field === undefined) {
                  return null;
                }
                const condition = formatFilterCondition(filter, field);
                return (
                  <li key={`${index}:${fieldPathKey(filter.fieldPath)}`}>
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
              updateColumn(menuColumn.key, {
                pinned: !menuColumn.pinned,
              })
            }
          >
            {menuColumn.pinned ? "Unpin column" : "Pin column"}
          </button>
          {pathActionsAvailable && isStructField(menuColumn.field) && (
            <button
              type="button"
              role="menuitem"
              aria-label={
                menuColumnDuplicateChild === undefined
                  ? "Flatten"
                  : `Flatten ${menuColumn.title}. Unavailable: duplicate child names.`
              }
              disabled={menuColumnDuplicateChild !== undefined}
              title={
                menuColumnDuplicateChild === undefined
                  ? undefined
                  : "Flatten is unavailable because this struct contains duplicate child names."
              }
              onClick={() => flattenPath(menuColumn.fieldPath)}
            >
              <span>Flatten</span>
              {menuColumnDuplicateChild !== undefined && (
                <span className="menu-shortcut">Duplicate child names</span>
              )}
            </button>
          )}
          {menuUnflattenAction !== undefined && (
            <div className="grid-menu-separator" role="separator" />
          )}
          {menuUnflattenAction !== undefined && (
            <button
              type="button"
              role="menuitem"
              onClick={() => unflattenPath(menuUnflattenAction.path)}
            >
              {formatUnflattenActionLabel(menuUnflattenAction)}
            </button>
          )}
          {menuUnflattenAction !== undefined && (
            <div className="grid-menu-separator" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            disabled={visibleColumnStates.length === 1}
            onClick={() => {
              setColumnStates((current) =>
                current.filter((column) => column.key !== menuColumn.key),
              );
              setHeaderMenu(null);
            }}
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
          aria-label="Cell actions"
          style={{ left: gridMenu.left, top: gridMenu.top }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const address = { column: gridMenu.column, row: gridMenu.row };
              setSelection(selectCell(selection, address, false, false));
              setPeek({ address, bounds: gridMenu.bounds });
              setGridMenu(null);
              gridRef.current?.focus();
            }}
          >
            Peek
            <span className="menu-shortcut">Space</span>
          </button>
          {pathActionsAvailable && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  openFilterForCell(
                    gridMenu.fieldPath,
                    gridMenu.row,
                    gridMenu.bounds,
                  );
                  setGridMenu(null);
                }}
              >
                Filter by this value…
              </button>
              <div className="grid-menu-separator" role="separator" />
            </>
          )}
          {selectedExport !== null && (
            <button
              type="button"
              role="menuitem"
              disabled={!exportEnabled || !pathActionsAvailable || exportBusy}
              onClick={() => void startExport("selection")}
            >
              <span>
                {!exportEnabled || !pathActionsAvailable
                  ? exportUnavailableLabel
                  : exportBusy
                    ? runningExportLabel
                    : `Export selection (${formatCount(selectedExport.rowCount)} × ${formatCount(selectedExport.columnCount)})…`}
              </span>
              {exportEnabled && pathActionsAvailable && !exportBusy && (
                <span className="menu-shortcut">{shortcutModifier}Shift+E</span>
              )}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={!exportEnabled || !pathActionsAvailable || exportBusy}
            onClick={() => void startExport("view")}
          >
            <span>
              {!exportEnabled || !pathActionsAvailable
                ? exportUnavailableLabel
                : exportBusy
                  ? runningExportLabel
                  : `Export current view (${formatCount(gridRowCount)} rows)…`}
            </span>
            {exportEnabled &&
              pathActionsAvailable &&
              !exportBusy &&
              selectedExport === null && (
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

function throwIfCopyAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Copy was cancelled.", "AbortError");
  }
}

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

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isNestedDataType(dataType: DataType): boolean {
  if (dataType.typeId === Type.Dictionary) {
    return isNestedDataType(dataType.dictionary);
  }
  const type = dataType;
  return (
    type.typeId === Type.List ||
    type.typeId === Type.LargeList ||
    type.typeId === Type.FixedSizeList ||
    type.typeId === Type.ListView ||
    type.typeId === Type.LargeListView ||
    type.typeId === Type.Struct ||
    type.typeId === Type.Map
  );
}

function isStreamingRawCopyType(dataType: DataType): boolean {
  if (dataType.typeId === Type.Dictionary) {
    return isStreamingRawCopyType(dataType.dictionary);
  }
  return (
    dataType.typeId === Type.Utf8 ||
    dataType.typeId === Type.LargeUtf8 ||
    dataType.typeId === Type.Binary ||
    dataType.typeId === Type.LargeBinary ||
    dataType.typeId === Type.FixedSizeBinary ||
    dataType.typeId === Type.Utf8View ||
    dataType.typeId === Type.BinaryView
  );
}

function duplicateTopLevelNames(
  schema: readonly SchemaField[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const field of schema) {
    if (seen.has(field.name)) duplicates.add(field.name);
    else seen.add(field.name);
  }
  return duplicates;
}

function sourceColumnKey(
  schema: readonly SchemaField[],
  duplicateNames: ReadonlySet<string>,
  sourceIndex: number,
): string {
  const name = schema[sourceIndex]?.name;
  return name !== undefined && duplicateNames.has(name)
    ? `source:${sourceIndex}`
    : fieldPathKey(name === undefined ? [] : [name]);
}

function sourceColumnState(
  schema: readonly SchemaField[],
  duplicateNames: ReadonlySet<string>,
  field: SchemaField,
  sourceIndex: number,
  pinned: boolean,
  remembered?: ColumnState,
): ColumnState {
  const fieldPath = [field.name];
  return {
    key: sourceColumnKey(schema, duplicateNames, sourceIndex),
    sourceIndex,
    fieldPath,
    field,
    title: formatFieldPath(fieldPath),
    width:
      remembered?.width ??
      Math.min(280, Math.max(MIN_COLUMN_WIDTH, field.name.length * 8 + 48)),
    pinned: remembered?.pinned ?? pinned,
  };
}

function projectedColumnState(
  schema: readonly SchemaField[],
  schemaPathIndex: ReadonlyMap<string, SchemaPathEntry>,
  duplicateNames: ReadonlySet<string>,
  fieldPath: FieldPath,
  pinned: boolean,
  memory: ReadonlyMap<string, ColumnState>,
  inherited?: ColumnState,
): ColumnState | undefined {
  const entry = schemaPathIndex.get(fieldPathKey(fieldPath));
  if (entry === undefined) return undefined;
  const { field, sourceIndex } = entry;
  const key =
    fieldPath.length === 1
      ? sourceColumnKey(schema, duplicateNames, sourceIndex)
      : fieldPathKey(fieldPath);
  const remembered = memory.get(key);
  const title = formatFieldPath(fieldPath);
  return {
    key,
    sourceIndex,
    fieldPath,
    field,
    title,
    width:
      remembered?.width ??
      inherited?.width ??
      Math.min(280, Math.max(MIN_COLUMN_WIDTH, title.length * 8 + 48)),
    pinned: remembered?.pinned ?? inherited?.pinned ?? pinned,
  };
}

function addressableLeafPaths(
  field: SchemaField,
  fieldPath: FieldPath,
): FieldPath[] {
  if (!isStructField(field) || duplicateChildName(field) !== undefined) {
    return [fieldPath];
  }
  return field.children.flatMap((child) => {
    const childPath = [...fieldPath, child.name];
    return isStructField(child)
      ? addressableLeafPaths(child, childPath)
      : [childPath];
  });
}

function replaceProjectedSubtree(
  current: readonly ColumnState[],
  schema: readonly SchemaField[],
  schemaPathIndex: ReadonlyMap<string, SchemaPathEntry>,
  duplicateNames: ReadonlySet<string>,
  fieldPath: FieldPath,
  targetPaths: readonly FieldPath[],
  defaultPinnedSourceIndices: ReadonlySet<number>,
  memory: ReadonlyMap<string, ColumnState>,
): ColumnState[] {
  const replaced: ColumnState[] = [];
  const retained: ColumnState[] = [];
  for (const column of current) {
    if (
      fieldPathStartsWith(column.fieldPath, fieldPath) ||
      fieldPathStartsWith(fieldPath, column.fieldPath)
    ) {
      replaced.push(column);
    } else {
      retained.push(column);
    }
  }
  const inherited = replaced.find((column) =>
    fieldPathStartsWith(fieldPath, column.fieldPath),
  );
  const added = targetPaths.flatMap((path) => {
    const sourceIndex = schemaPathIndex.get(fieldPathKey(path))?.sourceIndex;
    const state = projectedColumnState(
      schema,
      schemaPathIndex,
      duplicateNames,
      path,
      sourceIndex !== undefined && defaultPinnedSourceIndices.has(sourceIndex),
      memory,
      inherited,
    );
    return state === undefined ? [] : [state];
  });
  return [...retained, ...added].sort((left, right) => {
    const rank =
      (schemaPathIndex.get(fieldPathKey(left.fieldPath))?.rank ??
        Number.MAX_SAFE_INTEGER) -
      (schemaPathIndex.get(fieldPathKey(right.fieldPath))?.rank ??
        Number.MAX_SAFE_INTEGER);
    return rank === 0 ? left.sourceIndex - right.sourceIndex : rank;
  });
}

function indexSchemaPaths(
  schema: readonly SchemaField[],
): ReadonlyMap<string, SchemaPathEntry> {
  const entries = new Map<string, SchemaPathEntry>();
  const duplicateKeys = new Set<string>();
  let rank = 0;
  const visit = (
    field: SchemaField,
    fieldPath: FieldPath,
    sourceIndex: number,
  ) => {
    const key = fieldPathKey(fieldPath);
    if (entries.has(key)) {
      entries.delete(key);
      duplicateKeys.add(key);
    } else if (!duplicateKeys.has(key)) {
      entries.set(key, { field, sourceIndex, rank });
    }
    rank += 1;
    if (!isStructField(field)) return;
    for (const child of field.children) {
      visit(child, [...fieldPath, child.name], sourceIndex);
    }
  };
  schema.forEach((field, sourceIndex) =>
    visit(field, [field.name], sourceIndex),
  );
  return entries;
}

interface ProjectionPickerColumn extends ColumnPickerColumn {
  fieldPath: FieldPath;
  sourceIndex: number;
}

function projectionPickerColumns(
  schema: readonly SchemaField[],
  projection: readonly ColumnState[],
  pathActionsAvailable: boolean,
): ProjectionPickerColumn[] {
  if (!pathActionsAvailable) {
    const projectedByKey = new Map(
      projection.map((column) => [column.key, column]),
    );
    const duplicateNames = duplicateTopLevelNames(schema);
    return schema.map((field, sourceIndex) => {
      const id = sourceColumnKey(schema, duplicateNames, sourceIndex);
      const projected = projectedByKey.get(id);
      return {
        id,
        fieldPath: [field.name],
        sourceIndex,
        name: field.name,
        type: field.logicalType ?? field.physicalType,
        depth: 0,
        selection: projected === undefined ? "none" : "all",
        exact: projected !== undefined,
        pinned: projected?.pinned ?? false,
        ancestorIds: [],
      };
    });
  }

  const projectedByKey = new Map(
    projection.map((column) => [column.key, column]),
  );
  const rowIdCounts = new Map<string, number>();
  const rows: ProjectionPickerColumn[] = [];
  const visit = (
    field: SchemaField,
    fieldPath: FieldPath,
    sourceIndex: number,
    depth: number,
    ancestorIds: readonly string[],
    disabledReason?: string,
  ): "none" | "partial" | "all" => {
    const pathKey = fieldPathKey(fieldPath);
    const occurrence = rowIdCounts.get(pathKey) ?? 0;
    rowIdCounts.set(pathKey, occurrence + 1);
    const id =
      occurrence === 0 ? pathKey : `${pathKey}:duplicate:${occurrence}`;
    const projected =
      disabledReason === undefined ? projectedByKey.get(pathKey) : undefined;
    const nameParts = fieldPathTitleParts(fieldPath);
    const rowIndex = rows.length;
    const row: ProjectionPickerColumn = {
      id,
      fieldPath,
      sourceIndex,
      name: formatFieldPath(fieldPath),
      ...(nameParts.titlePrefix === undefined
        ? {}
        : {
            namePrefix: nameParts.titlePrefix,
            nameLeaf: nameParts.titleLeaf,
          }),
      type: field.logicalType ?? field.physicalType,
      depth,
      selection: projected === undefined ? "none" : "all",
      exact: projected !== undefined,
      pinned: projected?.pinned ?? false,
      ancestorIds,
      ...(disabledReason === undefined ? {} : { disabledReason }),
    };
    rows.push(row);

    const childStates: Array<"none" | "partial" | "all"> = [];
    if (field.children.length > 0) {
      const duplicateNames = duplicateFieldNames(field.children);
      for (const child of field.children) {
        const childReason =
          disabledReason ??
          (isListOrMapField(field)
            ? LIST_MAP_COLUMN_REASON
            : duplicateNames.has(child.name)
              ? `This field is unavailable because ${formatFieldPath(fieldPath)} contains duplicate child names.`
              : undefined);
        const childState = visit(
          child,
          [...fieldPath, child.name],
          sourceIndex,
          depth + 1,
          [...ancestorIds, id],
          childReason,
        );
        if (childReason === undefined) childStates.push(childState);
      }
    }
    if (projected !== undefined && isStructField(field)) {
      row.selection = "partial";
    } else if (childStates.length > 0) {
      row.selection = childStates.every((state) => state === "all")
        ? "all"
        : childStates.some((state) => state !== "none")
          ? "partial"
          : "none";
    }
    rows[rowIndex] = row;
    return row.selection;
  };

  schema.forEach((field, sourceIndex) =>
    visit(field, [field.name], sourceIndex, 0, []),
  );
  return rows;
}

function projectedStructPathKeys(
  projection: readonly ColumnState[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const column of projection) {
    for (let length = 1; length < column.fieldPath.length; length += 1) {
      keys.add(fieldPathKey(column.fieldPath.slice(0, length)));
    }
  }
  return keys;
}

function duplicateFieldNames(
  fields: readonly SchemaField[],
): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) duplicates.add(field.name);
    else seen.add(field.name);
  }
  return duplicates;
}

function isListOrMapField(field: SchemaField): boolean {
  return (
    field.logicalType?.startsWith("List") === true ||
    field.logicalType?.startsWith("Map") === true
  );
}

function isStructField(field: SchemaField): boolean {
  return (
    field.physicalType === "GROUP" &&
    !field.logicalType?.startsWith("List") &&
    !field.logicalType?.startsWith("Map") &&
    field.children.length > 0
  );
}

function duplicateChildName(field: SchemaField): string | undefined {
  const names = new Set<string>();
  for (const child of field.children) {
    if (names.has(child.name)) return child.name;
    names.add(child.name);
  }
  return undefined;
}

const NOTICE_PATH_LIMIT = 3;
const NOTICE_PATH_CHARACTER_LIMIT = 56;

function formatUnflattenActionLabel({ path }: { path: FieldPath }): string {
  return `Unflatten ${formatFieldPath(path)}`;
}

function formatDroppedPathNotice(
  filterPaths: readonly FieldPath[],
  sortPaths: readonly FieldPath[],
): string {
  const category = (label: string, paths: readonly FieldPath[]) => {
    const unique = new Map(paths.map((path) => [fieldPathKey(path), path]));
    const visible = [...unique.values()]
      .slice(0, NOTICE_PATH_LIMIT)
      .map(boundedNoticePath);
    const remaining = unique.size - visible.length;
    return `${label}: ${visible.join(", ")}${remaining > 0 ? `, +${remaining.toLocaleString("en-US")} more` : ""}`;
  };
  return [
    ...(filterPaths.length === 0 ? [] : [category("filters", filterPaths)]),
    ...(sortPaths.length === 0 ? [] : [category("sorts", sortPaths)]),
  ].join("; ");
}

function boundedNoticePath(path: FieldPath): string {
  const characters = Array.from(formatFieldPath(path));
  if (characters.length <= NOTICE_PATH_CHARACTER_LIMIT) {
    return characters.join("");
  }
  const prefixLength = Math.floor((NOTICE_PATH_CHARACTER_LIMIT - 1) / 2);
  const suffixLength = NOTICE_PATH_CHARACTER_LIMIT - prefixLength - 1;
  return `${characters.slice(0, prefixLength).join("")}…${characters.slice(-suffixLength).join("")}`;
}

function flattenedRailMetadata(
  columns: readonly ColumnState[],
  schema: readonly SchemaField[],
  logicalDataTypes: ReadonlyMap<string, DataType>,
): ReadonlyMap<string, NonNullable<GridColumn["groupRail"]>> {
  const groupsByRoot = new Map<
    string,
    {
      key: string;
      title: string;
    }
  >();
  for (const column of columns) {
    if (column.fieldPath.length < 2) continue;
    const rootName = column.fieldPath[0]!;
    if (groupsByRoot.has(rootName)) continue;
    const field = schema[column.sourceIndex];
    if (field === undefined) continue;
    const key = fieldPathKey([rootName]);
    const logicalType = logicalDataTypes.get(key);
    groupsByRoot.set(rootName, {
      key,
      title: `${formatFieldPath([rootName])} · ${
        logicalType === undefined
          ? schemaRailType(field)
          : formatDataTypeLabel(logicalType)
      }`,
    });
  }
  const groupByColumn = columns.map((column) => {
    if (column.fieldPath.length < 2) return undefined;
    return groupsByRoot.get(column.fieldPath[0]!);
  });
  const metadata = new Map<string, NonNullable<GridColumn["groupRail"]>>();
  columns.forEach((column, index) => {
    const group = groupByColumn[index];
    if (group === undefined) return;
    metadata.set(column.key, {
      title: group.title,
      start: groupByColumn[index - 1]?.key !== group.key,
      end: groupByColumn[index + 1]?.key !== group.key,
    });
  });
  return metadata;
}

function fieldPathTitleParts(fieldPath: FieldPath): {
  titlePrefix?: string;
  titleLeaf?: string;
} {
  const prefix = fieldPath.slice(0, -1);
  return prefix.length === 0
    ? {}
    : {
        titlePrefix: `${prefix.map(formatFieldPathSegment).join(".")}.`,
        titleLeaf: formatFieldPathSegment(fieldPath.at(-1)!),
      };
}

function schemaRailType(field: SchemaField | undefined): string {
  if (field === undefined) return "struct<…>";
  return isStructField(field)
    ? "struct<…>"
    : (field.logicalType ?? field.physicalType);
}

function gridAnchorIsMounted(
  fieldPath: FieldPath,
  row: number | undefined,
  visibleColumns: readonly ColumnState[],
  viewport: GridViewport,
  columnKey?: string,
): boolean {
  const visibleIndex =
    columnKey === undefined
      ? visibleColumnIndex(fieldPath, visibleColumns)
      : visibleColumnKeyIndex(columnKey, visibleColumns);
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

function visibleColumnKeyIndex(
  columnKey: string,
  visibleColumns: readonly ColumnState[],
): number {
  return visibleColumns.findIndex((column) => column.key === columnKey);
}

function visibleColumnIndex(
  fieldPath: readonly string[],
  visibleColumns: readonly ColumnState[],
): number {
  return visibleColumns.findIndex((column) =>
    sameFieldPath(column.fieldPath, fieldPath),
  );
}

function sameColumnOrder(
  previous: readonly FieldPath[],
  current: readonly FieldPath[],
): boolean {
  return previous.every((fieldPath, index) => {
    const next = current[index];
    return next !== undefined && sameFieldPath(fieldPath, next);
  });
}

function sameColumnSet(
  previous: readonly FieldPath[],
  current: readonly FieldPath[],
): boolean {
  return (
    previous.length === current.length && projectionContains(previous, current)
  );
}

function projectionFingerprint(fieldPaths: readonly FieldPath[]): string {
  let hash = 0x811c9dc5;
  for (const fieldPath of fieldPaths) {
    for (const character of fieldPathKey(fieldPath)) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 0x01000193) >>> 0;
    }
  }
  return `${fieldPaths.length}:${hash.toString(16).padStart(8, "0")}`;
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
      return error.detail?.member === undefined
        ? "The open file changed before this window finished loading."
        : `Dataset member ${error.detail.member} changed. Reload the dataset.`;
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
    if (error.code === "invalidMember") {
      return error.detail?.member === undefined
        ? "A dataset member is damaged or unsupported. Reload the dataset."
        : `Dataset member ${error.detail.member} is damaged or unsupported. Reload the dataset.`;
    }
    if (error.code === "memberPermissionDenied") {
      return error.detail?.member === undefined
        ? "Fix the dataset member's permissions, then reload the dataset."
        : `Fix permissions for dataset member ${error.detail.member}, then reload the dataset.`;
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
    error instanceof DataWindowCommandError &&
    (error.code === "sourceChanged" ||
      error.code === "invalidMember" ||
      error.code === "memberPermissionDenied")
  ) {
    return { message, recovery: "reloadDataset" };
  }
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
  maxWidth: number,
): { left: number; top: number } {
  const popupWidth = Math.min(
    maxWidth,
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
