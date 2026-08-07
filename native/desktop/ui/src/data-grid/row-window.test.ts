import { describe, expect, it } from "vitest";

import {
  clampedVisibleStart,
  nextScrollState,
  requestSatisfiesRequest,
  rowRequest,
  type ScrollDirection,
} from "./row-window";

describe("row window planning", () => {
  it.each<{
    direction: ScrollDirection;
    offset: number;
    requiredStart: number;
    requiredEnd: number;
  }>([
    { direction: 0, offset: 754, requiredStart: 1_000, requiredEnd: 1_020 },
    { direction: 1, offset: 936, requiredStart: 1_000, requiredEnd: 1_212 },
    { direction: -1, offset: 572, requiredStart: 808, requiredEnd: 1_020 },
  ])(
    "orients a 512-row window for direction $direction",
    ({ direction, offset, requiredStart, requiredEnd }) => {
      expect(rowRequest(10_000, 1_000, 20, direction)).toEqual({
        offset,
        count: 512,
        visibleStart: 1_000,
        visibleEnd: 1_020,
        requiredStart,
        requiredEnd,
      });
    },
  );

  it("clamps directed windows at both source boundaries", () => {
    expect(rowRequest(1_000, 3, 20, -1)).toMatchObject({
      offset: 0,
      visibleStart: 3,
      requiredStart: 0,
    });
    expect(rowRequest(1_000, 995, 20, 1)).toMatchObject({
      offset: 488,
      visibleEnd: 1_000,
      requiredEnd: 1_000,
    });
  });

  it.each<ScrollDirection>([-1, 1])(
    "keeps a large viewport satisfiable while scrolling in direction %s",
    (direction) => {
      const request = rowRequest(10_000, 1_000, 400, direction);

      expect(request.count).toBe(512);
      expect(request.requiredEnd - request.requiredStart).toBe(512);
      expect(requestSatisfiesRequest(request, request)).toBe(true);
    },
  );

  it("clamps a stale viewport to a full last page after the row count shrinks", () => {
    expect(clampedVisibleStart(319_455, 2_063_949, 40)).toBe(319_415);
    expect(rowRequest(319_455, 2_063_949, 40, 0)).toMatchObject({
      visibleStart: 319_415,
      visibleEnd: 319_455,
    });
  });
});

describe("scroll direction hysteresis", () => {
  it("requires four accumulated rows before choosing a direction", () => {
    const idle = { direction: 0 as const, boundary: 100 };

    expect(nextScrollState(idle, 103)).toBe(idle);
    expect(nextScrollState(idle, 104)).toEqual({
      direction: 1,
      boundary: 104,
    });
  });

  it("ignores a one-row rollback but switches after four rows", () => {
    const scrollingDown = { direction: 1 as const, boundary: 100 };

    expect(nextScrollState(scrollingDown, 99)).toBe(scrollingDown);
    expect(nextScrollState(scrollingDown, 96)).toEqual({
      direction: -1,
      boundary: 96,
    });
  });
});
