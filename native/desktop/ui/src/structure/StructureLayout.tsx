import { useEffect, useMemo, useRef, useState } from "react";

import {
  getStructureLayout,
  getStructureLensTotals,
  type StructureByteUnit,
  type StructureLayoutColumn,
  type StructureLayoutRow,
  type StructureLayoutOverviewBucket,
  type StructureLayoutSegment,
  type StructureLayoutTail,
  type StructureLensTotal,
  type StructureLensTotals,
} from "../desktop";
import { ChunkPanel, type SelectedChunk } from "./ChunkPanel";
import { StructureUnitToggle } from "./StructureCard";
import {
  bytesForUnit,
  formatFileSize,
  formatNumber,
  formatRatio,
  formatShare,
} from "./format";
import { StructureHelp } from "./StructureHelp";
import { structureErrorMessage } from "./use-structure-summary";

export type StructureLens = "ratio" | "codec" | "presence";

const ROW_WINDOW = 80;
const COLUMN_LIMIT = 12;
const CODEC_COLORS = [
  "#537b91",
  "#617d68",
  "#806b87",
  "#857149",
  "#5b7976",
  "#87666b",
  "#676f8d",
  "#74794f",
];
const DEFAULT_CODEC_COLOR = "#6d7573";
const UNRATED_COLOR = "#707570";
const STATISTICS_PRESENT_COLOR = "#526b5a";
const STATISTICS_ABSENT_COLOR = "#765f5f";

export function StructureLayoutView({
  generation,
  unit,
  onUnit,
  rowGroupCount,
  dataAvailable = true,
  highlightedColumn,
  onHighlightColumn,
  selectedRow,
  onSelectRow,
  onOpenRow,
}: {
  generation: number;
  unit: StructureByteUnit;
  onUnit: (unit: StructureByteUnit) => void;
  rowGroupCount: number;
  dataAvailable?: boolean;
  highlightedColumn: number | null;
  onHighlightColumn: (column: number | null) => void;
  selectedRow: number | null;
  onSelectRow: (rowGroupIndex: number) => void;
  onOpenRow: (rowGroupIndex: number) => void;
}) {
  const [lens, setLens] = useState<StructureLens>("ratio");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<StructureLayoutRow[]>([]);
  const [columns, setColumns] = useState<StructureLayoutColumn[]>([]);
  const [remainingColumnCount, setRemainingColumnCount] = useState(0);
  const [overview, setOverview] = useState<StructureLayoutOverviewBucket[]>([]);
  const [totals, setTotals] = useState<StructureLensTotals | null>(null);
  const [selected, setSelected] = useState<SelectedChunk | null>(null);
  const chunkTrigger = useRef<HTMLButtonElement | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleHighlight = hoveredColumn ?? highlightedColumn;

  useEffect(() => {
    let active = true;
    void getStructureLensTotals(generation).then(
      (value) => active && setTotals(value),
      (reason: unknown) => active && setError(structureErrorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [generation]);

  useEffect(() => {
    let active = true;
    setError(null);
    void getStructureLayout(
      generation,
      unit,
      offset,
      ROW_WINDOW,
      COLUMN_LIMIT,
      highlightedColumn,
    ).then(
      (layout) => {
        if (active) {
          setRows(layout.rows);
          setColumns(layout.columns);
          setRemainingColumnCount(layout.remainingColumnCount);
          setOverview(layout.overview);
        }
      },
      (reason: unknown) => active && setError(structureErrorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [generation, highlightedColumn, offset, unit]);

  const codecColors = useMemo(() => {
    const entries = totals?.codecs ?? [];
    return new Map(
      entries.map((entry, index) => [
        entry.codec,
        CODEC_COLORS[index % CODEC_COLORS.length] ?? DEFAULT_CODEC_COLOR,
      ]),
    );
  }, [totals]);
  const selectedColumnName = columns.find(
    (column) => column.columnIndex === highlightedColumn,
  )?.columnName;
  const matrixColumns = columns.length + Number(remainingColumnCount > 0);

  return (
    <section
      className="structure-card layout-card"
      aria-label="Physical layout"
    >
      <div className="structure-card-heading layout-heading">
        <div>
          <h2>Physical layout</h2>
          <span className="structure-card-caption">
            Row group × column chunk
          </span>
        </div>
        <div className="layout-controls">
          <StructureUnitToggle unit={unit} onUnit={onUnit} />
          <div className="color-control">
            <span>Color by:</span>
            <div className="lens-toggle" role="group" aria-label="Color by">
              <StructureHelp
                term="Ratio"
                button={{
                  pressed: lens === "ratio",
                  onClick: () => setLens("ratio"),
                }}
              >
                Compression
              </StructureHelp>
              <StructureHelp
                term="Codec"
                button={{
                  pressed: lens === "codec",
                  onClick: () => setLens("codec"),
                }}
              />
              <StructureHelp
                term="Stats & bloom"
                button={{
                  pressed: lens === "presence",
                  onClick: () => setLens("presence"),
                }}
              >
                Statistics
              </StructureHelp>
            </div>
          </div>
        </div>
      </div>
      {error !== null && <p className="structure-status-error">{error}</p>}
      <div className="layout-guide" aria-label="Layout scale and legend">
        <p className="layout-scale">
          Equal cells keep each column at the same position in every row group.
        </p>
        <LensLegend
          lens={lens}
          totals={totals}
          unit={unit}
          codecColors={codecColors}
        />
      </div>
      {rowGroupCount > ROW_WINDOW && (
        <Minimap
          total={rowGroupCount}
          offset={offset}
          count={rows.length}
          overview={overview}
          highlightColumn={highlightedColumn !== null}
          unit={unit}
          lens={lens}
          codecColors={codecColors}
          onOffset={(next) =>
            setOffset(
              Math.min(
                Math.max(0, next),
                Math.max(0, rowGroupCount - ROW_WINDOW),
              ),
            )
          }
        />
      )}
      {highlightedColumn !== null && (
        <div className="layout-selection" role="status">
          <span>
            Selected column: {selectedColumnName ?? `#${highlightedColumn}`}
          </span>
          <button type="button" onClick={() => onHighlightColumn(null)}>
            Clear
          </button>
        </div>
      )}
      <div className="layout-axis" aria-label="Column axis">
        <span>Columns</span>
        <div
          className="layout-axis-items"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, matrixColumns)}, minmax(0, 1fr))`,
          }}
        >
          {columns.map(({ columnIndex, columnName }) => (
            <button
              key={columnIndex}
              type="button"
              aria-pressed={highlightedColumn === columnIndex}
              onClick={() => onHighlightColumn(columnIndex)}
              onMouseEnter={() => setHoveredColumn(columnIndex)}
              onMouseLeave={() => setHoveredColumn(null)}
              title={columnName}
            >
              {columnName}
            </button>
          ))}
          {remainingColumnCount > 0 && (
            <span
              title={`${formatNumber(remainingColumnCount)} columns outside the named slots`}
              aria-label={`${formatNumber(remainingColumnCount)} columns outside the named slots`}
              tabIndex={0}
            >
              Remaining {formatNumber(remainingColumnCount)} columns
            </span>
          )}
        </div>
      </div>
      <div className="layout-rows">
        {rows.map((row) => (
          <LayoutRow
            key={row.index}
            row={row}
            unit={unit}
            lens={lens}
            codecColors={codecColors}
            columnCount={matrixColumns}
            highlightedColumn={visibleHighlight}
            selected={selectedRow === row.index}
            dataAvailable={dataAvailable && row.isReadable}
            onHoverColumn={setHoveredColumn}
            onSelectRow={() => onSelectRow(row.index)}
            onOpenRow={() => onOpenRow(row.index)}
            onSelectChunk={(columnIndex, trigger) => {
              chunkTrigger.current = trigger;
              onHighlightColumn(columnIndex);
              onSelectRow(row.index);
              setSelected({ rowGroupIndex: row.index, columnIndex });
            }}
          />
        ))}
      </div>
      {selected !== null && (
        <ChunkPanel
          generation={generation}
          selected={selected}
          onClose={() => {
            setSelected(null);
            chunkTrigger.current?.focus();
          }}
        />
      )}
    </section>
  );
}

function LayoutRow({
  row,
  unit,
  lens,
  codecColors,
  columnCount,
  highlightedColumn,
  selected,
  dataAvailable,
  onHoverColumn,
  onSelectRow,
  onOpenRow,
  onSelectChunk,
}: {
  row: StructureLayoutRow;
  unit: StructureByteUnit;
  lens: StructureLens;
  codecColors: ReadonlyMap<string, string>;
  columnCount: number;
  highlightedColumn: number | null;
  selected: boolean;
  dataAvailable: boolean;
  onHoverColumn: (column: number | null) => void;
  onSelectRow: () => void;
  onOpenRow: () => void;
  onSelectChunk: (column: number, trigger: HTMLButtonElement) => void;
}) {
  const bytes = bytesForUnit(row, unit);
  return (
    <div
      className={`layout-row${!row.isReadable ? " is-unreadable" : ""}${!row.hasLayoutFacts ? " is-footer-unavailable" : ""}${selected ? " is-selected" : ""}`}
    >
      <button
        className="layout-row-label"
        type="button"
        onClick={onSelectRow}
        onDoubleClick={dataAvailable ? onOpenRow : undefined}
        onKeyDown={(event) => {
          if (dataAvailable && event.key === "Enter") {
            onOpenRow();
          }
        }}
        title={
          dataAvailable
            ? "Click for details; double-click or press Enter to open this row group in Data"
            : "Data navigation is unavailable for this row group"
        }
      >
        RG {formatNumber(row.index)}
      </button>
      <div
        className="layout-row-track"
        style={{
          gridTemplateColumns: `repeat(${Math.max(1, columnCount)}, minmax(0, 1fr))`,
        }}
      >
        {row.segments.map((segment) => (
          <button
            key={segment.columnIndex}
            type="button"
            className={`layout-segment${highlightedColumn === segment.columnIndex ? " is-highlighted" : ""}`}
            style={{ background: segmentColor(segment, lens, codecColors) }}
            onClick={(event) =>
              onSelectChunk(segment.columnIndex, event.currentTarget)
            }
            onMouseEnter={() => onHoverColumn(segment.columnIndex)}
            onMouseLeave={() => onHoverColumn(null)}
            title={segmentTooltip(segment, unit)}
            aria-label={segmentAccessibleDescription(segment, unit, lens)}
          >
            <span>{segment.columnName}</span>
            {segment.hasBloomFilter && <i aria-hidden="true" />}
          </button>
        ))}
        {!row.hasLayoutFacts && (
          <span className="layout-unreadable-label">
            Footer facts unavailable
          </span>
        )}
        {row.hasLayoutFacts && !row.isReadable && (
          <span className="layout-unreadable-label">
            Data pages unavailable
          </span>
        )}
        {row.tail !== null && (
          <span
            className="layout-tail"
            title={remainingTooltip(row.tail, unit)}
            aria-label={remainingTooltip(row.tail, unit)}
            tabIndex={0}
          >
            Remaining {formatNumber(row.tail.columnCount)} columns
            {row.tail.hasBloomFilter && <i aria-label="Bloom filter" />}
          </span>
        )}
      </div>
      <span className="layout-row-bytes">
        {row.hasLayoutFacts ? formatFileSize(bytes) : "—"}
      </span>
    </div>
  );
}

function Minimap({
  total,
  offset,
  count,
  overview,
  highlightColumn,
  unit,
  lens,
  codecColors,
  onOffset,
}: {
  total: number;
  offset: number;
  count: number;
  overview: StructureLayoutOverviewBucket[];
  highlightColumn: boolean;
  unit: StructureByteUnit;
  lens: StructureLens;
  codecColors: ReadonlyMap<string, string>;
  onOffset: (offset: number) => void;
}) {
  return (
    <div
      className="layout-minimap"
      aria-label="Row group minimap"
      role="scrollbar"
      aria-orientation="horizontal"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, total - count)}
      aria-valuenow={offset}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        onOffset(
          Math.round(
            ((event.clientX - bounds.left) / Math.max(1, bounds.width)) *
              Math.max(0, total - count),
          ),
        );
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          onOffset(offset - 1);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          onOffset(offset + 1);
        } else if (event.key === "PageUp") {
          event.preventDefault();
          onOffset(offset - count);
        } else if (event.key === "PageDown") {
          event.preventDefault();
          onOffset(offset + count);
        } else if (event.key === "Home") {
          event.preventDefault();
          onOffset(0);
        } else if (event.key === "End") {
          event.preventDefault();
          onOffset(total - count);
        }
      }}
    >
      {overview.map((bucket) => {
        return (
          <span
            key={bucket.rowStart}
            className={bucket.hasBloomFilter ? "has-bloom-filter" : undefined}
            style={{
              left: `${(bucket.rowStart / total) * 100}%`,
              width: `${Math.max(0.25, ((bucket.rowEnd - bucket.rowStart) / total) * 100)}%`,
              background: overviewColor(bucket, unit, lens, codecColors),
              opacity: bytesForUnit(bucket, unit) === 0 ? 0.35 : 1,
              outline:
                highlightColumn && focusedBytes(bucket, unit) > 0
                  ? "2px solid var(--layout-outline)"
                  : undefined,
              zIndex: highlightColumn && focusedBytes(bucket, unit) > 0 ? 1 : 0,
            }}
          />
        );
      })}
      <i
        style={{
          left: `${(offset / total) * 100}%`,
          width: `${(count / total) * 100}%`,
        }}
      />
    </div>
  );
}

function focusedBytes(
  bucket: StructureLayoutOverviewBucket,
  unit: StructureByteUnit,
): number {
  return unit === "compressed"
    ? bucket.focusedCompressedBytes
    : bucket.focusedUncompressedBytes;
}

function overviewColor(
  bucket: StructureLayoutOverviewBucket,
  unit: StructureByteUnit,
  lens: StructureLens,
  codecColors: ReadonlyMap<string, string>,
): string {
  if (lens === "codec") {
    const codec =
      unit === "compressed"
        ? bucket.dominantCodecCompressed
        : bucket.dominantCodecUncompressed;
    return codec === null
      ? "#b8bcbb"
      : (codecColors.get(codec) ?? DEFAULT_CODEC_COLOR);
  }
  if (lens === "presence") {
    const share =
      unit === "compressed"
        ? bucket.statisticsShareCompressed
        : bucket.statisticsShareUncompressed;
    return share >= 0.5 ? STATISTICS_PRESENT_COLOR : STATISTICS_ABSENT_COLOR;
  }
  const ratioStep =
    unit === "compressed"
      ? bucket.dominantRatioStepCompressed
      : bucket.dominantRatioStepUncompressed;
  return ratioStep === null ? UNRATED_COLOR : ratioColor(ratioStep);
}

function LensLegend({
  lens,
  totals,
  unit,
  codecColors,
}: {
  lens: StructureLens;
  totals: StructureLensTotals | null;
  unit: StructureByteUnit;
  codecColors: ReadonlyMap<string, string>;
}) {
  if (totals === null) return null;
  const colorEntries: {
    label: string;
    color: string;
    total: StructureLensTotal;
    marker?: "dot";
  }[] =
    lens === "codec"
      ? totals.codecs.map(({ codec, total }) => ({
          label: codec,
          color: codecColors.get(codec) ?? DEFAULT_CODEC_COLOR,
          total,
        }))
      : lens === "presence"
        ? [
            {
              label: "Statistics present",
              color: STATISTICS_PRESENT_COLOR,
              total: totals.statistics.present,
            },
            {
              label: "Statistics absent",
              color: STATISTICS_ABSENT_COLOR,
              total: totals.statistics.absent,
            },
          ]
        : [
            ...totals.ratioSteps.map(({ maxRatio, total }, index) => ({
              label: maxRatio === null ? "> ×10" : `≤ ×${maxRatio}`,
              color: ratioColor(index),
              total,
            })),
            {
              label: "No stored bytes",
              color: UNRATED_COLOR,
              total: totals.unrated,
            },
          ];
  const entries = [
    ...colorEntries,
    {
      label: "Bloom filter",
      color: "var(--bloom-marker)",
      total: totals.bloomFilters.present,
      marker: "dot" as const,
    },
  ];
  return (
    <div className="layout-legend" aria-label="Active lens legend">
      {entries.map((entry) => (
        <span key={entry.label}>
          <i
            className={entry.marker === "dot" ? "is-dot" : undefined}
            style={{ background: entry.color }}
          />
          {entry.label} · {formatFileSize(bytesForUnit(entry.total, unit))}
        </span>
      ))}
    </div>
  );
}

function segmentColor(
  segment: StructureLayoutSegment,
  lens: StructureLens,
  codecColors: ReadonlyMap<string, string>,
): string {
  if (lens === "codec")
    return codecColors.get(segment.codec) ?? DEFAULT_CODEC_COLOR;
  if (lens === "presence")
    return segment.hasStatistics
      ? STATISTICS_PRESENT_COLOR
      : STATISTICS_ABSENT_COLOR;
  const ratio = segment.compressionRatio;
  return ratio === null
    ? UNRATED_COLOR
    : ratio <= 1.1
      ? ratioColor(0)
      : ratio <= 2
        ? ratioColor(1)
        : ratio <= 4
          ? ratioColor(2)
          : ratio <= 10
            ? ratioColor(3)
            : ratioColor(4);
}

function ratioColor(step: number): string {
  return (
    ["#7b6d67", "#6d7573", "#5b7976", "#60788a", "#596f86"][step] ?? "#596f86"
  );
}

function segmentTooltip(
  segment: StructureLayoutSegment,
  unit: StructureByteUnit,
): string {
  return `${segment.columnName}\n${unit === "compressed" ? "On disk" : "Before compression"}: ${formatFileSize(bytesForUnit(segment, unit))} · ${formatShare(segment.share)} of row group\nOn disk ${formatFileSize(segment.compressedBytes)} · Before compression ${formatFileSize(segment.uncompressedBytes)} · ${formatRatio(segment.compressionRatio)}\n${segment.codec} · ${formatEncodings(segment.encodings)}\nStatistics: ${segment.hasStatistics ? "present" : "absent"} · Bloom: ${segment.hasBloomFilter ? "present" : "absent"} · Page index: ${segment.hasPageIndex ? "present" : "absent"}`;
}

function segmentAccessibleDescription(
  segment: StructureLayoutSegment,
  unit: StructureByteUnit,
  lens: StructureLens,
): string {
  const lensDescription =
    lens === "codec"
      ? `Codec ${segment.codec}`
      : lens === "presence"
        ? `Statistics ${segment.hasStatistics ? "present" : "absent"}`
        : `Compression ${formatRatio(segment.compressionRatio)}`;
  return `${segment.columnName}, ${unit === "compressed" ? "on disk" : "before compression"} ${formatFileSize(bytesForUnit(segment, unit))}, ${lensDescription}, Bloom filter ${segment.hasBloomFilter ? "present" : "absent"}`;
}

function remainingTooltip(
  tail: StructureLayoutTail,
  unit: StructureByteUnit,
): string {
  return `Remaining ${formatNumber(tail.columnCount)} columns\n${unit === "compressed" ? "On disk" : "Before compression"}: ${formatFileSize(bytesForUnit(tail, unit))} · ${formatShare(tail.share)} of row group\nOn disk ${formatFileSize(tail.compressedBytes)} · Before compression ${formatFileSize(tail.uncompressedBytes)}\nBloom filters: ${tail.hasBloomFilter ? "at least one" : "none"}`;
}

function formatEncodings(encodings: string[]): string {
  return encodings.length === 0 ? "—" : encodings.join(" + ").toLowerCase();
}
