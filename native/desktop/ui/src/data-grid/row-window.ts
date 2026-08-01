// Must match data-engine's MAX_WINDOW_ROWS; Rust validates every command at the boundary.
const MAX_WINDOW_ROWS = 512;
const PREFETCH_ROWS = 192;
const TRAILING_ROWS = 64;
const DIRECTION_HYSTERESIS_ROWS = 4;

export interface RowRequest {
  offset: number;
  count: number;
  visibleStart: number;
  visibleEnd: number;
  requiredStart: number;
  requiredEnd: number;
}

export type ScrollDirection = -1 | 0 | 1;

export interface ScrollState {
  direction: ScrollDirection;
  boundary: number;
}

export function nextScrollState(
  state: ScrollState,
  visibleStart: number,
): ScrollState {
  if (state.direction === 0) {
    const delta = visibleStart - state.boundary;
    if (Math.abs(delta) < DIRECTION_HYSTERESIS_ROWS) {
      return state;
    }
    return {
      direction: Math.sign(delta) as ScrollDirection,
      boundary: visibleStart,
    };
  }

  if (state.direction > 0) {
    if (visibleStart >= state.boundary) {
      return { direction: 1, boundary: visibleStart };
    }
    return state.boundary - visibleStart < DIRECTION_HYSTERESIS_ROWS
      ? state
      : { direction: -1, boundary: visibleStart };
  }

  if (visibleStart <= state.boundary) {
    return { direction: -1, boundary: visibleStart };
  }
  return visibleStart - state.boundary < DIRECTION_HYSTERESIS_ROWS
    ? state
    : { direction: 1, boundary: visibleStart };
}

export function rowRequest(
  totalRows: number,
  visibleStart: number,
  visibleCount: number,
  direction: ScrollDirection,
): RowRequest {
  if (totalRows === 0) {
    return {
      offset: 0,
      count: 0,
      visibleStart: 0,
      visibleEnd: 0,
      requiredStart: 0,
      requiredEnd: 0,
    };
  }
  const safeStart = Math.max(0, Math.min(totalRows - 1, visibleStart));
  const safeCount = Math.min(
    MAX_WINDOW_ROWS,
    Math.max(1, visibleCount),
    totalRows - safeStart,
  );
  const visibleEnd = safeStart + safeCount;
  const windowSize = Math.min(totalRows, MAX_WINDOW_ROWS);
  const spareRows = windowSize - safeCount;
  const prefetchRows = Math.min(PREFETCH_ROWS, spareRows);
  const trailingRows = Math.min(TRAILING_ROWS, spareRows - prefetchRows);
  const rowsBefore =
    direction > 0
      ? trailingRows
      : direction < 0
        ? spareRows - trailingRows
        : Math.floor(spareRows / 2);
  const offset = Math.max(
    0,
    Math.min(totalRows - windowSize, safeStart - rowsBefore),
  );
  const requiredStart =
    direction < 0 ? Math.max(0, safeStart - prefetchRows) : safeStart;
  const requiredEnd =
    direction > 0 ? Math.min(totalRows, visibleEnd + prefetchRows) : visibleEnd;
  return {
    offset,
    count: windowSize,
    visibleStart: safeStart,
    visibleEnd,
    requiredStart,
    requiredEnd,
  };
}

export function requestSatisfiesRequest(
  candidate: RowRequest,
  requested: RowRequest,
): boolean {
  return windowSatisfiesRequest(candidate.offset, candidate.count, requested);
}

export function windowSatisfiesRequest(
  offset: number,
  count: number,
  request: RowRequest,
): boolean {
  return (
    request.requiredStart >= offset && request.requiredEnd <= offset + count
  );
}

export function requestContainsVisibleRows(
  request: RowRequest,
  pending: RowRequest,
): boolean {
  return (
    pending.visibleStart >= request.offset &&
    pending.visibleEnd <= request.offset + request.count
  );
}
