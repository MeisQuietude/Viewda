import { describe, expect, it } from "vitest";

import { projectedSourceIndices, projectionContains } from "./column-window";

const columns = Array.from({ length: 24 }, (_, sourceIndex) => ({
  sourceIndex,
}));

describe("projected data windows", () => {
  it("buffers the viewport while keeping frozen columns in one projection", () => {
    expect(
      projectedSourceIndices(
        columns,
        [
          { x: 12, width: 3 },
          { x: 0, width: 1 },
        ],
        2,
      ),
    ).toEqual([0, ...Array.from({ length: 7 }, (_, index) => index + 10)]);
  });

  it("uses a small leading projection until the grid reports its viewport", () => {
    expect(projectedSourceIndices(columns, [], 2)).toEqual([0, 1]);
  });

  it("compares projections independently of their order", () => {
    expect(projectionContains([6, 4, 9], [9, 6])).toBe(true);
    expect(projectionContains([6, 4], [9, 6])).toBe(false);
  });
});
