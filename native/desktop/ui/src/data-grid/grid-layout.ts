export const GRID_ROW_HEIGHT = 28;
export const GRID_OVERSCAN_ROWS = 3;
export const GRID_OVERSCAN_COLUMNS = 4;
export const GRID_INITIAL_ROWS = 64;
export const GRID_INITIAL_COLUMNS = 8;

const WHEEL_AXIS_DOMINANCE = 1.5;
const WHEEL_GESTURE_IDLE_MS = 150;

export interface GridSize {
  width: number;
  height: number;
}

export interface GridMeasurements extends GridSize {
  scrollTop: number;
  scrollLeft: number;
  devicePixelRatio: number;
}

export interface VerticalLayout {
  mode: "native" | "compressed";
  logicalHeight: number;
  logicalMax: number;
  physicalHeight: number;
  physicalMax: number;
  viewportHeight: number;
  rowHeight: number;
}

export interface VerticalScrollState {
  logicalTop: number;
  physicalTop: number;
}

export interface IndexRange {
  start: number;
  end: number;
}

export interface ColumnWindow {
  visible: IndexRange;
  mounted: IndexRange;
}

export interface WheelGestureState {
  axis: "horizontal" | "vertical" | null;
  pendingX: number;
  pendingY: number;
  verticalRemainder: number;
  lastEventTime: number;
}

export interface WheelGestureAdvance {
  state: WheelGestureState;
  horizontalDelta: number;
  rowSteps: number;
  takeover: boolean;
}

type WheelGestureMovement = Omit<WheelGestureAdvance, "takeover">;

export function columnOffsets(widths: readonly number[]): number[] {
  const offsets = [0];
  for (const width of widths) {
    offsets.push((offsets.at(-1) ?? 0) + Math.max(0, width));
  }
  return offsets;
}

export function visibleIndexRange(
  offsets: readonly number[],
  viewportStart: number,
  viewportSize: number,
  overscan: number,
): IndexRange {
  const count = Math.max(0, offsets.length - 1);
  if (count === 0 || viewportSize <= 0) {
    return { start: 0, end: 0 };
  }
  const start = Math.max(
    0,
    firstOffsetAfter(offsets, Math.max(0, viewportStart)) - 1 - overscan,
  );
  const end = Math.min(
    count,
    firstOffsetAtOrAfter(offsets, viewportStart + viewportSize) + overscan,
  );
  return { start, end: Math.max(start, end) };
}

export function hystereticColumnWindow(
  offsets: readonly number[],
  viewportStart: number,
  viewportSize: number,
  overscan: number,
  current: ColumnWindow | null,
): ColumnWindow {
  const visible = visibleIndexRange(offsets, viewportStart, viewportSize, 0);
  const count = Math.max(0, offsets.length - 1);
  const guard = {
    start: Math.max(0, visible.start - Math.ceil(overscan / 2)),
    end: Math.min(count, visible.end + Math.ceil(overscan / 2)),
  };
  if (
    current !== null &&
    current.mounted.end <= count &&
    rangeContains(current.mounted, guard)
  ) {
    if (sameRange(current.visible, visible)) {
      return current;
    }
    return { visible, mounted: current.mounted };
  }
  return {
    visible,
    mounted: visibleIndexRange(offsets, viewportStart, viewportSize, overscan),
  };
}

export function deriveVerticalLayout(
  rowCount: number,
  rowHeight: number,
  viewportHeight: number,
  safeExtent: number,
): VerticalLayout {
  const logicalHeight = Math.max(0, rowCount) * Math.max(1, rowHeight);
  const safeHeight = Math.max(viewportHeight, safeExtent);
  const physicalHeight = Math.min(logicalHeight, safeHeight);
  return {
    mode: physicalHeight < logicalHeight ? "compressed" : "native",
    logicalHeight,
    logicalMax: Math.max(0, logicalHeight - viewportHeight),
    physicalHeight,
    physicalMax: Math.max(0, physicalHeight - viewportHeight),
    viewportHeight,
    rowHeight,
  };
}

export function logicalToPhysical(
  logicalTop: number,
  layout: VerticalLayout,
): number {
  const clamped = clamp(logicalTop, 0, layout.logicalMax);
  if (layout.logicalMax === 0 || layout.physicalMax === 0) {
    return 0;
  }
  return (clamped / layout.logicalMax) * layout.physicalMax;
}

export function physicalToLogical(
  physicalTop: number,
  layout: VerticalLayout,
): number {
  const clamped = clamp(physicalTop, 0, layout.physicalMax);
  if (layout.physicalMax === 0 || layout.logicalMax === 0) {
    return 0;
  }
  return (clamped / layout.physicalMax) * layout.logicalMax;
}

export function clampScrollState(
  state: VerticalScrollState,
  layout: VerticalLayout,
): VerticalScrollState {
  const logicalTop = clamp(state.logicalTop, 0, layout.logicalMax);
  return {
    logicalTop,
    physicalTop: logicalToPhysical(logicalTop, layout),
  };
}

export function applyLogicalScroll(
  state: VerticalScrollState,
  delta: number,
  layout: VerticalLayout,
): VerticalScrollState {
  const logicalTop = clamp(state.logicalTop + delta, 0, layout.logicalMax);
  return {
    logicalTop,
    physicalTop: logicalToPhysical(logicalTop, layout),
  };
}

export function applyPhysicalScroll(
  state: VerticalScrollState,
  physicalTop: number,
  layout: VerticalLayout,
  ownWrite: boolean,
): VerticalScrollState {
  const acceptedPhysical = clamp(physicalTop, 0, layout.physicalMax);
  return {
    logicalTop: ownWrite
      ? state.logicalTop
      : physicalToLogical(acceptedPhysical, layout),
    physicalTop: acceptedPhysical,
  };
}

export function visibleRowRange(
  logicalTop: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  overscan: number,
): IndexRange {
  const start = Math.max(0, Math.floor(logicalTop / rowHeight) - overscan);
  const end = Math.min(
    rowCount,
    Math.ceil((logicalTop + viewportHeight) / rowHeight) + overscan,
  );
  return { start, end: Math.max(start, end) };
}

export function normalizeWheelDelta(
  delta: number,
  deltaMode: number,
  lineHeight: number,
  pageHeight: number,
): number {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return delta * lineHeight;
  }
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return delta * pageHeight;
  }
  return delta;
}

export function advanceWheelGesture(
  previous: WheelGestureState | null,
  deltaX: number,
  deltaY: number,
  eventTime: number,
  rowHeight: number,
): WheelGestureAdvance {
  const idle =
    previous === null ||
    eventTime < previous.lastEventTime ||
    eventTime - previous.lastEventTime > WHEEL_GESTURE_IDLE_MS;
  const state: WheelGestureState = idle
    ? {
        axis: null,
        pendingX: 0,
        pendingY: 0,
        verticalRemainder: 0,
        lastEventTime: eventTime,
      }
    : { ...previous, lastEventTime: eventTime };
  const finish = (movement: WheelGestureMovement): WheelGestureAdvance => ({
    ...movement,
    takeover:
      !idle &&
      previous !== null &&
      previous.axis !== null &&
      movement.state.axis !== null &&
      previous.axis !== movement.state.axis,
  });

  if (state.axis === "horizontal") {
    if (axisDominates(deltaY, deltaX)) {
      state.axis = "vertical";
      state.verticalRemainder = 0;
      return finish(verticalGestureAdvance(state, deltaY, rowHeight));
    }
    return finish({ state, horizontalDelta: deltaX, rowSteps: 0 });
  }
  if (state.axis === "vertical") {
    if (axisDominates(deltaX, deltaY)) {
      state.axis = "horizontal";
      state.verticalRemainder = 0;
      return finish({ state, horizontalDelta: deltaX, rowSteps: 0 });
    }
    return finish(verticalGestureAdvance(state, deltaY, rowHeight));
  }

  state.pendingX += deltaX;
  state.pendingY += deltaY;
  const horizontalMagnitude = Math.abs(state.pendingX);
  const verticalMagnitude = Math.abs(state.pendingY);
  if (
    horizontalMagnitude > 0 &&
    horizontalMagnitude >= verticalMagnitude * WHEEL_AXIS_DOMINANCE
  ) {
    state.axis = "horizontal";
    const horizontalDelta = state.pendingX;
    state.pendingX = 0;
    state.pendingY = 0;
    return finish({ state, horizontalDelta, rowSteps: 0 });
  }
  if (
    verticalMagnitude > 0 &&
    verticalMagnitude >= horizontalMagnitude * WHEEL_AXIS_DOMINANCE
  ) {
    state.axis = "vertical";
    const pendingY = state.pendingY;
    state.pendingX = 0;
    state.pendingY = 0;
    return finish(verticalGestureAdvance(state, pendingY, rowHeight));
  }
  return finish({ state, horizontalDelta: 0, rowSteps: 0 });
}

function axisDominates(primary: number, secondary: number): boolean {
  return (
    Math.abs(primary) > 0 &&
    Math.abs(primary) >= Math.abs(secondary) * WHEEL_AXIS_DOMINANCE
  );
}

export function logicalTopAfterRowSteps(
  logicalTop: number,
  rowSteps: number,
  rowHeight: number,
  logicalMax: number,
): number {
  if (rowSteps === 0) {
    return clamp(logicalTop, 0, logicalMax);
  }
  const height = Math.max(1, rowHeight);
  const targetRow =
    rowSteps > 0
      ? Math.floor(logicalTop / height) + rowSteps
      : Math.ceil(logicalTop / height) + rowSteps;
  return clamp(targetRow * height, 0, logicalMax);
}

export function rowMarkerWidth(rowCount: number): number {
  const digits = Math.max(1, Math.floor(Math.log10(Math.max(1, rowCount))) + 1);
  // Includes two 8px paddings, the border, and a conservative digit width for
  // the grid's 12px UI font.
  return Math.max(48, digits * 9 + 17);
}

export function samePosition(left: number, right: number): boolean {
  // Webviews may quantize assigned scroll positions to whole CSS pixels.
  return Math.abs(left - right) < 1;
}

function verticalGestureAdvance(
  state: WheelGestureState,
  delta: number,
  rowHeight: number,
): WheelGestureMovement {
  const height = Math.max(1, rowHeight);
  const total = state.verticalRemainder + delta;
  const rowSteps = Math.trunc(total / height);
  state.verticalRemainder = total - rowSteps * height;
  return { state, horizontalDelta: 0, rowSteps };
}

function firstOffsetAfter(offsets: readonly number[], value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function rangeContains(candidate: IndexRange, requested: IndexRange): boolean {
  return candidate.start <= requested.start && candidate.end >= requested.end;
}

function sameRange(left: IndexRange, right: IndexRange): boolean {
  return left.start === right.start && left.end === right.end;
}

function firstOffsetAtOrAfter(
  offsets: readonly number[],
  value: number,
): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
