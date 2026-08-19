import { describe, expect, it } from "vitest";

import {
  advanceWheelGesture,
  applyLogicalScroll,
  applyPhysicalScroll,
  clampScrollState,
  columnOffsets,
  deriveVerticalLayout,
  hystereticColumnWindow,
  hystereticRowAnchor,
  logicalToPhysical,
  logicalTopAfterRowSteps,
  normalizeWheelDelta,
  physicalToLogical,
  rowMarkerWidth,
  samePosition,
  visibleIndexRange,
  visibleRowRange,
} from "./grid-layout";

describe("grid column geometry", () => {
  it("finds a bounded visible range by prefix sums", () => {
    const offsets = columnOffsets([40, 80, 120, 160]);

    expect(offsets).toEqual([0, 40, 120, 240, 400]);
    expect(visibleIndexRange(offsets, 100, 150, 0)).toEqual({
      start: 1,
      end: 4,
    });
    expect(visibleIndexRange(offsets, 100, 150, 1)).toEqual({
      start: 0,
      end: 4,
    });
  });

  it("keeps a ten-thousand-column projection bounded", () => {
    const offsets = columnOffsets(Array.from({ length: 10_000 }, () => 120));

    expect(visibleIndexRange(offsets, 600_000, 960, 1)).toEqual({
      start: 4_999,
      end: 5_009,
    });
  });

  it("reuses a bounded column runway and replaces it at its boundary", () => {
    const offsets = columnOffsets(Array.from({ length: 40 }, () => 100));
    const initial = hystereticColumnWindow(offsets, 0, 400, 4, null);
    expect(initial).toEqual({
      visible: { start: 0, end: 4 },
      mounted: { start: 0, end: 8 },
    });

    const inside = hystereticColumnWindow(offsets, 150, 400, 4, initial);
    expect(inside.visible).toEqual({ start: 1, end: 6 });
    expect(inside.mounted).toBe(initial.mounted);

    const replaced = hystereticColumnWindow(offsets, 250, 400, 4, inside);
    expect(replaced).toEqual({
      visible: { start: 2, end: 7 },
      mounted: { start: 0, end: 11 },
    });
    expect(replaced.mounted).not.toBe(initial.mounted);
  });

  it("keeps a prefetch guard while moving forward and backward", () => {
    const offsets = columnOffsets(Array.from({ length: 40 }, () => 100));
    let window = hystereticColumnWindow(offsets, 1_800, 400, 4, null);

    for (const left of [1_850, 1_900, 1_950, 2_000, 1_950, 1_900, 1_850]) {
      window = hystereticColumnWindow(offsets, left, 400, 4, window);
      expect(window.mounted.start).toBeLessThanOrEqual(
        Math.max(0, window.visible.start - 2),
      );
      expect(window.mounted.end).toBeGreaterThanOrEqual(
        Math.min(40, window.visible.end + 2),
      );
      expect(window.mounted.end - window.mounted.start).toBeLessThanOrEqual(13);
    }
  });

  it("never grows the mounted range through horizontal scroll history", () => {
    const offsets = columnOffsets(Array.from({ length: 40 }, () => 100));
    let window = hystereticColumnWindow(offsets, 0, 400, 4, null);
    let maximumMounted = window.mounted.end - window.mounted.start;

    for (let left = 25; left <= 3_600; left += 25) {
      window = hystereticColumnWindow(offsets, left, 400, 4, window);
      maximumMounted = Math.max(
        maximumMounted,
        window.mounted.end - window.mounted.start,
      );
    }

    expect(maximumMounted).toBeLessThanOrEqual(13);
    expect(window.visible).toEqual({ start: 36, end: 40 });
    expect(window.mounted.start).toBeGreaterThan(0);
    expect(window.mounted.end).toBe(40);
  });

  it("budgets enough width for every row-number digit", () => {
    expect(rowMarkerWidth(1)).toBe(48);
    expect(rowMarkerWidth(3_514_000)).toBe(80);
    expect(rowMarkerWidth(1_000_000_000)).toBe(107);
  });
});

describe("grid row geometry", () => {
  it("moves the DOM window one row while keeping its coordinate anchor", () => {
    const initialMounted = visibleRowRange(280, 84, 28, 1_000, 3);
    const anchor = hystereticRowAnchor(initialMounted, null);

    expect(initialMounted).toEqual({ start: 7, end: 16 });
    for (const [top, expectedStart] of [
      [308, 8],
      [336, 9],
      [364, 10],
    ] as const) {
      const mounted = visibleRowRange(top, 84, 28, 1_000, 3);
      expect(mounted.start).toBe(expectedStart);
      expect(hystereticRowAnchor(mounted, anchor)).toBe(anchor);
    }
  });

  it("keeps an anchor when a tall mounted window shifts by one row", () => {
    const anchor = hystereticRowAnchor({ start: 100, end: 180 }, null);

    expect(hystereticRowAnchor({ start: 101, end: 181 }, anchor)).toBe(anchor);
    expect(hystereticRowAnchor({ start: 165, end: 245 }, anchor)).toBe(165);
  });

  it("reanchors a fast jump without exposing logical-size coordinates", () => {
    const mounted = visibleRowRange(
      28_000_000_000 - 84,
      84,
      28,
      1_000_000_000,
      3,
    );
    const anchor = hystereticRowAnchor(mounted, 0);

    expect(mounted.end).toBe(1_000_000_000);
    expect(mounted.end - mounted.start).toBeLessThanOrEqual(6);
    expect(anchor).toBe(mounted.start);
    expect(anchor).toBeGreaterThan(999_999_990);
  });
});

describe("vertical scroll mapping", () => {
  it("uses native coordinates below the measured extent", () => {
    const layout = deriveVerticalLayout(1_000, 28, 560, 1_000_000);

    expect(layout.mode).toBe("native");
    expect(logicalToPhysical(12_345, layout)).toBe(12_345);
    expect(physicalToLogical(12_345, layout)).toBe(12_345);
  });

  it("switches mode immediately around the measured extent", () => {
    expect(deriveVerticalLayout(35, 28, 100, 1_000).mode).toBe("native");
    expect(deriveVerticalLayout(36, 28, 100, 1_000).mode).toBe("compressed");
    expect(deriveVerticalLayout(35_000_000, 28, 560, 32_000_000).mode).toBe(
      "compressed",
    );
  });

  it("reaches the final row for a billion-row grid", () => {
    const layout = deriveVerticalLayout(1_000_000_000, 28, 560, 32_000_000);

    expect(layout.mode).toBe("compressed");
    expect(logicalToPhysical(layout.logicalMax, layout)).toBe(
      layout.physicalMax,
    );
    expect(physicalToLogical(layout.physicalMax, layout)).toBe(
      layout.logicalMax,
    );
    expect(
      visibleRowRange(layout.logicalMax, 560, 28, 1_000_000_000, 3),
    ).toEqual({ start: 999_999_977, end: 1_000_000_000 });
  });

  it("keeps logical input authoritative across its physical read-back", () => {
    const layout = deriveVerticalLayout(1_000_000_000, 28, 560, 32_000_000);
    const logical = applyLogicalScroll(
      { logicalTop: 1_000, physicalTop: 1 },
      28,
      layout,
    );
    const readBack = applyPhysicalScroll(
      logical,
      Math.floor(logical.physicalTop),
      layout,
      true,
    );

    expect(readBack.logicalTop).toBe(1_028);
    expect(readBack.physicalTop).toBe(Math.floor(logical.physicalTop));
  });

  it("accepts subpixel write quantization without masking larger movement", () => {
    expect(samePosition(9.55, 9)).toBe(true);
    expect(samePosition(9.55, 8.55)).toBe(false);
  });

  it("does not accumulate drift across many subpixel mapped deltas", () => {
    const layout = deriveVerticalLayout(1_000_000_000, 28, 560, 32_000_000);
    let state = {
      logicalTop: 0,
      physicalTop: 0,
    };
    for (let index = 0; index < 10_000; index += 1) {
      state = applyLogicalScroll(state, 1, layout);
      state = applyPhysicalScroll(
        state,
        Math.floor(state.physicalTop),
        layout,
        true,
      );
    }

    expect(state.logicalTop).toBe(10_000);
    expect(state.physicalTop).toBe(
      Math.floor(logicalToPhysical(10_000, layout)),
    );
  });

  it("maps the first, middle and final logical positions", () => {
    const layout = deriveVerticalLayout(1_000_000_000, 28, 560, 32_000_000);

    expect(logicalToPhysical(0, layout)).toBe(0);
    expect(logicalToPhysical(layout.logicalMax / 2, layout)).toBeCloseTo(
      layout.physicalMax / 2,
    );
    expect(logicalToPhysical(layout.logicalMax, layout)).toBe(
      layout.physicalMax,
    );
  });

  it("preserves a valid viewport and clamps an invalid viewport after shrink", () => {
    const large = deriveVerticalLayout(1_000, 28, 280, 1_000_000);
    const validShrink = deriveVerticalLayout(500, 28, 280, 1_000_000);
    const invalidShrink = deriveVerticalLayout(20, 28, 280, 1_000_000);
    const state = {
      logicalTop: 8_400,
      physicalTop: 8_400,
    };

    expect(clampScrollState(state, large).logicalTop).toBe(8_400);
    expect(clampScrollState(state, validShrink).logicalTop).toBe(8_400);
    expect(clampScrollState(state, invalidShrink).logicalTop).toBe(
      invalidShrink.logicalMax,
    );
  });

  it("preserves logical position while switching between native and compressed modes", () => {
    const native = deriveVerticalLayout(1_000, 28, 280, 1_000_000);
    const compressed = deriveVerticalLayout(1_000, 28, 280, 10_000);
    const initial = {
      logicalTop: 8_400,
      physicalTop: 8_400,
    };

    const compressedState = clampScrollState(initial, compressed);
    expect(compressedState.logicalTop).toBe(initial.logicalTop);
    expect(compressedState.physicalTop).toBe(
      logicalToPhysical(initial.logicalTop, compressed),
    );
    expect(clampScrollState(compressedState, native)).toEqual(initial);
  });

  it("treats an unmarked thumb movement as authoritative", () => {
    const layout = deriveVerticalLayout(1_000_000_000, 28, 560, 32_000_000);
    const state = applyPhysicalScroll(
      { logicalTop: 0, physicalTop: 0 },
      layout.physicalMax / 2,
      layout,
      false,
    );

    expect(state.logicalTop).toBeCloseTo(layout.logicalMax / 2);
    expect(state.physicalTop).toBe(layout.physicalMax / 2);
  });

  it("normalizes line and page wheel deltas", () => {
    expect(normalizeWheelDelta(2, WheelEvent.DOM_DELTA_LINE, 28, 560)).toBe(56);
    expect(normalizeWheelDelta(1, WheelEvent.DOM_DELTA_PAGE, 28, 560)).toBe(
      560,
    );
  });
});

describe("row-stepped wheel gestures", () => {
  it("accumulates small vertical deltas into exact row steps", () => {
    let state = null;
    let steps = 0;
    for (let index = 0; index < 4; index += 1) {
      const advance = advanceWheelGesture(state, 0, 7, index * 10, 28);
      state = advance.state;
      steps += advance.rowSteps;
    }

    expect(steps).toBe(1);
    expect(state?.verticalRemainder).toBe(0);
  });

  it("maps a three-line notch to three rows", () => {
    expect(advanceWheelGesture(null, 0, 84, 0, 28).rowSteps).toBe(3);
  });

  it("waits for dominance and lets strong opposing input take over", () => {
    const undecided = advanceWheelGesture(null, 10, 9, 0, 28);
    expect(undecided).toMatchObject({ horizontalDelta: 0, rowSteps: 0 });
    expect(undecided.state.axis).toBeNull();

    const horizontal = advanceWheelGesture(undecided.state, 10, 1, 10, 28);
    expect(horizontal.state.axis).toBe("horizontal");
    expect(horizontal.horizontalDelta).toBe(20);
    expect(horizontal.rowSteps).toBe(0);
    const verticalTakeover = advanceWheelGesture(
      horizontal.state,
      1,
      84,
      20,
      28,
    );
    expect(verticalTakeover).toMatchObject({
      horizontalDelta: 0,
      rowSteps: 3,
      takeover: true,
    });
    expect(verticalTakeover.state.axis).toBe("vertical");

    const vertical = advanceWheelGesture(null, 1, 28, 0, 28);
    expect(vertical.state.axis).toBe("vertical");
    expect(vertical.rowSteps).toBe(1);
    expect(advanceWheelGesture(vertical.state, 20, 28, 10, 28)).toMatchObject({
      horizontalDelta: 0,
      rowSteps: 1,
    });
  });

  it("starts a new axis lock after gesture idle", () => {
    const horizontal = advanceWheelGesture(null, 20, 1, 0, 28);
    const vertical = advanceWheelGesture(horizontal.state, 1, 28, 151, 28);

    expect(vertical.state.axis).toBe("vertical");
    expect(vertical.rowSteps).toBe(1);
    expect(vertical.takeover).toBe(false);
  });

  it("snaps an arbitrary thumb position in the movement direction", () => {
    expect(logicalTopAfterRowSteps(15, 1, 28, 1_000)).toBe(28);
    expect(logicalTopAfterRowSteps(15, -1, 28, 1_000)).toBe(0);
    expect(logicalTopAfterRowSteps(28, 3, 28, 1_000)).toBe(112);
    expect(logicalTopAfterRowSteps(28, -3, 28, 1_000)).toBe(0);
  });
});
