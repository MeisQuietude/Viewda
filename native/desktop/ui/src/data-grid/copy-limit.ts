const MAX_COPY_ROWS = 10_000;
const MAX_COPY_CELLS = 250_000;

export function copyRowLimit(columnCount: number): number {
  const safeColumnCount = Math.max(1, columnCount);
  return Math.max(
    1,
    Math.min(MAX_COPY_ROWS, Math.floor(MAX_COPY_CELLS / safeColumnCount)),
  );
}
