import type {
  SourceSummary,
  StructureByteUnit,
  StructureSummary,
} from "../desktop";
import type { ReactNode } from "react";
import {
  formatCodecs,
  formatCoverage,
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
}: {
  source: SourceSummary;
  summary: StructureSummary | null;
}) {
  return (
    <dl className="source-facts" aria-label="File facts">
      <Fact label="Rows" value={formatNumber(source.rowCount)} />
      <Fact
        label={<StructureHelp term="Row groups" />}
        value={formatNumber(source.rowGroupCount)}
      />
      <Fact
        label="Columns"
        value={formatNumber(summary?.columnCount ?? source.schema.length)}
      />
      <Fact
        label={<StructureHelp term="Rows per group" />}
        value={formatRowsPerRowGroup(summary?.rowsPerRowGroup ?? null)}
      />
      <Fact
        label="File size"
        value={formatFileSize(source.sizeBytes)}
        title={`${formatNumber(source.sizeBytes)} bytes`}
      />
      {summary !== null && (
        <>
          <Fact
            label="Stored chunks"
            value={formatFileSize(summary.compressedBytes)}
            title={`${formatNumber(summary.compressedBytes)} bytes`}
          />
          <Fact
            label={
              <StructureHelp term="Compression ratio">
                Uncompressed chunks
              </StructureHelp>
            }
            value={formatFileSize(summary.uncompressedBytes)}
            detail={`${formatRatio(summary.compressionRatio)} of stored chunks`}
            title={`${formatNumber(summary.uncompressedBytes)} bytes`}
          />
          <Fact
            label="Format"
            value={`v${summary.formatVersion}`}
            detail={summary.createdBy ?? MISSING_FACT}
          />
          <Fact
            label={<StructureHelp term="Footer" />}
            value={formatFileSize(summary.footerBytes)}
            title={`${formatNumber(summary.footerBytes)} bytes`}
          />
          <Fact
            label={<StructureHelp term="Codec" />}
            value={formatCodecs(summary.codecs)}
          />
          <Fact
            label={<StructureHelp term="Statistics" />}
            value={formatCoverage(
              summary.chunksWithStatistics,
              summary.chunkCount,
            )}
          />
          <Fact
            label={
              <StructureHelp term="Bloom filter">Bloom filters</StructureHelp>
            }
            value={formatCoverage(
              summary.chunksWithBloomFilter,
              summary.chunkCount,
            )}
          />
          {summary.unreadableRowGroupCount > 0 && (
            <Fact
              label="Unreadable groups"
              value={formatNumber(summary.unreadableRowGroupCount)}
            />
          )}
        </>
      )}
    </dl>
  );
}

export function Fact({
  label,
  value,
  detail,
  title,
}: {
  label: ReactNode;
  value: string;
  detail?: string;
  title?: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className="fact-value" title={title}>
        {value}
      </dd>
      {detail !== undefined && (
        <dd className="fact-detail" title={detail}>
          {detail}
        </dd>
      )}
    </div>
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
    <div className="unit-toggle" role="group" aria-label="Byte unit">
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
        Uncompressed
      </button>
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
  if (state.kind === "loading") {
    const total = state.progress?.totalRowGroups ?? 0;
    const completed = state.progress?.completedRowGroups ?? 0;
    return (
      <section className="structure-status" aria-label="Reading file structure">
        <p
          className="structure-status-message"
          role="status"
          aria-live="polite"
        >
          {total === 0
            ? "Reading the Parquet footer…"
            : `Summarizing ${formatNumber(completed)} of ${formatNumber(total)} row groups…`}
        </p>
        {total === 0 ? (
          <progress aria-label="Reading the Parquet footer" />
        ) : (
          <progress
            aria-label="Summarizing row groups"
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
