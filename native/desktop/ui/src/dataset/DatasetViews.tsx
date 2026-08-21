import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { windowValue, type ArrowDataWindow } from "../data-grid/arrow-window";
import {
  getDatasetMembers,
  getDatasetPartitions,
  getDatasetSchemaDriftMembers,
  selectDatasetStructureMember,
  type DatasetMemberSummary,
  type DatasetPartitionNode,
  type DatasetReadySummary,
  type DatasetStatus,
  type PartitionValue,
  type SourceSummary,
} from "../desktop";
import { SourceErrorMessage } from "../SourceErrorMessage";
import {
  StructureGrid,
  type StructureGridCell,
} from "../structure/StructureGrid";
import { pageCovers, pageRequestFor } from "../structure/table-page";

export function DatasetStructureNavigator({
  generation,
  ready,
  active,
  onSelected,
}: {
  generation: number;
  ready: DatasetReadySummary;
  active: boolean;
  onSelected: () => void;
}) {
  const [selectedMember, setSelectedMember] = useState({ row: 0, request: 0 });
  const [selectionError, setSelectionError] = useState(false);
  const selectionRequest = useRef(0);
  const selectionTail = useRef<Promise<void>>(Promise.resolve());
  const latestOrdinal = useRef(0);
  const committedOrdinal = useRef(0);
  const nativeOrdinal = useRef(0);
  const nativeSelectionDirty = useRef(false);

  useEffect(
    () => () => {
      selectionRequest.current += 1;
    },
    [generation],
  );

  const selectMember = (ordinal: number) => {
    if (ordinal === latestOrdinal.current) return;
    latestOrdinal.current = ordinal;
    const request = ++selectionRequest.current;
    setSelectionError(false);
    selectionTail.current = selectionTail.current.then(async () => {
      if (selectionRequest.current !== request) return;
      if (
        committedOrdinal.current === ordinal &&
        !nativeSelectionDirty.current
      ) {
        return;
      }
      try {
        await selectDatasetStructureMember(generation, ordinal);
        nativeOrdinal.current = ordinal;
        nativeSelectionDirty.current = true;
        if (selectionRequest.current !== request) return;
        committedOrdinal.current = ordinal;
        nativeSelectionDirty.current = false;
        setSelectedMember((current) => ({
          row: ordinal,
          request: current.request + 1,
        }));
        onSelected();
      } catch {
        if (selectionRequest.current === request) {
          setSelectionError(true);
          latestOrdinal.current = nativeOrdinal.current;
          if (nativeSelectionDirty.current) {
            committedOrdinal.current = nativeOrdinal.current;
            nativeSelectionDirty.current = false;
            setSelectedMember((current) => ({
              row: nativeOrdinal.current,
              request: current.request + 1,
            }));
            onSelected();
          }
        }
      }
    });
  };

  return (
    <aside className="dataset-structure-nav" aria-label="Dataset structure">
      <div className="dataset-structure-facts">
        <span>
          {formatCount(ready.memberCount, "parquet file")} ·{" "}
          {formatCount(ready.ignoredFileCount, "other file")} ignored
        </span>
        {ready.schemaDriftMemberCount > 0 && (
          <span>
            {ready.schemaDriftMemberCount.toLocaleString("en-US")} with schema
            differences
          </span>
        )}
      </div>
      {active && (
        <PagedDatasetMembers
          generation={generation}
          total={ready.memberCount}
          kind="all"
          selectedRow={selectedMember}
          onSelect={selectMember}
        />
      )}
      {selectionError && (
        <p role="alert">This dataset member could not be selected.</p>
      )}
      {active && ready.partitionColumnIndices.length > 0 && (
        <section aria-label="Dataset partitions">
          <h2>Partitions</h2>
          <DatasetPartitionLevel
            generation={generation}
            parent={ROOT_PARTITION_PATH}
            depth={ready.partitionColumnIndices.length}
          />
        </section>
      )}
      {active && ready.schemaDriftMemberCount > 0 && (
        <details>
          <summary>Members with schema differences</summary>
          <PagedDatasetMembers
            generation={generation}
            total={ready.schemaDriftMemberCount}
            kind="drift"
          />
        </details>
      )}
    </aside>
  );
}

const DATASET_MEMBER_COLUMNS = [
  {
    id: "path",
    title: "Member",
    width: 520,
    alignment: "left" as const,
    monospace: false,
    sortable: false,
  },
];
const ROOT_PARTITION_PATH: PartitionValue[] = [];

function PagedDatasetMembers({
  generation,
  total,
  kind,
  onSelect,
  selectedRow,
}: {
  generation: number;
  total: number;
  kind: "all" | "drift";
  onSelect?: (ordinal: number) => void;
  selectedRow?: { row: number; request: number };
}) {
  const [page, setPage] = useState<{
    offset: number;
    members: DatasetMemberSummary[];
  } | null>(null);
  const [error, setError] = useState(false);
  const request = useRef(0);

  useEffect(
    () => () => {
      request.current += 1;
    },
    [generation],
  );

  const loadViewport = useCallback(
    (rowStart: number, rowCount: number) => {
      if (
        pageCovers(
          page === null
            ? null
            : {
                offset: page.offset,
                length: page.members.length,
                totalCount: total,
              },
          rowStart,
          rowCount,
        )
      ) {
        return;
      }
      const wanted = pageRequestFor(rowStart, rowCount, total);
      if (wanted === null) return;
      const version = ++request.current;
      setError(false);
      const read =
        kind === "all" ? getDatasetMembers : getDatasetSchemaDriftMembers;
      void read(generation, wanted.offset, Math.min(wanted.limit, 256)).then(
        (next) => {
          if (request.current === version) {
            setPage({ offset: next.offset, members: next.members });
          }
        },
        () => {
          if (request.current === version) setError(true);
        },
      );
    },
    [generation, kind, page, total],
  );

  const getCell = useCallback(
    (row: number): StructureGridCell | null => {
      const member = page?.members[row - page.offset];
      return member === undefined
        ? null
        : { text: member.relativePath, faded: false };
    },
    [page],
  );

  return (
    <div className="dataset-member-grid">
      <StructureGrid
        label={kind === "all" ? "Dataset members" : "Schema drift members"}
        columns={DATASET_MEMBER_COLUMNS}
        rowCount={total}
        sortColumnId="path"
        sortDirection="ascending"
        contentRevision={page?.offset ?? 0}
        getCell={getCell}
        onSort={() => {}}
        onViewportChange={loadViewport}
        onSelectRow={onSelect}
        heldPage={
          page === null
            ? null
            : { offset: page.offset, length: page.members.length }
        }
        requestedRow={selectedRow}
      />
      {error && <p role="alert">This member page could not be loaded.</p>}
    </div>
  );
}

function DatasetPartitionLevel({
  generation,
  parent,
  depth,
}: {
  generation: number;
  parent: PartitionValue[];
  depth: number;
}) {
  const [nodes, setNodes] = useState<DatasetPartitionNode[]>([]);
  const [after, setAfter] = useState<PartitionValue | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState(false);
  const request = useRef(0);

  const load = useCallback(
    (cursor: PartitionValue | null) => {
      const version = ++request.current;
      setError(false);
      void getDatasetPartitions(generation, parent, cursor, 100).then(
        (page) => {
          if (request.current === version) {
            setNodes(page.nodes);
            setAfter(page.nextAfter);
            setExpanded(null);
          }
        },
        () => {
          if (request.current === version) setError(true);
        },
      );
    },
    [generation, parent],
  );

  useEffect(() => {
    load(null);
    return () => {
      request.current += 1;
    };
  }, [load]);

  const expandable = parent.length + 1 < depth;
  return (
    <ul
      className="dataset-partition-level"
      aria-label={partitionLevelLabel(parent)}
      tabIndex={0}
    >
      {nodes.map((node, index) => (
        <li key={`${index}:${node.partition.key}:${node.partition.value}`}>
          {expandable ? (
            <button
              className="dataset-partition-node"
              type="button"
              aria-expanded={expanded === index}
              onClick={() =>
                setExpanded((current) => (current === index ? null : index))
              }
            >
              <PartitionLabel node={node} />
            </button>
          ) : (
            <div className="dataset-partition-node">
              <PartitionLabel node={node} />
            </div>
          )}
          {expanded === index && (
            <DatasetPartitionChild
              generation={generation}
              parent={parent}
              partition={node.partition}
              depth={depth}
            />
          )}
        </li>
      ))}
      {after !== null && (
        <li>
          <button
            className="text-button"
            type="button"
            onClick={() => load(after)}
          >
            Next partitions
          </button>
        </li>
      )}
      {error && <li role="alert">This partition page could not be loaded.</li>}
    </ul>
  );
}

function DatasetPartitionChild({
  generation,
  parent,
  partition,
  depth,
}: {
  generation: number;
  parent: PartitionValue[];
  partition: PartitionValue;
  depth: number;
}) {
  const path = useMemo(() => [...parent, partition], [parent, partition]);
  return (
    <DatasetPartitionLevel
      generation={generation}
      parent={path}
      depth={depth}
    />
  );
}

function PartitionLabel({ node }: { node: DatasetPartitionNode }) {
  return (
    <>
      <span>
        {node.partition.key}={node.partition.value}
      </span>
      <span>{node.memberCount.toLocaleString("en-US")}</span>
    </>
  );
}

function formatCount(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

function partitionLevelLabel(parent: PartitionValue[]): string {
  if (parent.length === 0) return "Dataset partition values";
  return `Partition values under ${parent
    .map(({ key, value }) => `${key}=${value}`)
    .join(" / ")}`;
}

export function DatasetInspection({
  status,
  preview,
  previewFailed,
  source,
  onCancel,
}: {
  status: DatasetStatus | null;
  preview: ArrowDataWindow | null;
  previewFailed: boolean;
  source: SourceSummary;
  onCancel: () => void;
}) {
  const progress = status?.state === "inspecting" ? status.progress : null;
  if (status?.state === "failed") {
    return (
      <section className="dataset-inspection" aria-label="Dataset inspection">
        <SourceErrorMessage error={status.error} />
      </section>
    );
  }
  return (
    <section className="dataset-inspection" aria-label="Dataset inspection">
      <div
        className="dataset-inspection-status"
        role="status"
        aria-live="polite"
      >
        <span>
          Inspecting dataset
          {progress === null
            ? "…"
            : ` — ${progress.completedMemberCount.toLocaleString("en-US")} of ${progress.totalMemberCount.toLocaleString("en-US")} files`}
        </span>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {progress !== null && (
        <p className="dataset-inspection-facts">
          {progress.rowCount.toLocaleString("en-US")} rows ·{" "}
          {progress.rowGroupCount.toLocaleString("en-US")} row groups
        </p>
      )}
      {preview !== null ? (
        <DatasetPreview source={source} preview={preview} />
      ) : previewFailed ? (
        <p className="dataset-preview-note">
          Preview is unavailable while inspection continues.
        </p>
      ) : (
        <p className="dataset-preview-note">Loading first rows…</p>
      )}
    </section>
  );
}

function DatasetPreview({
  source,
  preview,
}: {
  source: SourceSummary;
  preview: ArrowDataWindow;
}) {
  const rows = Array.from(
    { length: Math.min(preview.rowCount, 20) },
    (_, row) => row,
  );
  return (
    <div
      className="dataset-preview-scroll"
      role="region"
      aria-label="Scrollable dataset preview"
      tabIndex={0}
    >
      <table className="dataset-preview" aria-label="Dataset preview">
        <thead>
          <tr>
            {source.schema.map((field, index) => (
              <th key={`${index}:${field.name}`}>{field.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row}>
              {source.schema.map((_, column) => {
                const value = windowValue(preview, column, row);
                return (
                  <td key={column}>{value == null ? "" : String(value)}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
