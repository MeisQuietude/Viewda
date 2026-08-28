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
  type FieldPath,
  type SchemaField,
  type SourceSummary,
} from "../desktop";
import {
  LIST_MAP_COLUMN_REASON,
  SchemaTreeNode,
  type SchemaPathMenuRequest,
} from "../SchemaTree";
import {
  fieldPathKey,
  formatFieldPath,
  resolveSchemaField,
  sameFieldPath,
} from "./field-path";

const LOGICAL_SCHEMA_NODE_LIMIT = 2_048;
const LOGICAL_SCHEMA_DEPTH_LIMIT = 64;
const LOGICAL_SCHEMA_TEXT_LIMIT = 160;
const DUPLICATE_PATH_ACTION_REASON =
  "Unavailable because this source has duplicate column names.";

type StatisticsState =
  | { kind: "idle" }
  | {
      kind: "loading";
      fieldPath: FieldPath;
      columnName: string;
      previous: ColumnStatistics | null;
    }
  | {
      kind: "ready";
      fieldPath: FieldPath;
      columnName: string;
      value: ColumnStatistics;
    }
  | { kind: "cancelled"; columnName: string }
  | { kind: "error"; columnName: string; message: string };

export function SchemaSidebar({
  open,
  selectedPath,
  source,
  dataTypes = new Map(),
  pathActionsEnabled = true,
  flattenedPathKeys = new Set(),
  onSelectPath,
  onFlattenPath,
  onUnflattenPath,
}: {
  open: boolean;
  selectedPath: FieldPath | null;
  source: SourceSummary;
  dataTypes?: ReadonlyMap<string, DataType>;
  pathActionsEnabled?: boolean;
  flattenedPathKeys?: ReadonlySet<string>;
  onSelectPath: (fieldPath: FieldPath) => void;
  onFlattenPath: (fieldPath: FieldPath) => void;
  onUnflattenPath?: (fieldPath: FieldPath) => void;
}) {
  const [statistics, setStatistics] = useState<StatisticsState>({
    kind: "idle",
  });
  const [pathMenu, setPathMenu] = useState<
    (SchemaPathMenuRequest & { left: number; top: number }) | null
  >(null);
  const pathMenuRef = useRef<HTMLDivElement>(null);
  const requestVersion = useRef(0);

  const openPathMenu = (request: SchemaPathMenuRequest) => {
    const width = 292;
    const height = request.disabledReason === undefined ? 38 : 58;
    setPathMenu({
      ...request,
      left: Math.max(
        4,
        Math.min(request.clientX, window.innerWidth - width - 4),
      ),
      top: Math.max(
        4,
        Math.min(request.clientY, window.innerHeight - height - 4),
      ),
    });
  };

  useEffect(() => {
    if (pathMenu === null) return;
    const menu = pathMenuRef.current;
    menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    if (document.activeElement !== menu?.querySelector("button")) {
      menu?.focus();
    }
    const close = (returnFocus: boolean) => {
      setPathMenu(null);
      if (returnFocus) pathMenu.trigger.focus();
    };
    const closeOutside = (event: PointerEvent) => {
      if (!menu?.contains(event.target as Node)) close(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pathMenu]);

  useEffect(() => {
    if (!open) setPathMenu(null);
  }, [open]);

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
    fieldPath: FieldPath,
    includeMinMax: boolean,
    previous: ColumnStatistics | null,
  ) => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    onSelectPath(fieldPath);
    setStatistics({
      kind: "loading",
      fieldPath,
      columnName: formatFieldPath(fieldPath),
      previous,
    });

    try {
      const value = await getColumnStatistics(
        source.generation,
        fieldPath,
        includeMinMax,
      );
      if (requestVersion.current === version) {
        setStatistics({
          kind: "ready",
          fieldPath,
          columnName: formatFieldPath(fieldPath),
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
        setStatistics({
          kind: "cancelled",
          columnName: formatFieldPath(fieldPath),
        });
      } else {
        setStatistics({
          kind: "error",
          columnName: formatFieldPath(fieldPath),
          message: statisticsErrorMessage(error),
        });
      }
    }
  };

  const selectField = (fieldPath: FieldPath, field: SchemaField) => {
    void loadStatistics(fieldPath, !shouldDeferMinMax(field), null);
  };

  const computeMinMax = () => {
    if (statistics.kind === "ready") {
      const field = resolveSchemaField(source.schema, statistics.fieldPath);
      if (field !== undefined) {
        void loadStatistics(statistics.fieldPath, true, statistics.value);
      }
    }
  };

  const cancelStatistics = async () => {
    if (statistics.kind !== "loading") {
      return;
    }
    const columnName = statistics.columnName;
    const fieldPath = statistics.fieldPath;
    const previous = statistics.previous;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setStatistics(
      previous === null
        ? { kind: "cancelled", columnName }
        : { kind: "ready", fieldPath, columnName, value: previous },
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
            {source.schema.map((field, columnIndex) => {
              const fieldPath = [field.name];
              const dataType = dataTypes.get(fieldPathKey(fieldPath));
              return dataType === undefined ? (
                <SchemaTreeNode
                  key={columnIndex}
                  field={field}
                  fieldPath={fieldPath}
                  selectedPath={selectedPath}
                  pathActionDisabledReason={
                    pathActionsEnabled
                      ? undefined
                      : DUPLICATE_PATH_ACTION_REASON
                  }
                  flattenedPathKeys={flattenedPathKeys}
                  onSelectPath={(path, selectedField) =>
                    void selectField(path, selectedField)
                  }
                  onOpenPathMenu={openPathMenu}
                />
              ) : (
                <LogicalSchemaNode
                  key={columnIndex}
                  name={field.name}
                  field={field}
                  fieldPath={fieldPath}
                  dataType={dataType}
                  selectedPath={selectedPath}
                  pathActionsEnabled={pathActionsEnabled}
                  flattenedPathKeys={flattenedPathKeys}
                  onSelect={selectField}
                  onOpenPathMenu={openPathMenu}
                />
              );
            })}
            {source.schemaIsTruncated &&
              source.schema.some(
                (field) => !dataTypes.has(fieldPathKey([field.name])),
              ) && (
                <li className="logical-schema-incomplete">
                  Schema is incomplete; unloaded fields use the physical view.
                </li>
              )}
          </ul>
          {pathMenu !== null && (
            <div
              ref={pathMenuRef}
              className="column-menu schema-path-menu"
              role="menu"
              aria-label="Schema field actions"
              tabIndex={-1}
              style={{ left: pathMenu.left, top: pathMenu.top }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={pathMenu.disabledReason !== undefined}
                aria-label={`${pathMenu.flattened ? "Unflatten" : "Flatten"} ${formatFieldPath(pathMenu.fieldPath)}${pathMenu.disabledReason === undefined ? "" : `. ${pathMenu.disabledReason}`}`}
                onClick={() => {
                  const trigger = pathMenu.trigger;
                  setPathMenu(null);
                  trigger.focus();
                  if (pathMenu.flattened) {
                    onUnflattenPath?.(pathMenu.fieldPath);
                  } else {
                    onFlattenPath(pathMenu.fieldPath);
                  }
                }}
              >
                <span>
                  {pathMenu.flattened ? "Unflatten" : "Flatten"}{" "}
                  {formatFieldPath(pathMenu.fieldPath)}
                </span>
                {pathMenu.disabledReason !== undefined && (
                  <span className="menu-shortcut">
                    {pathMenu.disabledReason}
                  </span>
                )}
              </button>
            </div>
          )}
          <StatisticsPanel
            state={statistics}
            schema={source.schema}
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
  field,
  fieldPath,
  dataType,
  selectedPath,
  pathActionsEnabled,
  flattenedPathKeys,
  onSelect,
  onOpenPathMenu,
}: {
  name: string;
  field: SchemaField;
  fieldPath: FieldPath;
  dataType: DataType;
  selectedPath: FieldPath | null;
  pathActionsEnabled: boolean;
  flattenedPathKeys: ReadonlySet<string>;
  onSelect: (fieldPath: FieldPath, field: SchemaField) => void;
  onOpenPathMenu: (request: SchemaPathMenuRequest) => void;
}) {
  const projection = useMemo(
    () => _projectLogicalSchema(name, dataType),
    [dataType, name],
  );
  const flattenDisabledReason = flattenUnavailableReason(field);
  const flattened = flattenedPathKeys.has(fieldPathKey(fieldPath));
  const pathActionDisabledReason = pathActionsEnabled
    ? undefined
    : DUPLICATE_PATH_ACTION_REASON;
  const openPathMenu = (
    path: FieldPath,
    isFlattened: boolean,
    disabledReason: string | undefined,
    trigger: HTMLElement,
    clientX: number,
    clientY: number,
  ) => {
    onOpenPathMenu({
      fieldPath: path,
      flattened: isFlattened,
      disabledReason,
      trigger,
      clientX,
      clientY,
    });
  };
  return (
    <li>
      <button
        className="schema-field"
        type="button"
        aria-disabled={!pathActionsEnabled || undefined}
        title={pathActionDisabledReason}
        aria-label={
          pathActionDisabledReason === undefined
            ? undefined
            : `${formatFieldPath(fieldPath)}. ${pathActionDisabledReason}`
        }
        aria-pressed={
          selectedPath !== null && sameFieldPath(selectedPath, fieldPath)
        }
        onClick={() => {
          if (pathActionsEnabled) onSelect(fieldPath, field);
        }}
        onContextMenu={(event) => {
          if (dataType.typeId !== Type.Struct) return;
          event.preventDefault();
          event.stopPropagation();
          openPathMenu(
            fieldPath,
            flattened,
            pathActionDisabledReason ??
              (flattened ? undefined : flattenDisabledReason),
            event.currentTarget,
            event.clientX,
            event.clientY,
          );
        }}
        onKeyDown={(event) => {
          if (
            dataType.typeId !== Type.Struct ||
            (event.key !== "ContextMenu" &&
              !(event.shiftKey && event.key === "F10"))
          ) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          openPathMenu(
            fieldPath,
            flattened,
            pathActionDisabledReason ??
              (flattened ? undefined : flattenDisabledReason),
            event.currentTarget,
            bounds.left,
            bounds.bottom,
          );
        }}
      >
        <span className="schema-name">{projection.name}</span>
        <span className="schema-type" title={projection.type}>
          {projection.type}
        </span>
      </button>
      {projection.rows.some(
        (row) => !row.addressable && row.segments.length > 0,
      ) && <p className="schema-continuation">{LIST_MAP_COLUMN_REASON}</p>}
      {projection.rows.length > 0 && (
        <ul className="logical-schema-rows">
          {projection.rows.map((row, index) => {
            const rowPath = [...fieldPath, ...row.segments];
            const rowField = resolveSchemaField(
              [field],
              [name, ...row.segments],
            );
            const selectable = row.addressable && rowField !== undefined;
            const rowPathDisabledReason =
              pathActionDisabledReason ??
              (!row.addressable && row.segments.length > 0
                ? LIST_MAP_COLUMN_REASON
                : row.addressable && rowField === undefined
                  ? "This field cannot be selected because its name is not unique in the source schema."
                  : undefined);
            const rowFlattenDisabledReason =
              rowField === undefined
                ? undefined
                : flattenUnavailableReason(rowField);
            const rowFlattened = flattenedPathKeys.has(fieldPathKey(rowPath));
            return (
              <li
                key={`${index}:${row.name}`}
                className="logical-schema-row"
                style={{ paddingLeft: `${Math.min(row.depth, 8) * 10}px` }}
              >
                <button
                  className="schema-field"
                  type="button"
                  disabled={!selectable}
                  aria-disabled={
                    !pathActionsEnabled || !selectable || undefined
                  }
                  title={rowPathDisabledReason}
                  aria-label={
                    rowPathDisabledReason === undefined
                      ? undefined
                      : `${formatFieldPath(rowPath)}. ${rowPathDisabledReason}`
                  }
                  aria-pressed={
                    selectedPath !== null &&
                    sameFieldPath(selectedPath, rowPath)
                  }
                  onClick={() => {
                    if (pathActionsEnabled && rowField !== undefined) {
                      onSelect(rowPath, rowField);
                    }
                  }}
                  onContextMenu={(event) => {
                    if (!selectable || row.dataType.typeId !== Type.Struct) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    openPathMenu(
                      rowPath,
                      rowFlattened,
                      pathActionDisabledReason ??
                        (rowFlattened ? undefined : rowFlattenDisabledReason),
                      event.currentTarget,
                      event.clientX,
                      event.clientY,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (
                      !selectable ||
                      row.dataType.typeId !== Type.Struct ||
                      (event.key !== "ContextMenu" &&
                        !(event.shiftKey && event.key === "F10"))
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    openPathMenu(
                      rowPath,
                      rowFlattened,
                      pathActionDisabledReason ??
                        (rowFlattened ? undefined : rowFlattenDisabledReason),
                      event.currentTarget,
                      bounds.left,
                      bounds.bottom,
                    );
                  }}
                >
                  <span className="schema-name">{row.name}</span>
                  <span className="schema-type" title={row.type}>
                    {row.type}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

interface LogicalSchemaProjection {
  name: string;
  type: string;
  rows: Array<{
    name: string;
    type: string;
    depth: number;
    segments: string[];
    addressable: boolean;
    dataType: DataType;
  }>;
}

export function _projectLogicalSchema(
  name: string,
  dataType: DataType,
): LogicalSchemaProjection {
  const rows: LogicalSchemaProjection["rows"] = [];
  const budget = { visited: 0, incomplete: false };
  const stack = logicalChildFields(dataType, 1, budget, [], true).reverse();
  while (stack.length > 0 && budget.visited < LOGICAL_SCHEMA_NODE_LIMIT) {
    const current = stack.pop()!;
    budget.visited += 1;
    rows.push({
      name: boundedSchemaText(current.field.name),
      type: formatDataTypeLabel(current.field.type),
      depth: current.depth,
      segments: current.segments,
      addressable: current.addressable,
      dataType: current.field.type,
    });
    if (current.depth >= LOGICAL_SCHEMA_DEPTH_LIMIT) {
      if (
        logicalChildFields(
          current.field.type,
          current.depth + 1,
          budget,
          current.segments,
          current.addressable,
        ).length
      )
        budget.incomplete = true;
      continue;
    }
    const children = logicalChildFields(
      current.field.type,
      current.depth + 1,
      budget,
      current.segments,
      current.addressable,
    );
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  if (stack.length > 0 || budget.incomplete) {
    rows.push({
      name: "…",
      type: "more fields",
      depth: 1,
      segments: [],
      addressable: false,
      dataType,
    });
  }
  return {
    name: boundedSchemaText(name),
    type: formatDataTypeLabel(dataType),
    rows,
  };
}

function logicalChildFields(
  input: DataType,
  depth: number,
  budget: { visited: number; incomplete: boolean },
  parentSegments: string[],
  parentAddressable: boolean,
): Array<{
  field: Field;
  depth: number;
  segments: string[];
  addressable: boolean;
}> {
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
      return dataType.children.slice(0, remaining).map((field) => ({
        field,
        depth,
        segments: [...parentSegments, field.name],
        addressable: parentAddressable,
      }));
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
      parentAddressable = false;
      continue;
    }
    if (dataType.typeId === Type.Map) {
      const entries = dataType.children[0]?.type;
      return entries?.typeId === Type.Struct
        ? entries.children.map((field) => ({
            field,
            depth,
            segments: [...parentSegments, field.name],
            addressable: false,
          }))
        : [];
    }
    return [];
  }
  budget.incomplete = true;
  return [];
}

export function formatDataTypeLabel(input: DataType): string {
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
  return formatDataTypeLabel(dataType);
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
  schema,
  onCancel,
  onComputeMinMax,
}: {
  state: StatisticsState;
  schema: readonly SchemaField[];
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
    const field = resolveSchemaField(schema, state.fieldPath);
    const countNoun = field?.logicalType?.startsWith("Map")
      ? "pair count"
      : "length";
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
            label="Null rows"
            value={state.value.nullCount.toLocaleString("en-US")}
          />
          {state.value.containerCount === null ? (
            <Statistic
              label="Distinct"
              value={
                state.value.approximateDistinctCount === null
                  ? "—"
                  : formatApproximateCount(state.value.approximateDistinctCount)
              }
            />
          ) : (
            <>
              <Statistic
                label={`Minimum ${countNoun}`}
                value={
                  state.value.containerCount.minimum?.toLocaleString() ?? "—"
                }
              />
              <Statistic
                label={`Average ${countNoun}`}
                value={
                  state.value.containerCount.average?.toLocaleString("en-US", {
                    maximumFractionDigits: 2,
                  }) ?? "—"
                }
              />
              <Statistic
                label={`Maximum ${countNoun}`}
                value={
                  state.value.containerCount.maximum?.toLocaleString() ?? "—"
                }
              />
              <Statistic
                label={
                  countNoun === "pair count" ? "Empty maps" : "Empty lists"
                }
                value={state.value.containerCount.emptyCount.toLocaleString(
                  "en-US",
                )}
              />
            </>
          )}
        </dl>
        {!state.value.minMaxComputed && state.value.containerCount === null && (
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

function flattenUnavailableReason(field: SchemaField): string | undefined {
  if (field.children.length === 0) {
    return "Flatten is unavailable because this struct has no child fields.";
  }
  const names = new Set<string>();
  for (const child of field.children) {
    if (names.has(child.name)) {
      return "Flatten is unavailable because this struct contains duplicate child names.";
    }
    names.add(child.name);
  }
  return undefined;
}

function formatApproximateCount(value: number): string {
  return `≈ ${new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)}`;
}

function shouldDeferMinMax(field: SourceSummary["schema"][number]): boolean {
  return (
    field.physicalType === "BYTE_ARRAY" ||
    field.logicalType?.startsWith("List") === true ||
    field.logicalType?.startsWith("Map") === true
  );
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
