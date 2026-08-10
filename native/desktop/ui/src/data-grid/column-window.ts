interface SourceColumn {
  sourceIndex: number;
}

interface ColumnRegion {
  x: number;
  width: number;
}

export function projectedSourceIndices(
  columns: readonly SourceColumn[],
  regions: readonly ColumnRegion[],
  initialColumnCount: number,
): number[] {
  const visibleIndices = new Set<number>();
  for (const region of regions) {
    const start = Math.max(0, region.x);
    const end = Math.min(columns.length, start + Math.max(0, region.width));
    for (let visibleIndex = start; visibleIndex < end; visibleIndex += 1) {
      const sourceIndex = columns[visibleIndex]?.sourceIndex;
      if (sourceIndex !== undefined) {
        visibleIndices.add(sourceIndex);
      }
    }
  }
  if (visibleIndices.size === 0) {
    for (const column of columns.slice(0, Math.max(1, initialColumnCount))) {
      visibleIndices.add(column.sourceIndex);
    }
  }
  return columns
    .filter((column) => visibleIndices.has(column.sourceIndex))
    .map((column) => column.sourceIndex);
}

export function projectionContains(
  candidate: readonly number[],
  requested: readonly number[],
): boolean {
  const available = new Set(candidate);
  return requested.every((sourceIndex) => available.has(sourceIndex));
}
