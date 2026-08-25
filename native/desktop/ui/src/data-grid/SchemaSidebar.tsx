import { useEffect, useMemo, useRef, useState } from "react";
import {
  DateUnit,
  IntervalUnit,
  Precision,
  TimeUnit,
  Type,
  type DataType,
  type Field,
} from "@uwdata/flechette";

import {
  cancelColumnStatistics,
  ColumnStatisticsCommandError,
  getColumnStatistics,
  type ColumnStatistics,
  type SourceSummary,
} from "../desktop";
import { SchemaTreeNode } from "../SchemaTree";

const LOGICAL_SCHEMA_NODE_LIMIT = 2_048;
const LOGICAL_SCHEMA_DEPTH_LIMIT = 64;
const LOGICAL_SCHEMA_TEXT_LIMIT = 160;

type StatisticsState =
  | { kind: "idle" }
  | {
      kind: "loading";
      columnIndex: number;
      columnName: string;
      previous: ColumnStatistics | null;
    }
  | {
      kind: "ready";
      columnIndex: number;
      columnName: string;
      value: ColumnStatistics;
    }
  | { kind: "cancelled"; columnName: string }
  | { kind: "error"; columnName: string; message: string };

export function SchemaSidebar({
  open,
  selectedColumn,
  source,
  dataTypes = new Map(),
  onSelectColumn,
}: {
  open: boolean;
  selectedColumn: number | null;
  source: SourceSummary;
  dataTypes?: ReadonlyMap<number, DataType>;
  onSelectColumn: (columnIndex: number) => void;
}) {
  const [statistics, setStatistics] = useState<StatisticsState>({
    kind: "idle",
  });
  const requestVersion = useRef(0);

  useEffect(
    () => () => {
      requestVersion.current += 1;
      void cancelColumnStatistics(source.generation).catch(() => {
        // The source is already leaving the UI, so cancellation is best-effort here.
      });
    },
    [source.generation],
  );

  const loadStatistics = async (
    columnIndex: number,
    includeMinMax: boolean,
    previous: ColumnStatistics | null,
  ) => {
    const field = source.schema[columnIndex];
    if (field === undefined) {
      return;
    }
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    onSelectColumn(columnIndex);
    setStatistics({
      kind: "loading",
      columnIndex,
      columnName: field.name,
      previous,
    });

    try {
      const value = await getColumnStatistics(
        source.generation,
        columnIndex,
        includeMinMax,
      );
      if (requestVersion.current === version) {
        setStatistics({
          kind: "ready",
          columnIndex,
          columnName: field.name,
          value,
        });
      }
    } catch (error) {
      if (requestVersion.current !== version) {
        return;
      }
      if (
        error instanceof ColumnStatisticsCommandError &&
        error.code === "cancelled"
      ) {
        setStatistics({ kind: "cancelled", columnName: field.name });
      } else {
        setStatistics({
          kind: "error",
          columnName: field.name,
          message: statisticsErrorMessage(error),
        });
      }
    }
  };

  const selectColumn = (columnIndex: number) => {
    const field = source.schema[columnIndex];
    if (field !== undefined) {
      void loadStatistics(columnIndex, !shouldDeferMinMax(field), null);
    }
  };

  const computeMinMax = () => {
    if (statistics.kind === "ready") {
      void loadStatistics(statistics.columnIndex, true, statistics.value);
    }
  };

  const cancelStatistics = async () => {
    if (statistics.kind !== "loading") {
      return;
    }
    const columnName = statistics.columnName;
    const columnIndex = statistics.columnIndex;
    const previous = statistics.previous;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setStatistics(
      previous === null
        ? { kind: "cancelled", columnName }
        : { kind: "ready", columnIndex, columnName, value: previous },
    );
    try {
      await cancelColumnStatistics(source.generation);
    } catch {
      if (requestVersion.current === version) {
        setStatistics({
          kind: "error",
          columnName,
          message: "The statistics scan could not be cancelled.",
        });
      }
    }
  };

  return (
    <aside
      id="schema-sidebar"
      className="schema-sidebar"
      aria-label="Schema sidebar"
      hidden={!open}
    >
      {open && (
        <>
          <div className="schema-sidebar-heading">
            <span>{formatColumnCount(source.schema.length)}</span>
          </div>
          <ul className="sidebar-schema-tree">
            {source.schema.map((field, columnIndex) =>
              dataTypes.get(columnIndex) === undefined ? (
                <SchemaTreeNode
                  key={columnIndex}
                  field={field}
                  selected={selectedColumn === columnIndex}
                  onSelect={() => void selectColumn(columnIndex)}
                />
              ) : (
                <LogicalSchemaNode
                  key={columnIndex}
                  name={field.name}
                  dataType={dataTypes.get(columnIndex)!}
                  selected={selectedColumn === columnIndex}
                  onSelect={() => void selectColumn(columnIndex)}
                />
              ),
            )}
            {source.schemaIsTruncated &&
              source.schema.some(
                (_, columnIndex) => !dataTypes.has(columnIndex),
              ) && (
                <li className="logical-schema-incomplete">
                  Schema is incomplete; unloaded fields use the physical view.
                </li>
              )}
          </ul>
          <StatisticsPanel
            state={statistics}
            onCancel={() => void cancelStatistics()}
            onComputeMinMax={computeMinMax}
          />
        </>
      )}
    </aside>
  );
}

function LogicalSchemaNode({
  name,
  dataType,
  selected,
  onSelect,
}: {
  name: string;
  dataType: DataType;
  selected: boolean;
  onSelect: () => void;
}) {
  const projection = useMemo(
    () => _projectLogicalSchema(name, dataType),
    [dataType, name],
  );
  return (
    <li>
      <button
        className="schema-field"
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className="schema-name">{projection.name}</span>
        <span className="schema-type" title={projection.type}>
          {projection.type}
        </span>
      </button>
      {projection.rows.length > 0 && (
        <ul className="logical-schema-rows">
          {projection.rows.map((row, index) => (
            <li
              key={`${index}:${row.name}`}
              className="logical-schema-row"
              style={{ paddingLeft: `${Math.min(row.depth, 8) * 10}px` }}
            >
              <div className="schema-field">
                <span className="schema-name">{row.name}</span>
                <span className="schema-type" title={row.type}>
                  {row.type}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

interface LogicalSchemaProjection {
  name: string;
  type: string;
  rows: Array<{ name: string; type: string; depth: number }>;
}

export function _projectLogicalSchema(
  name: string,
  dataType: DataType,
): LogicalSchemaProjection {
  const rows: LogicalSchemaProjection["rows"] = [];
  const budget = { visited: 0, incomplete: false };
  const stack = logicalChildFields(dataType, 1, budget).reverse();
  while (stack.length > 0 && budget.visited < LOGICAL_SCHEMA_NODE_LIMIT) {
    const current = stack.pop()!;
    budget.visited += 1;
    rows.push({
      name: boundedSchemaText(current.field.name),
      type: shortDataTypeLabel(current.field.type),
      depth: current.depth,
    });
    if (current.depth >= LOGICAL_SCHEMA_DEPTH_LIMIT) {
      if (
        logicalChildFields(current.field.type, current.depth + 1, budget).length
      )
        budget.incomplete = true;
      continue;
    }
    const children = logicalChildFields(
      current.field.type,
      current.depth + 1,
      budget,
    );
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  if (stack.length > 0 || budget.incomplete) {
    rows.push({ name: "…", type: "more fields", depth: 1 });
  }
  return {
    name: boundedSchemaText(name),
    type: shortDataTypeLabel(dataType),
    rows,
  };
}

function logicalChildFields(
  input: DataType,
  depth: number,
  budget: { visited: number; incomplete: boolean },
): Array<{ field: Field; depth: number }> {
  let dataType = input;
  while (budget.visited < LOGICAL_SCHEMA_NODE_LIMIT) {
    budget.visited += 1;
    if (dataType.typeId === Type.Dictionary) {
      dataType = dataType.dictionary;
      continue;
    }
    if (dataType.typeId === Type.Struct) {
      const remaining = Math.max(0, LOGICAL_SCHEMA_NODE_LIMIT - budget.visited);
      if (dataType.children.length > remaining) budget.incomplete = true;
      return dataType.children
        .slice(0, remaining)
        .map((field) => ({ field, depth }));
    }
    if (
      dataType.typeId === Type.List ||
      dataType.typeId === Type.LargeList ||
      dataType.typeId === Type.FixedSizeList ||
      dataType.typeId === Type.ListView ||
      dataType.typeId === Type.LargeListView
    ) {
      const child = dataType.children[0]?.type;
      if (child === undefined) return [];
      dataType = child;
      continue;
    }
    if (dataType.typeId === Type.Map) {
      const entries = dataType.children[0]?.type;
      return entries?.typeId === Type.Struct
        ? entries.children.map((field) => ({ field, depth }))
        : [];
    }
    return [];
  }
  budget.incomplete = true;
  return [];
}

function shortDataTypeLabel(input: DataType): string {
  let dataType = input;
  let dictionaryDepth = 0;
  while (
    dataType.typeId === Type.Dictionary &&
    dictionaryDepth < LOGICAL_SCHEMA_DEPTH_LIMIT
  ) {
    dictionaryDepth += 1;
    dataType = dataType.dictionary;
  }
  switch (dataType.typeId) {
    case Type.Null:
      return "null";
    case Type.Int:
      return `${dataType.signed ? "int" : "uint"}${dataType.bitWidth}`;
    case Type.Float:
      return `float${
        dataType.precision === Precision.HALF
          ? 16
          : dataType.precision === Precision.SINGLE
            ? 32
            : 64
      }`;
    case Type.Binary:
    case Type.LargeBinary:
    case Type.FixedSizeBinary:
    case Type.BinaryView:
      return "binary";
    case Type.Utf8:
    case Type.LargeUtf8:
    case Type.Utf8View:
      return "string";
    case Type.Bool:
      return "boolean";
    case Type.Decimal:
      return `decimal(${dataType.precision}, ${dataType.scale})`;
    case Type.Date:
      return dataType.unit === DateUnit.DAY ? "date32" : "date64";
    case Type.Time:
      return `time[${timeUnitLabel(dataType.unit)}]`;
    case Type.Timestamp: {
      const timezone =
        dataType.timezone === null
          ? ""
          : `, ${boundedSchemaText(dataType.timezone, 48)}`;
      return `timestamp[${timeUnitLabel(dataType.unit)}${timezone}]`;
    }
    case Type.Interval:
      return `interval[${intervalUnitLabel(dataType.unit)}]`;
    case Type.Duration:
      return `duration[${timeUnitLabel(dataType.unit)}]`;
    case Type.Struct:
      return "struct<…>";
    case Type.List:
    case Type.LargeList:
    case Type.FixedSizeList:
    case Type.ListView:
    case Type.LargeListView:
      return `list<${containerChildLabel(dataType.children[0]?.type)}>`;
    case Type.Map: {
      const entries = dataType.children[0]?.type;
      const key =
        entries?.typeId === Type.Struct ? entries.children[0]?.type : undefined;
      const value =
        entries?.typeId === Type.Struct ? entries.children[1]?.type : undefined;
      return `map<${containerChildLabel(key)}, ${containerChildLabel(value)}>`;
    }
    default:
      return "value";
  }
}

function containerChildLabel(dataType: DataType | undefined): string {
  if (dataType === undefined) return "unknown";
  let dictionaryDepth = 0;
  while (
    dataType.typeId === Type.Dictionary &&
    dictionaryDepth < LOGICAL_SCHEMA_DEPTH_LIMIT
  ) {
    dictionaryDepth += 1;
    dataType = dataType.dictionary;
  }
  if (dataType.typeId === Type.Struct) return "struct<…>";
  if (
    dataType.typeId === Type.List ||
    dataType.typeId === Type.LargeList ||
    dataType.typeId === Type.FixedSizeList ||
    dataType.typeId === Type.ListView ||
    dataType.typeId === Type.LargeListView
  )
    return "list<…>";
  if (dataType.typeId === Type.Map) return "map<…>";
  return shortDataTypeLabel(dataType);
}

function boundedSchemaText(
  value: string,
  limit = LOGICAL_SCHEMA_TEXT_LIMIT,
): string {
  let end = 0;
  let count = 0;
  while (end < value.length && count < limit) {
    const codePoint = value.codePointAt(end)!;
    end += codePoint > 0xffff ? 2 : 1;
    count += 1;
  }
  return end < value.length ? `${value.slice(0, end)}…` : value.slice(0, end);
}

function timeUnitLabel(unit: number): string {
  if (unit === TimeUnit.SECOND) return "s";
  if (unit === TimeUnit.MILLISECOND) return "ms";
  if (unit === TimeUnit.MICROSECOND) return "us";
  return "ns";
}

function intervalUnitLabel(unit: number): string {
  if (unit === IntervalUnit.YEAR_MONTH) return "year_month";
  if (unit === IntervalUnit.DAY_TIME) return "day_time";
  return "month_day_nano";
}

function StatisticsPanel({
  state,
  onCancel,
  onComputeMinMax,
}: {
  state: StatisticsState;
  onCancel: () => void;
  onComputeMinMax: () => void;
}) {
  if (state.kind === "idle") {
    return (
      <p className="statistics-prompt">
        Select a column to scan its statistics.
      </p>
    );
  }

  if (state.kind === "loading") {
    return (
      <section
        className="statistics-panel"
        aria-label={`${state.columnName} statistics`}
      >
        <div className="statistics-heading">
          <h3>{state.columnName}</h3>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
        <progress aria-label="Computing column statistics" />
      </section>
    );
  }

  if (state.kind === "ready") {
    return (
      <section
        className="statistics-panel"
        aria-label={`${state.columnName} statistics`}
      >
        <div className="statistics-heading">
          <h3>{state.columnName}</h3>
        </div>
        <dl className="column-statistics">
          {state.value.minMaxComputed && (
            <>
              <Statistic label="Minimum" value={state.value.minimum ?? "—"} />
              <Statistic label="Maximum" value={state.value.maximum ?? "—"} />
            </>
          )}
          <Statistic
            label="Null share"
            value={formatNullShare(state.value.nullShare)}
          />
          <Statistic
            label="Distinct"
            value={formatApproximateCount(state.value.approximateDistinctCount)}
          />
        </dl>
        {!state.value.minMaxComputed && (
          <button
            className="statistics-action"
            type="button"
            onClick={onComputeMinMax}
          >
            Compute min/max
          </button>
        )}
      </section>
    );
  }

  return (
    <section
      className="statistics-panel"
      aria-label={`${state.columnName} statistics`}
    >
      <div className="statistics-heading">
        <h3>{state.columnName}</h3>
      </div>
      <p
        className={
          state.kind === "error" ? "statistics-error" : "statistics-cancelled"
        }
      >
        {state.kind === "error" ? state.message : "Statistics cancelled."}
      </p>
    </section>
  );
}

function Statistic({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatNullShare(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatColumnCount(value: number): string {
  return `${value.toLocaleString()} ${value === 1 ? "column" : "columns"}`;
}

function formatApproximateCount(value: number): string {
  return `≈ ${new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)}`;
}

function shouldDeferMinMax(field: SourceSummary["schema"][number]): boolean {
  return field.physicalType === "BYTE_ARRAY";
}

function statisticsErrorMessage(error: unknown): string {
  if (error instanceof ColumnStatisticsCommandError) {
    if (error.code === "notFound" || error.code === "noSourceOpen") {
      return "The open file is no longer available.";
    }
    if (error.code === "permissionDenied") {
      return "Viewda no longer has permission to read this file.";
    }
    if (error.code === "corruptSource" || error.code === "notParquet") {
      return "The open Parquet file is damaged or incomplete.";
    }
    if (error.code === "unsupportedColumn" || error.code === "unsupported") {
      return "Statistics are unavailable for this column.";
    }
    if (error.code === "resourceExhausted") {
      return "There is not enough memory to compute these statistics.";
    }
  }
  return "Column statistics could not be computed.";
}
