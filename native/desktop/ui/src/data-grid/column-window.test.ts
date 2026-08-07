import { describe, expect, it } from "vitest";

import { projectedSourceIndices, projectionContains } from "./column-window";

const columns = [6, 2, 9, 4, 1].map((sourceIndex) => ({ sourceIndex }));

describe("projected data windows", () => {
  it("combines the viewport and frozen columns into one canonical projection", () => {
    expect(
      projectedSourceIndices(
        columns,
        [
          { x: 2, width: 2 },
          { x: 0, width: 1 },
        ],
        2,
      ),
    ).toEqual([4, 6, 9]);
  });

  it("uses a small leading projection until the grid reports its viewport", () => {
    expect(projectedSourceIndices(columns, [], 2)).toEqual([2, 6]);
  });

  it("compares projections independently of their order", () => {
    expect(projectionContains([6, 4, 9], [9, 6])).toBe(true);
    expect(projectionContains([6, 4], [9, 6])).toBe(false);
  });
});
