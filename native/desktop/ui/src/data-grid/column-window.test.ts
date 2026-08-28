import { describe, expect, it } from "vitest";

import { projectedFieldPaths, projectionContains } from "./column-window";

const path = (name: string) => [name];
const columns = ["six", "two", "nine", "four", "one"].map((name) => ({
  fieldPath: path(name),
}));

describe("projected data windows", () => {
  it("combines the viewport and frozen columns into one canonical projection", () => {
    expect(projectedFieldPaths(columns, [2, 3, 0], 2)).toEqual([
      path("six"),
      path("nine"),
      path("four"),
    ]);
  });

  it("uses a small leading projection until the grid reports its viewport", () => {
    expect(projectedFieldPaths(columns, [], 2)).toEqual([
      path("six"),
      path("two"),
    ]);
  });

  it("compares projections independently of their order", () => {
    expect(
      projectionContains(
        [path("root"), ["record", "leaf"], path("other")],
        [["record", "leaf"], path("root")],
      ),
    ).toBe(true);
    expect(
      projectionContains(
        [path("root"), path("other")],
        [["record", "leaf"], path("root")],
      ),
    ).toBe(false);
  });
});
