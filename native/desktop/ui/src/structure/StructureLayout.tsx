import { useEffect, useMemo, useRef, useState } from "react";

import {
  getStructureLayout,
  getStructureLensTotals,
  type StructureByteUnit,
  type StructureLayout,
  type StructureLayoutOverviewBucket,
  type StructureLayoutRow,
  type StructureLayoutSegment,
  type StructureLayoutTail,
  type StructureLensTotal,
  type StructureLensTotals,
  type StructureSummary,
} from "../desktop";
import { ChunkPanel, type SelectedChunk } from "./ChunkPanel";
import { StructureUnitToggle } from "./StructureCard";
import {
  bytesForUnit,
  formatCoverage,
  formatFileSize,
  formatNumber,
  formatRatio,
  formatShare,
  MISSING_FACT,
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

type LayoutRequestState =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "ready"; key: string; value: StructureLayout }
  | { kind: "error"; key: string; message: string };

export function StructureLayoutView({
  generation,
  summary,
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
  summary: StructureSummary;
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
  const [layoutState, setLayoutState] = useState<LayoutRequestState>({
    kind: "idle",
  });
  const [totals, setTotals] = useState<StructureLensTotals | null>(null);
  const [selected, setSelected] = useState<SelectedChunk | null>(null);
  const [mapRequested, setMapRequested] = useState(false);
  const chunkTrigger = useRef<HTMLButtonElement | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [lensError, setLensError] = useState<string | null>(null);
  const visibleHighlight = hoveredColumn ?? highlightedColumn;
  const layoutRequestKey = [
    generation,
    unit,
    offset,
    highlightedColumn ?? "none",
  ].join(":");

  useEffect(() => {
    if (summary.codecs === null) {
      setTotals(null);
      setLensError(null);
      return;
    }
    let active = true;
    setTotals(null);
    setLensError(null);
    void getStructureLensTotals(generation).then(
      (value) => active && setTotals(value),
      (reason: unknown) =>
        active && setLensError(structureErrorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [generation, summary.codecs]);

  useEffect(() => {
    if (!mapRequested) {
      return;
    }
    let active = true;
    const key = layoutRequestKey;
    setLayoutState({ kind: "loading", key });
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
          setLayoutState({ kind: "ready", key, value: layout });
        }
      },
      (reason: unknown) =>
        active &&
        setLayoutState({
          kind: "error",
          key,
          message: structureErrorMessage(reason),
        }),
    );
    return () => {
      active = false;
    };
  }, [
    generation,
    highlightedColumn,
    layoutRequestKey,
    mapRequested,
    offset,
    unit,
  ]);

  const codecColors = useMemo(() => {
    const entries = totals?.codecs ?? [];
    return new Map(
      entries.map((entry, index) => [
        entry.codec,
        CODEC_COLORS[index % CODEC_COLORS.length] ?? DEFAULT_CODEC_COLOR,
      ]),
    );
  }, [totals]);
  const committedLayout =
    layoutState.kind === "ready" && layoutState.key === layoutRequestKey
      ? layoutState.value
      : null;
  const layoutError =
    layoutState.kind === "error" && layoutState.key === layoutRequestKey
      ? layoutState.message
      : null;
  const layoutLoading =
    mapRequested &&
    (layoutState.kind === "idle" ||
      layoutState.key !== layoutRequestKey ||
      layoutState.kind === "loading");
  const rows = committedLayout?.rows ?? [];
  const columns = committedLayout?.columns ?? [];
  const overview = committedLayout?.overview ?? [];
  const remainingColumnCount = committedLayout?.remainingColumnCount ?? 0;
  const selectedColumn = columns.find(
    (column) => column.columnIndex === highlightedColumn,
  );
  const matrixColumns = columns.length + Number(remainingColumnCount > 0);
  const minRowGroupBytes =
    unit === "compressed"
      ? summary.minRowGroupCompressedBytes
      : summary.minRowGroupUncompressedBytes;
  const maxRowGroupBytes =
    unit === "compressed"
      ? summary.maxRowGroupCompressedBytes
      : summary.maxRowGroupUncompressedBytes;

  return (
    <section className="structure-card layout-card" aria-label="Chunk overview">
      <div className="structure-card-heading layout-heading">
        <div>
          <h2>Chunk overview</h2>
          <span className="structure-card-caption">
            How chunks are distributed across the file
          </span>
        </div>
        <StructureUnitToggle unit={unit} onUnit={onUnit} />
      </div>
      <dl className="chunk-overview-facts" aria-label="Chunk facts">
        <div>
          <dt>Shape</dt>
          <dd>
            {formatCount(summary.rowGroupCount, "row group")} ×{" "}
            {formatCount(summary.columnCount, "column")} ·{" "}
            {formatCount(summary.chunkCount, "chunk")}
          </dd>
        </div>
        <div>
          <dt>Rows per row group</dt>
          <dd>
            {formatRange(
              summary.minRowGroupRows,
              summary.maxRowGroupRows,
              formatNumber,
            )}
          </dd>
        </div>
        <div>
          <dt>
            {unit === "compressed"
              ? "Column data on disk"
              : "Before compression"}{" "}
            per row group
          </dt>
          <dd>
            {formatRange(minRowGroupBytes, maxRowGroupBytes, formatFileSize)}
          </dd>
        </div>
        <div>
          <dt>Codecs</dt>
          <dd className="chunk-codec-distribution">
            {summary.codecs === null
              ? MISSING_FACT
              : lensError !== null
                ? MISSING_FACT
                : totals === null
                  ? "Reading…"
                  : totals.codecs.length === 0
                    ? MISSING_FACT
                    : totals.codecs.map(({ codec, total }) => (
                        <span key={codec}>
                          {codec.toLowerCase()}{" "}
                          {formatCoverage(total.chunkCount, summary.chunkCount)}
                        </span>
                      ))}
          </dd>
        </div>
        <div>
          <dt>
            <StructureHelp term="Statistics" />
          </dt>
          <dd>
            {formatCoverage(summary.chunksWithStatistics, summary.chunkCount)}
          </dd>
        </div>
        <div>
          <dt>
            <StructureHelp term="Bloom filter">Bloom filters</StructureHelp>
          </dt>
          <dd>
            {formatCoverage(summary.chunksWithBloomFilter, summary.chunkCount)}
          </dd>
        </div>
        {summary.unreadableRowGroupCount > 0 && (
          <div>
            <dt>Local data pages</dt>
            <dd>
              {formatNumber(
                summary.rowGroupCount - summary.unreadableRowGroupCount,
              )}{" "}
              of {formatCount(summary.rowGroupCount, "row group")} readable
            </dd>
          </div>
        )}
      </dl>
      {lensError !== null && (
        <p className="structure-status-error" role="alert">
          {lensError}
        </p>
      )}
      <details
        className="chunk-map-details"
        onToggle={(event) => {
          if (event.currentTarget.open) setMapRequested(true);
        }}
      >
        <summary>Inspect chunk map</summary>
        {mapRequested && (
          <div className="chunk-map">
            <div className="chunk-map-heading">
              <p>Compare individual column chunks across row groups.</p>
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
            <div className="layout-guide" aria-label="Layout scale and legend">
              <p className="layout-scale">
                Equal cells keep each column at the same position in every row
                group.
              </p>
              {summary.codecs === null ? (
                <span className="layout-scale">
                  Legend unavailable because some chunk metadata cannot be read.
                </span>
              ) : (
                <LensLegend
                  lens={lens}
                  totals={totals}
                  unit={unit}
                  codecColors={codecColors}
                />
              )}
            </div>
            {layoutLoading && <p role="status">Reading chunk map…</p>}
            {layoutError !== null && (
              <p className="structure-status-error" role="alert">
                {layoutError}
              </p>
            )}
            {committedLayout !== null && rowGroupCount > ROW_WINDOW && (
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
            {committedLayout !== null && highlightedColumn !== null && (
              <div className="layout-selection" role="status">
                <span>
                  Selected column:{" "}
                  {selectedColumn === undefined
                    ? `#${highlightedColumn + 1}`
                    : columnIdentity(
                        selectedColumn.columnIndex,
                        selectedColumn.columnName,
                        summary.columnPathsTruncated,
                      )}
                </span>
                <button type="button" onClick={() => onHighlightColumn(null)}>
                  Clear
                </button>
              </div>
            )}
            {committedLayout !== null && (
              <>
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
                        title={columnIdentity(
                          columnIndex,
                          columnName,
                          summary.columnPathsTruncated,
                        )}
                      >
                        {columnIdentity(
                          columnIndex,
                          columnName,
                          summary.columnPathsTruncated,
                        )}
                      </button>
                    ))}
                    {remainingColumnCount > 0 && (
                      <span
                        className="layout-axis-aggregate"
                        title={`${otherColumnsLabel(remainingColumnCount)} outside the named slots`}
                        aria-label={`Aggregate for ${otherColumnsLabel(remainingColumnCount)}`}
                        tabIndex={0}
                      >
                        {otherColumnsLabel(remainingColumnCount)}
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
                      showColumnIndex={summary.columnPathsTruncated}
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
              </>
            )}
            {selected !== null && (
              <ChunkPanel
                generation={generation}
                selected={selected}
                showColumnIndex={summary.columnPathsTruncated}
                onClose={() => {
                  setSelected(null);
                  chunkTrigger.current?.focus();
                }}
              />
            )}
          </div>
        )}
      </details>
    </section>
  );
}

function LayoutRow({
  row,
  unit,
  lens,
  codecColors,
  showColumnIndex,
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
  showColumnIndex: boolean;
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
            title={segmentTooltip(segment, unit, showColumnIndex)}
            aria-label={segmentAccessibleDescription(
              segment,
              unit,
              lens,
              showColumnIndex,
            )}
          >
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
            {otherColumnsLabel(row.tail.columnCount)}
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
  showColumnIndex: boolean,
): string {
  return `${columnIdentity(segment.columnIndex, segment.columnName, showColumnIndex)}\n${unit === "compressed" ? "On disk" : "Before compression"}: ${formatFileSize(bytesForUnit(segment, unit))} · ${formatShare(segment.share)} of row group\nOn disk ${formatFileSize(segment.compressedBytes)} · Before compression ${formatFileSize(segment.uncompressedBytes)} · ${formatRatio(segment.compressionRatio)}\n${segment.codec} · ${formatEncodings(segment.encodings)}\nStatistics: ${segment.hasStatistics ? "present" : "absent"} · Bloom: ${segment.hasBloomFilter ? "present" : "absent"} · Page index: ${segment.hasPageIndex ? "present" : "absent"}`;
}

function segmentAccessibleDescription(
  segment: StructureLayoutSegment,
  unit: StructureByteUnit,
  lens: StructureLens,
  showColumnIndex: boolean,
): string {
  const lensDescription =
    lens === "codec"
      ? `Codec ${segment.codec}`
      : lens === "presence"
        ? `Statistics ${segment.hasStatistics ? "present" : "absent"}`
        : `Compression ${formatRatio(segment.compressionRatio)}`;
  return `${columnIdentity(segment.columnIndex, segment.columnName, showColumnIndex)}, ${unit === "compressed" ? "on disk" : "before compression"} ${formatFileSize(bytesForUnit(segment, unit))}, ${lensDescription}, Bloom filter ${segment.hasBloomFilter ? "present" : "absent"}`;
}

function columnIdentity(
  index: number,
  name: string,
  showColumnIndex: boolean,
): string {
  return showColumnIndex ? `#${formatNumber(index + 1)} · ${name}` : name;
}

function remainingTooltip(
  tail: StructureLayoutTail,
  unit: StructureByteUnit,
): string {
  return `Aggregate for ${otherColumnsLabel(tail.columnCount)}\n${unit === "compressed" ? "On disk" : "Before compression"}: ${formatFileSize(bytesForUnit(tail, unit))} · ${formatShare(tail.share)} of row group\nOn disk ${formatFileSize(tail.compressedBytes)} · Before compression ${formatFileSize(tail.uncompressedBytes)}\nBloom filters: ${tail.hasBloomFilter ? "at least one" : "none"}`;
}

function otherColumnsLabel(count: number): string {
  return `${formatNumber(count)} other ${count === 1 ? "column" : "columns"}`;
}

function formatRange(
  minimum: number | null,
  maximum: number | null,
  format: (value: number) => string,
): string {
  if (minimum === null || maximum === null) return MISSING_FACT;
  return minimum === maximum
    ? format(minimum)
    : `${format(minimum)}–${format(maximum)}`;
}

function formatCount(value: number, singular: string): string {
  return `${formatNumber(value)} ${singular}${value === 1 ? "" : "s"}`;
}

function formatEncodings(encodings: string[]): string {
  return encodings.length === 0 ? "—" : encodings.join(" + ").toLowerCase();
}
