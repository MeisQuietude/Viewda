import { useEffect, useRef, useState } from "react";

import {
  cancelColumnStatistics,
  ColumnStatisticsCommandError,
  getColumnStatistics,
  type ColumnStatistics,
  type SourceSummary,
} from "../desktop";
import { SchemaTreeNode } from "../SchemaTree";

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
  onSelectColumn,
}: {
  open: boolean;
  selectedColumn: number | null;
  source: SourceSummary;
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
            {source.schema.map((field, columnIndex) => (
              <SchemaTreeNode
                key={columnIndex}
                field={field}
                selected={selectedColumn === columnIndex}
                onSelect={() => void selectColumn(columnIndex)}
                mode="logical"
              />
            ))}
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
