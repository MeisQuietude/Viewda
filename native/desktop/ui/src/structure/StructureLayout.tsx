import { useEffect, useMemo, useState } from "react";

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
const CODEC_COLORS = [
  "#4f7cac",
  "#6f9d72",
  "#9a6fb0",
  "#c18453",
  "#4f9993",
  "#b45f70",
];
const DEFAULT_CODEC_COLOR = "#4f7cac";

export function StructureLayoutView({
  generation,
  unit,
  rowGroupCount,
  highlightedColumn,
  onHighlightColumn,
  onOpenRow,
}: {
  generation: number;
  unit: StructureByteUnit;
  rowGroupCount: number;
  highlightedColumn: number | null;
  onHighlightColumn: (column: number | null) => void;
  onOpenRow: (rowGroupIndex: number) => void;
}) {
  const [lens, setLens] = useState<StructureLens>("ratio");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<StructureLayoutRow[]>([]);
  const [maximumBytes, setMaximumBytes] = useState(1);
  const [overview, setOverview] = useState<StructureLayoutOverviewBucket[]>([]);
  const [totals, setTotals] = useState<StructureLensTotals | null>(null);
  const [selected, setSelected] = useState<SelectedChunk | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [hoveredColumn, setHoveredColumn] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  }, [generation, offset, unit]);

  const codecColors = useMemo(() => {
    const entries = totals?.codecs ?? [];
    return new Map(
      entries.map((entry, index) => [
        entry.codec,
        CODEC_COLORS[index % CODEC_COLORS.length] ?? DEFAULT_CODEC_COLOR,
      ]),
    );
  }, [totals]);
  const activeColumn = hoveredColumn ?? highlightedColumn;
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
          <LensButton lens="ratio" active={lens} onLens={setLens}>
            <StructureHelp term="Ratio" />
          </LensButton>
          <LensButton lens="codec" active={lens} onLens={setLens}>
            <StructureHelp term="Codec" />
          </LensButton>
          <LensButton lens="presence" active={lens} onLens={setLens}>
            <StructureHelp term="Stats & bloom" />
          </LensButton>
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
            onHoverColumn={setHoveredColumn}
            onSelectRow={() => setSelectedRow(row.index)}
            onOpenRow={() => onOpenRow(row.index)}
            onSelectChunk={(columnIndex) => {
              setSelectedRow(row.index);
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
  onHoverColumn: (column: number | null) => void;
  onSelectRow: () => void;
  onOpenRow: () => void;
  onSelectChunk: (column: number) => void;
}) {
  const bytes = bytesForUnit(row, unit);
  return (
    <div
      className={`layout-row${!row.isReadable ? " is-unreadable" : ""}${selected ? " is-selected" : ""}`}
    >
      <button
        className="layout-row-label"
        type="button"
        onClick={onSelectRow}
        onDoubleClick={onOpenRow}
        title="Click for details; double-click to open this row group in Data"
      >
        RG {formatNumber(row.index)}
      </button>
      <div
        className="layout-row-track"
        style={{ width: `${Math.max(3, (bytes / maximumBytes) * 100)}%` }}
      >
        {row.isReadable ? (
          row.segments.map((segment) => (
            <button
              key={segment.columnIndex}
              type="button"
              className={`layout-segment${highlightedColumn === segment.columnIndex ? " is-highlighted" : ""}`}
              style={{
                flexGrow: Math.max(1, bytesForUnit(segment, unit)),
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
          ))
        ) : (
          <span className="layout-unreadable-label">Unreadable metadata</span>
        )}
        {row.tail !== null && (
          <span
            className="layout-tail"
            style={{ flexGrow: Math.max(1, bytesForUnit(row.tail, unit)) }}
            title={`${formatNumber(row.tail.segmentCount)} collapsed columns`}
          >
            + {formatNumber(row.tail.segmentCount)} more ·{" "}
            {formatFileSize(bytesForUnit(row.tail, unit))}
          </span>
        )}
      </div>
      <span className="layout-row-bytes">{formatFileSize(bytes)}</span>
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
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, total - 1)}
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
            style={{
              left: `${(bucket.rowStart / total) * 100}%`,
              width: `${Math.max(0.25, ((bucket.rowEnd - bucket.rowStart) / total) * 100)}%`,
              background: overviewColor(bucket, unit, lens, codecColors),
              opacity: bytesForUnit(bucket, unit) === 0 ? 0.35 : 1,
              outline:
                highlightColumn && bucket.hasReadableGroup
                  ? "2px solid #1b1d1e"
                  : undefined,
              zIndex: highlightColumn && bucket.hasReadableGroup ? 1 : 0,
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
  const entries: { label: string; color: string; total: StructureLensTotal }[] =
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
          ]
        : totals.ratioSteps.map(({ maxRatio, total }, index) => ({
            label: maxRatio === null ? "> ×10" : `≤ ×${maxRatio}`,
            color: ratioColor(index),
            total,
          }));
  return (
    <div className="layout-legend" aria-label="Active lens legend">
      {entries.map((entry) => (
        <span key={entry.label}>
          <i style={{ background: entry.color }} />
          {entry.label} · {formatFileSize(bytesForUnit(entry.total, unit))}
        </span>
      ))}
    </div>
  );
}

function LensButton({
  lens,
  active,
  onLens,
  children,
}: {
  lens: StructureLens;
  active: StructureLens;
  onLens: (lens: StructureLens) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={lens === active}
      onClick={() => onLens(lens)}
    >
      {children}
    </button>
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
