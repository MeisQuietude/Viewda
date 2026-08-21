/** Shared number and fact formatting for Structure mode. */

import type { StructureByteUnit } from "../desktop";

/** Stands in for a fact the footer does not carry. */
export const MISSING_FACT = "—";

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatFileSize(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  if (bytes < 1_000) {
    return `${bytes} B`;
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1_000 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }

  if (value >= 999.95 && unit < units.length - 1) {
    value /= 1_000;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Renders a compression ratio as the factor the stored bytes expand by.
 *
 * A chunk that stores nothing has no ratio, which reads as a missing fact
 * rather than as `×1`.
 */
export function formatRatio(ratio: number | null): string {
  return ratio === null ? MISSING_FACT : `×${ratio.toFixed(1)}`;
}

/** Renders coverage as the plain count the mode states, never as a verdict. */
export function formatCoverage(present: number, total: number): string {
  if (total === 0) {
    return MISSING_FACT;
  }
  return `${formatNumber(present)} of ${formatNumber(total)} chunks`;
}

export function formatCodecs(codecs: readonly string[]): string {
  return codecs.length === 0 ? MISSING_FACT : codecs.join(" + ");
}

export function formatRowsPerRowGroup(value: number | null): string {
  if (value === null) {
    return MISSING_FACT;
  }
  return `≈ ${formatNumber(Math.round(value))}`;
}

export function formatShare(share: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(share);
}

export function formatEncodings(encodings: readonly string[]): string {
  return encodings.length === 0 ? MISSING_FACT : encodings.join(", ");
}

export function formatColumnType(
  physicalType: string,
  logicalType: string | null,
): string {
  return logicalType === null
    ? physicalType
    : `${physicalType} · ${logicalType}`;
}

/** Picks the byte figure the mode's unit toggle currently governs. */
export function bytesForUnit(
  row: { compressedBytes: number; uncompressedBytes: number },
  unit: StructureByteUnit,
): number {
  return unit === "compressed" ? row.compressedBytes : row.uncompressedBytes;
}

export function unitLabel(unit: StructureByteUnit): string {
  return unit === "compressed" ? "On disk" : "Uncompressed";
}
