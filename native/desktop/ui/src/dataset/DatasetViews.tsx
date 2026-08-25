import { memo, useCallback, useEffect, useRef, useState } from "react";

import { windowValue, type ArrowDataWindow } from "../data-grid/arrow-window";
import {
  getDatasetMembers,
  getDatasetSchemaDriftMembers,
  selectDatasetStructureMember,
  type DatasetDiscoveryProgress,
  type DatasetMemberSummary,
  type DatasetReadySummary,
  type DatasetStatus,
  type SourceSummary,
} from "../desktop";
import { SourceErrorMessage } from "../SourceErrorMessage";
import {
  StructureGrid,
  type StructureGridCell,
} from "../structure/StructureGrid";
import { pageCovers, pageRequestFor } from "../structure/table-page";
import { DatasetPartitionTree } from "./DatasetPartitionTree";

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
  const [committedMember, setCommittedMember] = useState<{
    ordinal: number;
    relativePath: string | null;
    request: number;
  }>({ ordinal: 0, relativePath: null, request: 0 });
  const [pendingOrdinal, setPendingOrdinal] = useState<number | null>(null);
  const [memberSelectorOpen, setMemberSelectorOpen] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const selectionRequest = useRef(0);
  const memberSelectorSummary = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    selectionRequest.current += 1;
    setCommittedMember({ ordinal: 0, relativePath: null, request: 0 });
    setPendingOrdinal(null);
    setMemberSelectorOpen(false);
    setSelectionError(false);
    void getDatasetMembers(generation, 0, 1).then(
      (page) => {
        if (current) {
          const member = page.members[0];
          if (member !== undefined) {
            setCommittedMember((committed) =>
              committed.ordinal === 0
                ? { ...committed, relativePath: member.relativePath }
                : committed,
            );
          }
        }
      },
      () => {},
    );
    return () => {
      current = false;
      selectionRequest.current += 1;
    };
  }, [generation]);

  const selectMember = (ordinal: number) => {
    if (pendingOrdinal !== null || ordinal === committedMember.ordinal) return;
    const request = ++selectionRequest.current;
    setPendingOrdinal(ordinal);
    setMemberSelectorOpen(false);
    setSelectionError(false);
    void selectDatasetStructureMember(generation, ordinal).then(
      (member) => {
        if (selectionRequest.current !== request) return;
        setPendingOrdinal(null);
        setCommittedMember((committed) => ({
          ordinal: member.ordinal,
          relativePath: member.relativePath,
          request: committed.request + 1,
        }));
        onSelected();
      },
      () => {
        if (selectionRequest.current !== request) return;
        setPendingOrdinal(null);
        setSelectionError(true);
      },
    );
  };

  const activateMemberFromSelector = (ordinal: number) => {
    setMemberSelectorOpen(false);
    memberSelectorSummary.current?.focus();
    selectMember(ordinal);
  };

  return (
    <aside className="dataset-structure-nav" aria-label="Dataset navigator">
      {active && (
        <>
          <div className="dataset-member-selector-row">
            <details
              className="dataset-member-selector"
              open={memberSelectorOpen}
              onToggle={(event) =>
                setMemberSelectorOpen(event.currentTarget.open)
              }
            >
              <summary
                ref={memberSelectorSummary}
                title="Choose which Parquet file the Structure layout describes."
              >
                <span className="dataset-member-selector-label">
                  Dataset file
                </span>
                <span
                  className="dataset-member-selector-value"
                  title={committedMember.relativePath ?? undefined}
                >
                  {committedMember.relativePath ??
                    `File ${committedMember.ordinal + 1}`}
                </span>
                <span className="dataset-member-selector-position">
                  {committedMember.ordinal + 1} of{" "}
                  {ready.memberCount.toLocaleString("en-US")}
                </span>
              </summary>
              {memberSelectorOpen && pendingOrdinal === null && (
                <PagedDatasetMembers
                  generation={generation}
                  total={ready.memberCount}
                  kind="all"
                  selectedRow={{
                    row: committedMember.ordinal,
                    request: committedMember.request,
                  }}
                  onActivate={activateMemberFromSelector}
                />
              )}
            </details>
            <div
              className="dataset-member-stepper"
              role="group"
              aria-label="Compare dataset files"
            >
              <button
                type="button"
                disabled={
                  pendingOrdinal !== null || committedMember.ordinal === 0
                }
                onClick={() => selectMember(committedMember.ordinal - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                disabled={
                  pendingOrdinal !== null ||
                  committedMember.ordinal + 1 >= ready.memberCount
                }
                onClick={() => selectMember(committedMember.ordinal + 1)}
              >
                Next
              </button>
            </div>
          </div>
          <p className="dataset-member-scope">
            Structure shows this file. Data shows the entire dataset.
          </p>
        </>
      )}
      {pendingOrdinal !== null && (
        <p className="dataset-member-status" role="status" aria-live="polite">
          Loading file {pendingOrdinal + 1} for Structure…
        </p>
      )}
      {selectionError && (
        <p role="alert">
          Structure could not switch files. The previous file remains selected;
          try again.
        </p>
      )}
      {active && ready.partitionColumnIndices.length > 0 && (
        <section className="dataset-partitions" aria-label="Dataset partitions">
          <h2>Partitions</h2>
          <DatasetPartitionTree
            generation={generation}
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
            onActivate={selectMember}
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

function PagedDatasetMembers({
  generation,
  total,
  kind,
  onActivate,
  selectedRow,
}: {
  generation: number;
  total: number;
  kind: "all" | "drift";
  onActivate?: (ordinal: number) => void;
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
        onActivateRow={
          onActivate === undefined
            ? undefined
            : (row) => {
                const member = page?.members[row - page.offset];
                if (member !== undefined) onActivate(member.ordinal);
              }
        }
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

export function DatasetInspection({
  status,
  preview,
  previewFailed,
  onRetryPreview,
  source,
  onCancel,
  onReload,
  statusUnavailable = false,
  onRetryStatus,
}: {
  status: DatasetStatus | null;
  preview: ArrowDataWindow | null;
  previewFailed: boolean;
  onRetryPreview: () => void;
  source: SourceSummary;
  onCancel: () => void;
  onReload?: () => void;
  statusUnavailable?: boolean;
  onRetryStatus?: () => void;
}) {
  const progress = status?.state === "inspecting" ? status.progress : null;
  if (status?.state === "failed") {
    return (
      <section className="dataset-inspection" aria-label="Dataset inspection">
        <SourceErrorMessage error={status.error} onReload={onReload} />
      </section>
    );
  }
  if (status === null || status.state === "discovering") {
    const sampleAvailable =
      status?.state === "discovering" && status.sampleSummary !== null;
    return (
      <section className="dataset-inspection" aria-label="Dataset inspection">
        <DatasetDiscoveryStatus
          progress={status?.state === "discovering" ? status.progress : null}
          sampleAvailable={sampleAvailable}
          statusUnavailable={statusUnavailable}
          onRetryStatus={onRetryStatus}
          onCancel={onCancel}
        />
        {sampleAvailable && preview !== null ? (
          <DatasetPreview source={source} preview={preview} />
        ) : sampleAvailable && previewFailed ? (
          <p className="dataset-preview-note">
            The early sample is available in Data, but its static preview could
            not be loaded here.{" "}
            <button
              className="text-button"
              type="button"
              onClick={onRetryPreview}
            >
              Retry
            </button>
          </p>
        ) : null}
      </section>
    );
  }
  return (
    <section className="dataset-inspection" aria-label="Dataset inspection">
      <DatasetInspectionProgress
        status={status}
        provisionalRowCount={source.rowCount}
        onCancel={onCancel}
      />
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
          Preview is unavailable while inspection continues.{" "}
          <button
            className="text-button"
            type="button"
            onClick={onRetryPreview}
          >
            Retry
          </button>
        </p>
      ) : (
        <p className="dataset-preview-note">Loading first rows…</p>
      )}
    </section>
  );
}

export function DatasetDiscoveryStatus({
  progress,
  sampleAvailable,
  statusUnavailable = false,
  onRetryStatus,
  onCancel,
}: {
  progress: DatasetDiscoveryProgress | null;
  sampleAvailable: boolean;
  statusUnavailable?: boolean;
  onRetryStatus?: () => void;
  onCancel: () => void;
}) {
  const discovered = progress?.discoveredMemberCount ?? 0;
  return (
    <aside
      className="dataset-inspection-progress"
      aria-label="Dataset discovery progress"
    >
      <div className="dataset-inspection-status">
        <div role="status" aria-live="polite">
          <span>
            Finding Parquet files… {discovered.toLocaleString("en-US")} Parquet
            files found
          </span>
          <progress aria-label="Dataset discovery" />
        </div>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {sampleAvailable && (
        <p className="dataset-preview-scope">
          Early sample; final dataset order and totals are pending.
        </p>
      )}
      {statusUnavailable && (
        <p className="dataset-status-error" role="alert">
          Discovery status is unavailable.
          {sampleAvailable
            ? " The early sample remains available."
            : " No sample is available yet."}
          {onRetryStatus !== undefined && (
            <button
              className="text-button"
              type="button"
              onClick={onRetryStatus}
            >
              Retry
            </button>
          )}
        </p>
      )}
    </aside>
  );
}

export function DatasetInspectionProgress({
  status,
  provisionalRowCount,
  statusUnavailable = false,
  onRetryStatus,
  onCancel,
}: {
  status: DatasetStatus | null;
  provisionalRowCount: number;
  statusUnavailable?: boolean;
  onRetryStatus?: () => void;
  onCancel: () => void;
}) {
  const progress = status?.state === "inspecting" ? status.progress : null;
  const complete = status?.state === "ready";
  return (
    <aside
      className="dataset-inspection-progress"
      aria-label="Dataset inspection progress"
    >
      <div className="dataset-inspection-status">
        <div role="status" aria-live="polite">
          <span>
            {complete
              ? "Preparing the complete dataset…"
              : progress === null
                ? "Inspecting dataset…"
                : `Inspecting dataset — ${progress.completedMemberCount.toLocaleString("en-US")} of ${progress.totalMemberCount.toLocaleString("en-US")} files`}
          </span>
          {progress === null ? (
            <progress aria-label="Dataset inspection" />
          ) : (
            <progress
              aria-label="Dataset inspection"
              value={progress.completedMemberCount}
              max={progress.totalMemberCount}
            />
          )}
        </div>
        <button className="text-button" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {!complete && (
        <p className="dataset-preview-scope">
          Early sample
          {provisionalRowCount === 0
            ? "; final dataset order and totals are pending."
            : ` (${provisionalRowCount.toLocaleString("en-US")} rows); final dataset order and totals are pending.`}
        </p>
      )}
      {statusUnavailable && (
        <p className="dataset-status-error" role="alert">
          Inspection status is unavailable. The early sample remains available.
          {onRetryStatus !== undefined && (
            <button
              className="text-button"
              type="button"
              onClick={onRetryStatus}
            >
              Retry
            </button>
          )}
        </p>
      )}
    </aside>
  );
}

const DatasetPreview = memo(function DatasetPreview({
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
});
