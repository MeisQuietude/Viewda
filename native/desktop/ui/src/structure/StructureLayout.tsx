import { useEffect, useMemo, useRef, useState } from "react";

import {
  getStructureLayout,
  getStructureLensTotals,
  type StructureByteUnit,
  type StructureLayoutRow,
  type StructureLayoutOverviewBucket,
  type StructureLayoutSegment,
  type StructureLensTotal,
  type StructureLensTotals,
} from "../desktop";
import { ChunkPanel, type SelectedChunk } from "./ChunkPanel";
import {
  bytesForUnit,
  formatFileSize,
  formatNumber,
  formatRatio,
} from "./format";
import { StructureHelp } from "./StructureHelp";
import { structureErrorMessage } from "./use-structure-summary";

export type StructureLens = "ratio" | "codec" | "presence";

const ROW_WINDOW = 80;
const SEGMENT_LIMIT = 24;
const MIN_SEGMENT_PIXELS = 4;
const CODEC_COLORS = [
  "#4f7cac",
  "#6f9d72",
  "#9a6fb0",
  "#c18453",
  "#4f9993",
  "#b45f70",
  "#8d7b55",
  "#527f91",
  "#886b87",
  "#7d884e",
];
const DEFAULT_CODEC_COLOR = "#4f7cac";

export function StructureLayoutView({
  generation,
  unit,
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
  const [maximumBytes, setMaximumBytes] = useState(1);
  const [overview, setOverview] = useState<StructureLayoutOverviewBucket[]>([]);
  const [totals, setTotals] = useState<StructureLensTotals | null>(null);
  const [selected, setSelected] = useState<SelectedChunk | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeColumn = hoveredColumn ?? highlightedColumn;

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
      SEGMENT_LIMIT,
      activeColumn,
    ).then(
      (layout) => {
        if (active) {
          setRows(layout.rows);
          setOverview(layout.overview);
          setMaximumBytes(
            Math.max(
              1,
              unit === "compressed"
                ? layout.maxCompressedBytes
                : layout.maxUncompressedBytes,
            ),
          );
        }
      },
      (reason: unknown) => active && setError(structureErrorMessage(reason)),
    );
    return () => {
      active = false;
    };
  }, [activeColumn, generation, offset, unit]);

  const codecColors = useMemo(() => {
    const entries = totals?.codecs ?? [];
    return new Map(
      entries.map((entry, index) => [
        entry.codec,
        CODEC_COLORS[index % CODEC_COLORS.length] ?? DEFAULT_CODEC_COLOR,
      ]),
    );
  }, [totals]);
  const axisColumns = useMemo(() => {
    const columns = new Map<number, string>();
    for (const row of rows) {
      for (const segment of row.segments) {
        columns.set(segment.columnIndex, segment.columnName);
      }
    }
    return [...columns].slice(0, SEGMENT_LIMIT);
  }, [rows]);

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
        <div className="lens-toggle" role="group" aria-label="Color lens">
          <StructureHelp
            term="Ratio"
            button={{
              pressed: lens === "ratio",
              onClick: () => setLens("ratio"),
            }}
          />
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
          />
        </div>
      </div>
      {error !== null && <p className="structure-status-error">{error}</p>}
      {rowGroupCount > ROW_WINDOW && (
        <Minimap
          total={rowGroupCount}
          offset={offset}
          count={rows.length}
          overview={overview}
          highlightColumn={activeColumn !== null}
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
      <div className="layout-axis" aria-label="Column axis">
        {axisColumns.map(([index, name]) => (
          <button
            key={index}
            type="button"
            aria-pressed={highlightedColumn === index}
            onClick={() => onHighlightColumn(index)}
            onMouseEnter={() => setHoveredColumn(index)}
            onMouseLeave={() => setHoveredColumn(null)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="layout-rows">
        {rows.map((row) => (
          <LayoutRow
            key={row.index}
            row={row}
            unit={unit}
            lens={lens}
            codecColors={codecColors}
            maximumBytes={maximumBytes}
            highlightedColumn={activeColumn}
            selected={selectedRow === row.index}
            dataAvailable={dataAvailable && row.isReadable}
            onHoverColumn={setHoveredColumn}
            onSelectRow={() => onSelectRow(row.index)}
            onOpenRow={() => onOpenRow(row.index)}
            onSelectChunk={(columnIndex) => {
              onSelectRow(row.index);
              setSelected({ rowGroupIndex: row.index, columnIndex });
            }}
          />
        ))}
      </div>
      <LensLegend
        lens={lens}
        totals={totals}
        unit={unit}
        codecColors={codecColors}
      />
      {selected !== null && (
        <ChunkPanel
          generation={generation}
          selected={selected}
          onClose={() => setSelected(null)}
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
  maximumBytes,
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
  maximumBytes: number;
  highlightedColumn: number | null;
  selected: boolean;
  dataAvailable: boolean;
  onHoverColumn: (column: number | null) => void;
  onSelectRow: () => void;
  onOpenRow: () => void;
  onSelectChunk: (column: number) => void;
}) {
  const bytes = bytesForUnit(row, unit);
  const track = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(400);
  useEffect(() => {
    if (track.current === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) {
        setTrackWidth(entry.contentRect.width);
      }
    });
    observer.observe(track.current);
    return () => observer.disconnect();
  }, []);
  const { visibleSegments, collapsedTail } = useMemo(
    () => layoutParts(row, unit, trackWidth, highlightedColumn),
    [highlightedColumn, row, trackWidth, unit],
  );
  return (
    <div
      className={`layout-row${!row.isReadable ? " is-unreadable" : ""}${selected ? " is-selected" : ""}`}
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
        ref={track}
        className="layout-row-track"
        style={{ width: `${Math.max(3, (bytes / maximumBytes) * 100)}%` }}
      >
        {visibleSegments.map((segment) => (
          <button
            key={segment.columnIndex}
            type="button"
            className={`layout-segment${highlightedColumn === segment.columnIndex ? " is-highlighted" : ""}`}
            style={{
              flexGrow: Math.max(1, bytesForUnit(segment, unit)),
              flexBasis: 0,
              minWidth:
                highlightedColumn === segment.columnIndex
                  ? MIN_SEGMENT_PIXELS
                  : undefined,
              background: segmentColor(segment, lens, codecColors),
            }}
            onClick={() => onSelectChunk(segment.columnIndex)}
            onMouseEnter={() => onHoverColumn(segment.columnIndex)}
            onMouseLeave={() => onHoverColumn(null)}
            title={segmentTooltip(segment)}
            aria-label={`${segment.columnName}, ${formatFileSize(bytesForUnit(segment, unit))}`}
          >
            <span>{segment.columnName}</span>
            {lens === "presence" && segment.hasBloomFilter && (
              <i aria-label="Bloom filter" />
            )}
          </button>
        ))}
        {!row.isReadable && (
          <span className="layout-unreadable-label">
            Data pages unavailable
          </span>
        )}
        {collapsedTail !== null && (
          <span
            className="layout-tail"
            style={{
              flexBasis: 0,
              flexGrow: Math.max(1, bytesForUnit(collapsedTail, unit)),
            }}
            title={`${formatNumber(collapsedTail.segmentCount)} collapsed columns`}
          >
            + {formatNumber(collapsedTail.segmentCount)} more ·{" "}
            {formatFileSize(bytesForUnit(collapsedTail, unit))}
          </span>
        )}
      </div>
      <span className="layout-row-bytes">{formatFileSize(bytes)}</span>
    </div>
  );
}

function layoutParts(
  row: StructureLayoutRow,
  unit: StructureByteUnit,
  trackWidth: number,
  highlightedColumn: number | null,
) {
  const rowBytes = bytesForUnit(row, unit);
  const visibleSegments: StructureLayoutSegment[] = [];
  let collapsedCount = row.tail?.segmentCount ?? 0;
  let collapsedCompressed = row.tail?.compressedBytes ?? 0;
  let collapsedUncompressed = row.tail?.uncompressedBytes ?? 0;
  for (const segment of row.segments) {
    const pixels =
      rowBytes === 0
        ? 0
        : (bytesForUnit(segment, unit) / rowBytes) * trackWidth;
    if (
      pixels <= MIN_SEGMENT_PIXELS &&
      segment.columnIndex !== highlightedColumn
    ) {
      collapsedCount += 1;
      collapsedCompressed += segment.compressedBytes;
      collapsedUncompressed += segment.uncompressedBytes;
    } else {
      visibleSegments.push(segment);
    }
  }
  return {
    visibleSegments,
    collapsedTail:
      collapsedCount === 0
        ? null
        : {
            segmentCount: collapsedCount,
            compressedBytes: collapsedCompressed,
            uncompressedBytes: collapsedUncompressed,
          },
  };
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
            className={
              lens === "presence" && bucket.hasBloomFilter
                ? "has-bloom-filter"
                : undefined
            }
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
    return share >= 0.5 ? "#718b7a" : "#b98787";
  }
  const ratioStep =
    unit === "compressed"
      ? bucket.dominantRatioStepCompressed
      : bucket.dominantRatioStepUncompressed;
  return ratioStep === null ? "#a5aaa8" : ratioColor(ratioStep);
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
  const entries: {
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
              color: "#718b7a",
              total: totals.statistics.present,
            },
            {
              label: "Statistics absent",
              color: "#b98787",
              total: totals.statistics.absent,
            },
            {
              label: "Bloom filter",
              color: "#35474f",
              total: totals.bloomFilters.present,
              marker: "dot",
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
              color: "#a5aaa8",
              total: totals.unrated,
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
  if (lens === "presence") return segment.hasStatistics ? "#718b7a" : "#b98787";
  const ratio = segment.compressionRatio;
  return ratio === null
    ? "#a5aaa8"
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
    ["#bd675c", "#c98b58", "#b7a25a", "#729796", "#547da2"][step] ?? "#547da2"
  );
}

function segmentTooltip(segment: StructureLayoutSegment): string {
  return `${segment.columnName}\n${segment.codec} · ${formatEncodings(segment.encodings)}\n${formatFileSize(segment.compressedBytes)} → ${formatFileSize(segment.uncompressedBytes)} · ${formatRatio(segment.compressionRatio)}\nStatistics: ${segment.hasStatistics ? "present" : "absent"} · Bloom: ${segment.hasBloomFilter ? "present" : "absent"} · Page index: ${segment.hasPageIndex ? "present" : "absent"}`;
}

function formatEncodings(encodings: string[]): string {
  return encodings.length === 0 ? "—" : encodings.join(" + ").toLowerCase();
}
