import type {
  DatasetReadySummary,
  SourceSummary,
  StructureByteUnit,
  StructureSummary,
} from "../desktop";
import type { ReactNode } from "react";
import {
  formatCodecs,
  formatFileSize,
  formatNumber,
  formatRatio,
  formatRowsPerRowGroup,
  MISSING_FACT,
} from "./format";
import type { StructureSummaryState } from "./use-structure-summary";
import { StructureHelp } from "./StructureHelp";

/**
 * States the file's shape as plain facts.
 *
 * Counts that the opened-source summary already carries appear immediately; the
 * footer-derived facts join them once the parse finishes, so entering the mode
 * never blanks the numbers the user already had.
 */
export function StructureCard({
  source,
  summary,
  dataset,
  datasetNavigator,
}: {
  source: SourceSummary;
  summary: StructureSummary | null;
  dataset?: DatasetReadySummary;
  datasetNavigator?: ReactNode;
}) {
  if (dataset !== undefined) {
    return (
      <div className="dataset-structure-summaries">
        <dl className="source-summary" aria-label="Dataset facts">
          <div className="source-summary-row">
            <dt>Dataset</dt>
            <dd className="source-summary-inline">
              <SummaryFact
                value={formatNumber(dataset.memberCount)}
                label="Parquet files"
              />
              <SummaryFact
                value={formatNumber(dataset.ignoredFileCount)}
                label="other files ignored"
              />
              {dataset.schemaDriftMemberCount > 0 && (
                <SummaryFact
                  value={formatNumber(dataset.schemaDriftMemberCount)}
                  label="with schema differences"
                />
              )}
            </dd>
          </div>
          <div className="source-summary-row">
            <dt>Shape</dt>
            <dd className="source-summary-inline">
              <SummaryFact
                value={formatNumber(dataset.rowCount)}
                label="rows"
              />
              <SummaryFact
                value={formatNumber(dataset.columnCount)}
                label="columns"
              />
              <SummaryFact
                value={formatNumber(dataset.rowGroupCount)}
                label={
                  <StructureHelp term="Row groups">row groups</StructureHelp>
                }
              />
            </dd>
          </div>
          <div className="source-summary-row">
            <dt>Storage</dt>
            <dd className="source-storage-summary">
              <SummaryFact
                value={formatFileSize(dataset.sizeBytes)}
                label="Dataset on disk"
                title={`${formatNumber(dataset.sizeBytes)} bytes`}
                valueAfterLabel
              />
            </dd>
          </div>
        </dl>
        {datasetNavigator}
        <SelectedFileFacts summary={summary} />
      </div>
    );
  }

  return (
    <dl className="source-summary" aria-label="File facts">
      <div className="source-summary-row">
        <dt>Shape</dt>
        <dd className="source-summary-inline">
          <SummaryFact value={formatNumber(source.rowCount)} label="rows" />
          <SummaryFact
            value={formatNumber(summary?.columnCount ?? source.columnCount)}
            label="columns"
          />
          <SummaryFact
            value={formatNumber(source.rowGroupCount)}
            label={<StructureHelp term="Row groups">row groups</StructureHelp>}
          />
          <SummaryFact
            value={formatRowsPerRowGroup(summary?.rowsPerRowGroup ?? null)}
            label={
              <StructureHelp term="Rows per group">rows/group</StructureHelp>
            }
          />
        </dd>
      </div>
      <div className="source-summary-row">
        <dt>
          <StructureHelp term="Storage" />
        </dt>
        <dd className="source-storage-summary">
          <SummaryFact
            value={formatFileSize(source.sizeBytes)}
            label="File on disk"
            title={`${formatNumber(source.sizeBytes)} bytes`}
            valueAfterLabel
          />
          {summary !== null && (
            <>
              <span className="source-storage-relation">
                <SummaryFact
                  value={
                    summary.chunkAggregatesComplete
                      ? formatFileSize(summary.uncompressedBytes)
                      : MISSING_FACT
                  }
                  label="Before compression"
                  title={
                    summary.chunkAggregatesComplete
                      ? `${formatNumber(summary.uncompressedBytes)} bytes`
                      : undefined
                  }
                  valueAfterLabel
                />
                <span aria-hidden="true">→</span>
                <span className="visually-hidden">becomes</span>
                <SummaryFact
                  value={
                    summary.chunkAggregatesComplete
                      ? formatFileSize(summary.compressedBytes)
                      : MISSING_FACT
                  }
                  label="Column data on disk"
                  title={
                    summary.chunkAggregatesComplete
                      ? `${formatNumber(summary.compressedBytes)} bytes`
                      : undefined
                  }
                  valueAfterLabel
                />
                <span className="source-storage-context">
                  ·{" "}
                  {summary.codecs === null
                    ? MISSING_FACT
                    : formatCodecs(summary.codecs)}{" "}
                  ·{" "}
                  <StructureHelp term="Compression ratio">
                    {summary.chunkAggregatesComplete
                      ? formatRatio(summary.compressionRatio)
                      : MISSING_FACT}
                  </StructureHelp>
                </span>
              </span>
              <SummaryFact
                value={formatFileSize(summary.footerBytes)}
                label={<StructureHelp term="Footer" />}
                title={`${formatNumber(summary.footerBytes)} bytes`}
                valueAfterLabel
              />
            </>
          )}
        </dd>
      </div>
      {summary !== null && (
        <div className="source-summary-row">
          <dt>Metadata</dt>
          <dd className="source-summary-inline">
            <SummaryFact
              value={formatNumber(summary.formatVersion)}
              label={<StructureHelp term="Parquet metadata version" />}
              valueAfterLabel
            />
            <SummaryFact
              value={summary.createdBy ?? MISSING_FACT}
              label="Writer"
              valueAfterLabel
            />
          </dd>
        </div>
      )}
    </dl>
  );
}

function SelectedFileFacts({ summary }: { summary: StructureSummary | null }) {
  return (
    <dl className="source-summary" aria-label="Selected file facts">
      <div className="source-summary-row">
        <dt>Selected file</dt>
        <dd className="source-summary-inline">
          <SummaryFact
            value={
              summary === null ? MISSING_FACT : formatNumber(summary.rowCount)
            }
            label="rows"
          />
          <SummaryFact
            value={
              summary === null
                ? MISSING_FACT
                : formatNumber(summary.columnCount)
            }
            label="columns"
          />
          <SummaryFact
            value={
              summary === null
                ? MISSING_FACT
                : formatNumber(summary.rowGroupCount)
            }
            label={<StructureHelp term="Row groups">row groups</StructureHelp>}
          />
          <SummaryFact
            value={formatRowsPerRowGroup(summary?.rowsPerRowGroup ?? null)}
            label={
              <StructureHelp term="Rows per group">rows/group</StructureHelp>
            }
          />
        </dd>
      </div>
      {summary !== null && (
        <>
          <div className="source-summary-row">
            <dt>
              <StructureHelp term="Storage" />
            </dt>
            <dd className="source-storage-summary">
              <span className="source-storage-relation">
                <SummaryFact
                  value={
                    summary.chunkAggregatesComplete
                      ? formatFileSize(summary.uncompressedBytes)
                      : MISSING_FACT
                  }
                  label="Before compression"
                  title={
                    summary.chunkAggregatesComplete
                      ? `${formatNumber(summary.uncompressedBytes)} bytes`
                      : undefined
                  }
                  valueAfterLabel
                />
                <span aria-hidden="true">→</span>
                <span className="visually-hidden">becomes</span>
                <SummaryFact
                  value={
                    summary.chunkAggregatesComplete
                      ? formatFileSize(summary.compressedBytes)
                      : MISSING_FACT
                  }
                  label="Column data on disk"
                  title={
                    summary.chunkAggregatesComplete
                      ? `${formatNumber(summary.compressedBytes)} bytes`
                      : undefined
                  }
                  valueAfterLabel
                />
                <span className="source-storage-context">
                  ·{" "}
                  {summary.codecs === null
                    ? MISSING_FACT
                    : formatCodecs(summary.codecs)}{" "}
                  ·{" "}
                  <StructureHelp term="Compression ratio">
                    {summary.chunkAggregatesComplete
                      ? formatRatio(summary.compressionRatio)
                      : MISSING_FACT}
                  </StructureHelp>
                </span>
              </span>
              <SummaryFact
                value={formatFileSize(summary.footerBytes)}
                label={<StructureHelp term="Footer" />}
                title={`${formatNumber(summary.footerBytes)} bytes`}
                valueAfterLabel
              />
            </dd>
          </div>
          <div className="source-summary-row">
            <dt>Metadata</dt>
            <dd className="source-summary-inline">
              <SummaryFact
                value={formatNumber(summary.formatVersion)}
                label={<StructureHelp term="Parquet metadata version" />}
                valueAfterLabel
              />
              <SummaryFact
                value={summary.createdBy ?? MISSING_FACT}
                label="Writer"
                valueAfterLabel
              />
            </dd>
          </div>
        </>
      )}
    </dl>
  );
}

function SummaryFact({
  value,
  label,
  title,
  valueAfterLabel = false,
}: {
  value: string;
  label: ReactNode;
  title?: string;
  valueAfterLabel?: boolean;
}) {
  return (
    <span className="source-summary-fact">
      {valueAfterLabel && (
        <>
          <span>{label}</span>{" "}
        </>
      )}
      <strong className="is-technical" title={title}>
        {value}
      </strong>
      {!valueAfterLabel && (
        <>
          {" "}
          <span>{label}</span>
        </>
      )}
    </span>
  );
}

/**
 * Chooses the unit every ranked byte figure in the mode is read in.
 *
 * The file card shows both totals because on-disk against uncompressed is the
 * comparison it exists to make; everything that ranks or sizes follows this.
 */
export function StructureUnitToggle({
  unit,
  onUnit,
}: {
  unit: StructureByteUnit;
  onUnit: (unit: StructureByteUnit) => void;
}) {
  return (
    <div className="size-control">
      <span>Size:</span>
      <div className="unit-toggle" role="group" aria-label="Size">
        <button
          type="button"
          aria-pressed={unit === "compressed"}
          onClick={() => onUnit("compressed")}
        >
          On disk
        </button>
        <button
          type="button"
          aria-pressed={unit === "uncompressed"}
          onClick={() => onUnit("uncompressed")}
        >
          Before compression
        </button>
      </div>
    </div>
  );
}

export function StructureLoadStatus({
  state,
  onCancel,
  onRetry,
}: {
  state: StructureSummaryState;
  onCancel: () => void;
  onRetry: () => void;
}) {
  if (state.kind === "ready" && state.refreshing) {
    return (
      <p className="visually-hidden" role="status" aria-live="polite">
        Refreshing file structure…
      </p>
    );
  }

  if (state.kind === "loading") {
    const chunkTotal = state.progress?.totalChunks ?? 0;
    const total = chunkTotal || state.progress?.totalRowGroups || 0;
    const completed = chunkTotal
      ? (state.progress?.completedChunks ?? 0)
      : (state.progress?.completedRowGroups ?? 0);
    const itemLabel = chunkTotal ? "column chunks" : "row groups";
    return (
      <section className="structure-status" aria-label="Reading file structure">
        <p
          className="structure-status-message"
          role="status"
          aria-live="polite"
        >
          {total === 0
            ? "Reading the Parquet footer…"
            : `Summarizing ${formatNumber(completed)} of ${formatNumber(total)} ${itemLabel}…`}
        </p>
        {total === 0 ? (
          <progress aria-label="Reading the Parquet footer" />
        ) : (
          <progress
            aria-label={`Summarizing ${itemLabel}`}
            value={completed}
            max={total}
          />
        )}
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </section>
    );
  }

  if (state.kind === "cancelled") {
    return (
      <section className="structure-status" aria-label="File structure">
        <p className="structure-status-message">
          Reading the structure was cancelled.
        </p>
        <button type="button" onClick={onRetry}>
          Read again
        </button>
      </section>
    );
  }

  if (state.kind === "error") {
    return (
      <section className="structure-status" aria-label="File structure">
        <p className="structure-status-error" role="alert">
          {state.message}
        </p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </section>
    );
  }

  return null;
}
