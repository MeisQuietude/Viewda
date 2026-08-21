import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  getStructureColumns,
  getStructureRowGroups,
  type StructureByteUnit,
  type StructureColumnSort,
  type StructureColumnSummary,
  type StructureRowGroupSort,
  type StructureRowGroupSummary,
  type StructureSortDirection,
} from "../desktop";
import type { GridMeasurementPort } from "../data-grid/ViewdaGrid";
import {
  bytesForUnit,
  formatColumnType,
  formatEncodings,
  formatFileSize,
  formatNumber,
  formatRatio,
  formatShare,
  MISSING_FACT,
  unitLabel,
} from "./format";
import {
  StructureGrid,
  type StructureGridCell,
  type StructureGridColumn,
} from "./StructureGrid";
import { pageCovers, pageRequestFor } from "./table-page";
import { structureErrorMessage } from "./use-structure-summary";

interface HeldPage<Row> {
  offset: number;
  totalCount: number;
  rows: readonly Row[];
}

interface TableState<Row> {
  page: HeldPage<Row> | null;
  error: string | null;
  revision: number;
}

const ROW_GROUP_COLUMNS: readonly StructureGridColumn[] = [
  {
    id: "index",
    title: "Row group",
    width: 140,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "rows",
    title: "Rows",
    width: 200,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "bytes",
    title: "Bytes",
    width: 220,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "ratio",
    title: "Ratio",
    width: 160,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "bloom",
    title: "Bloom filters",
    width: 332,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
];

const COLUMN_COLUMNS: readonly StructureGridColumn[] = [
  {
    id: "name",
    title: "Column",
    width: 260,
    alignment: "left",
    monospace: false,
    sortable: true,
  },
  {
    id: "type",
    title: "Type",
    width: 190,
    alignment: "left",
    monospace: true,
    sortable: false,
  },
  {
    id: "bytes",
    title: "Bytes",
    width: 140,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "ratio",
    title: "Ratio",
    width: 100,
    alignment: "right",
    monospace: true,
    sortable: true,
  },
  {
    id: "encodings",
    title: "Encodings",
    width: 245,
    alignment: "left",
    monospace: true,
    sortable: false,
  },
  {
    id: "cumulative",
    title: "Cumulative",
    width: 117,
    alignment: "right",
    monospace: true,
    sortable: false,
  },
];

const ROW_GROUP_SORT_KEYS: Record<string, StructureRowGroupSort> = {
  index: "index",
  rows: "rowCount",
  bytes: "bytes",
  ratio: "compressionRatio",
  bloom: "bloomFilters",
};

const COLUMN_SORT_KEYS: Record<string, StructureColumnSort> = {
  name: "name",
  bytes: "bytes",
  ratio: "compressionRatio",
};

export function RowGroupTable({
  generation,
  unit,
  rowGroupCount,
  requestedRow,
  measurementPort,
}: {
  generation: number;
  unit: StructureByteUnit;
  rowGroupCount: number;
  requestedRow?: { row: number; request: number } | null;
  measurementPort?: GridMeasurementPort;
}) {
  const [sortColumnId, setSortColumnId] = useState("index");
  const [direction, setDirection] =
    useState<StructureSortDirection>("ascending");
  useEffect(() => {
    if (requestedRow !== null && requestedRow !== undefined) {
      setSortColumnId("index");
      setDirection("ascending");
    }
  }, [requestedRow]);
  const { state, requestViewport } = useStructurePage<StructureRowGroupSummary>(
    rowGroupCount,
    useCallback(
      (offset, limit) =>
        getStructureRowGroups(
          generation,
          unit,
          ROW_GROUP_SORT_KEYS[sortColumnId] ?? "index",
          direction,
          offset,
          limit,
        ).then((page) => ({
          offset: page.offset,
          totalCount: page.totalCount,
          rows: page.rowGroups,
        })),
      [direction, generation, sortColumnId, unit],
    ),
  );

  const getCell = useCallback(
    (row: number, columnId: string): StructureGridCell | null => {
      const group = rowAt(state.page, row);
      if (group === null) {
        return null;
      }
      const faded = !group.isReadable;
      if (!group.hasLayoutFacts && columnId !== "index") {
        return { text: MISSING_FACT, faded };
      }
      switch (columnId) {
        case "index":
          return { text: formatNumber(group.index), faded };
        case "rows":
          return { text: formatNumber(group.rowCount), faded };
        case "bytes":
          return { text: formatFileSize(bytesForUnit(group, unit)), faded };
        case "ratio":
          return { text: formatRatio(group.compressionRatio), faded };
        case "bloom":
          return {
            text: `${formatNumber(group.chunksWithBloomFilter)} of ${formatNumber(group.chunkCount)}`,
            faded,
          };
        default:
          return { text: "", faded };
      }
    },
    [state.page, unit],
  );

  return (
    <StructureTableCard
      title="Row groups"
      caption={`${unitLabel(unit)} bytes`}
      error={state.error}
    >
      <StructureGrid
        label="Row groups"
        columns={ROW_GROUP_COLUMNS}
        rowCount={state.page?.totalCount ?? rowGroupCount}
        sortColumnId={sortColumnId}
        sortDirection={direction}
        contentRevision={state.revision}
        heldPage={heldPageRange(state.page)}
        getCell={getCell}
        measurementPort={measurementPort}
        requestedRow={requestedRow}
        onSort={(columnId) =>
          applySort(columnId, sortColumnId, setSortColumnId, setDirection)
        }
        onViewportChange={requestViewport}
      />
    </StructureTableCard>
  );
}

export function ColumnsSection({
  generation,
  unit,
  columnCount,
  ready = true,
  schema,
  pinnedColumn,
  onClearPinnedColumn,
  measurementPort,
}: {
  generation: number;
  unit: StructureByteUnit;
  columnCount: number;
  ready?: boolean;
  schema: ReactNode;
  pinnedColumn: string | null;
  onClearPinnedColumn: () => void;
  measurementPort?: GridMeasurementPort;
}) {
  const [view, setView] = useState<"size" | "schema">("size");
  const [sortColumnId, setSortColumnId] = useState("bytes");
  const [direction, setDirection] =
    useState<StructureSortDirection>("descending");
  const headingId = useId();
  const panelId = useId();
  const sizeTab = useRef<HTMLButtonElement>(null);
  const schemaTab = useRef<HTMLButtonElement>(null);
  const { state, requestViewport } = useStructurePage<StructureColumnSummary>(
    columnCount,
    useCallback(
      (offset, limit) =>
        getStructureColumns(
          generation,
          unit,
          COLUMN_SORT_KEYS[sortColumnId] ?? "bytes",
          direction,
          offset,
          limit,
        ).then((page) => ({
          offset: page.offset,
          totalCount: page.totalCount,
          rows: page.columns,
        })),
      [direction, generation, sortColumnId, unit],
    ),
  );

  const getCell = useCallback(
    (row: number, columnId: string): StructureGridCell | null => {
      const column = rowAt(state.page, row);
      if (column === null) {
        return null;
      }
      switch (columnId) {
        case "name":
          return { text: column.name, faded: false };
        case "type":
          return {
            text: formatColumnType(column.physicalType, column.logicalType),
            faded: false,
          };
        case "bytes":
          return {
            text: formatFileSize(bytesForUnit(column, unit)),
            faded: false,
          };
        case "ratio":
          return { text: formatRatio(column.compressionRatio), faded: false };
        case "encodings":
          return { text: formatEncodings(column.encodings), faded: false };
        case "cumulative":
          return { text: formatShare(column.cumulativeShare), faded: false };
        default:
          return { text: "", faded: false };
      }
    },
    [state.page, unit],
  );

  const chooseView = (next: "size" | "schema", focus = false) => {
    setView(next);
    if (focus) {
      (next === "size" ? sizeTab : schemaTab).current?.focus();
    }
  };
  const handleTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      chooseView(view === "size" ? "schema" : "size", true);
    } else if (event.key === "Home") {
      event.preventDefault();
      chooseView("size", true);
    } else if (event.key === "End") {
      event.preventDefault();
      chooseView("schema", true);
    }
  };

  return (
    <section
      className="structure-card columns-card"
      aria-labelledby={headingId}
    >
      <div className="structure-card-heading columns-heading">
        <div>
          <h2 id={headingId}>Columns</h2>
          <span className="structure-card-caption">
            {view === "size"
              ? `Compare columns by ${unitLabel(unit).toLowerCase()} bytes. Cumulative is the share accounted for by this column and all larger columns.`
              : "Nested Parquet schema outline"}
          </span>
        </div>
        <div className="columns-tabs" role="tablist" aria-label="Columns view">
          <button
            ref={sizeTab}
            id={`${panelId}-size-tab`}
            type="button"
            role="tab"
            aria-selected={view === "size"}
            aria-controls={panelId}
            tabIndex={view === "size" ? 0 : -1}
            onClick={() => chooseView("size")}
            onKeyDown={handleTabKey}
          >
            By size
          </button>
          <button
            ref={schemaTab}
            id={`${panelId}-schema-tab`}
            type="button"
            role="tab"
            aria-selected={view === "schema"}
            aria-controls={panelId}
            tabIndex={view === "schema" ? 0 : -1}
            onClick={() => chooseView("schema")}
            onKeyDown={handleTabKey}
          >
            Schema
          </button>
        </div>
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={`${panelId}-${view}-tab`}
      >
        {view === "size" ? (
          !ready ? (
            <p className="structure-status">Reading column sizes…</p>
          ) : state.error !== null ? (
            <p className="structure-status-error" role="alert">
              {state.error}
            </p>
          ) : (
            <StructureGrid
              label="Columns by size"
              columns={COLUMN_COLUMNS}
              rowCount={state.page?.totalCount ?? columnCount}
              sortColumnId={sortColumnId}
              sortDirection={direction}
              contentRevision={state.revision}
              heldPage={heldPageRange(state.page)}
              getCell={getCell}
              measurementPort={measurementPort}
              onSort={(columnId) =>
                applySort(columnId, sortColumnId, setSortColumnId, setDirection)
              }
              onViewportChange={requestViewport}
            />
          )
        ) : (
          <div className="columns-schema-view">
            <div className="columns-schema-guidance">
              <p>Select a leaf to pin it in Physical layout.</p>
              {pinnedColumn !== null && (
                <div role="status">
                  <span>Pinned in layout: {pinnedColumn}</span>
                  <button type="button" onClick={onClearPinnedColumn}>
                    Clear
                  </button>
                </div>
              )}
            </div>
            {schema}
          </div>
        )}
      </div>
    </section>
  );
}

function StructureTableCard({
  title,
  caption,
  error,
  children,
}: {
  title: string;
  caption: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <section className="structure-card structure-table-card">
      <div className="structure-card-heading">
        <h2>{title}</h2>
        <span className="structure-card-caption">{caption}</span>
      </div>
      {error === null ? (
        children
      ) : (
        <p className="structure-status-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/**
 * Holds one bounded page of a Structure table.
 *
 * The page is refetched when the viewport leaves it and discarded when the
 * ordering changes, because the same row index then names a different row.
 */
function useStructurePage<Row>(
  totalCount: number,
  fetchPage: (offset: number, limit: number) => Promise<HeldPage<Row>>,
): {
  state: TableState<Row>;
  requestViewport: (rowStart: number, rowCount: number) => void;
} {
  const [state, setState] = useState<TableState<Row>>({
    page: null,
    error: null,
    revision: 0,
  });
  const pageRef = useRef<HeldPage<Row> | null>(null);
  const viewportRef = useRef({ rowStart: 0, rowCount: 1 });
  const activeRef = useRef<string | null>(null);
  const requestVersionRef = useRef(0);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(
    (rowStart: number, rowCount: number) => {
      const request = pageRequestFor(
        rowStart,
        rowCount,
        pageRef.current?.totalCount ?? totalCount,
      );
      if (request === null) {
        return;
      }
      const key = `${request.offset}:${request.limit}`;
      if (activeRef.current === key) {
        return;
      }
      activeRef.current = key;
      const version = requestVersionRef.current + 1;
      requestVersionRef.current = version;
      void fetchPage(request.offset, request.limit).then(
        (page) => {
          if (
            !aliveRef.current ||
            activeRef.current !== key ||
            requestVersionRef.current !== version
          ) {
            return;
          }
          activeRef.current = null;
          pageRef.current = page;
          setState((current) => ({
            page,
            error: null,
            revision: current.revision + 1,
          }));
        },
        (error: unknown) => {
          if (
            !aliveRef.current ||
            activeRef.current !== key ||
            requestVersionRef.current !== version
          ) {
            return;
          }
          activeRef.current = null;
          setState((current) => ({
            ...current,
            error: structureErrorMessage(error),
          }));
        },
      );
    },
    [fetchPage, totalCount],
  );

  // The grid publishes its first viewport before this effect runs, so the first
  // page is already on its way; only a later ordering change invalidates it.
  const orderingRef = useRef(load);
  useEffect(() => {
    if (orderingRef.current === load) {
      return;
    }
    orderingRef.current = load;
    requestVersionRef.current += 1;
    activeRef.current = null;
    pageRef.current = null;
    setState((current) => ({ ...current, page: null, error: null }));
    const { rowStart, rowCount } = viewportRef.current;
    load(rowStart, rowCount);
  }, [load]);

  const requestViewport = useCallback(
    (rowStart: number, rowCount: number) => {
      const rows = Math.max(rowCount, 1);
      viewportRef.current = { rowStart, rowCount: rows };
      const page = pageRef.current;
      const covered =
        page !== null &&
        pageCovers(
          {
            offset: page.offset,
            length: page.rows.length,
            totalCount: page.totalCount,
          },
          rowStart,
          rows,
        );
      if (!covered) {
        load(rowStart, rows);
      }
    },
    [load],
  );

  return { state, requestViewport };
}

function rowAt<Row>(page: HeldPage<Row> | null, row: number): Row | null {
  if (page === null) {
    return null;
  }
  return page.rows[row - page.offset] ?? null;
}

function heldPageRange<Row>(
  page: HeldPage<Row> | null,
): { offset: number; length: number } | null {
  return page === null
    ? null
    : { offset: page.offset, length: page.rows.length };
}

/** Columns whose first click reads better small-to-large. */
const ASCENDING_FIRST = new Set(["index", "name"]);

function applySort(
  columnId: string,
  currentColumnId: string,
  setColumnId: (id: string) => void,
  setDirection: (
    update: (current: StructureSortDirection) => StructureSortDirection,
  ) => void,
) {
  if (columnId === currentColumnId) {
    setDirection((current) =>
      current === "ascending" ? "descending" : "ascending",
    );
    return;
  }
  setColumnId(columnId);
  setDirection(() =>
    ASCENDING_FIRST.has(columnId) ? "ascending" : "descending",
  );
}
