interface SourceColumn {
  sourceIndex: number;
}

export function projectedSourceIndices(
  columns: readonly SourceColumn[],
  visibleColumnIndices: readonly number[],
  initialColumnCount: number,
): number[] {
  const visibleIndices = new Set<number>();
  for (const visibleIndex of visibleColumnIndices) {
    const sourceIndex = columns[visibleIndex]?.sourceIndex;
    if (sourceIndex !== undefined) {
      visibleIndices.add(sourceIndex);
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
