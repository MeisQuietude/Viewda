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
  const indices = new Set<number>();
  for (const region of regions) {
    const start = Math.max(0, region.x);
    const end = Math.min(columns.length, start + Math.max(0, region.width));
    for (let visibleIndex = start; visibleIndex < end; visibleIndex += 1) {
      const sourceIndex = columns[visibleIndex]?.sourceIndex;
      if (sourceIndex !== undefined) {
        indices.add(sourceIndex);
      }
    }
  }
  if (indices.size === 0) {
    for (const column of columns.slice(0, Math.max(1, initialColumnCount))) {
      indices.add(column.sourceIndex);
    }
  }
  return [...indices].sort((left, right) => left - right);
}

export function projectionContains(
  candidate: readonly number[],
  requested: readonly number[],
): boolean {
  const available = new Set(candidate);
  return requested.every((sourceIndex) => available.has(sourceIndex));
}
