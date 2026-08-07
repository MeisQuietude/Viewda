import { describe, expect, it } from "vitest";

import { nextSort, sortedColumnIcon } from "./sort";

describe("grid sort order", () => {
  it("cycles a primary column through ascending, descending and file order", () => {
    const ascending = nextSort([], 2, false);
    const descending = nextSort(ascending, 2, false);

    expect(ascending).toEqual([{ sourceIndex: 2, direction: "ascending" }]);
    expect(descending).toEqual([{ sourceIndex: 2, direction: "descending" }]);
    expect(nextSort(descending, 2, false)).toEqual([]);
  });

  it("adds, cycles and removes secondary columns without changing their priority", () => {
    const primary = [{ sourceIndex: 2, direction: "ascending" }] as const;
    const secondary = nextSort(primary, 5, true);

    expect(secondary).toEqual([
      { sourceIndex: 2, direction: "ascending" },
      { sourceIndex: 5, direction: "ascending" },
    ]);
    expect(nextSort(secondary, 5, true)).toEqual([
      { sourceIndex: 2, direction: "ascending" },
      { sourceIndex: 5, direction: "descending" },
    ]);
    expect(nextSort(nextSort(secondary, 5, true), 5, true)).toEqual(primary);
  });

  it("makes a plain-clicked secondary column the only primary sort", () => {
    expect(
      nextSort(
        [
          { sourceIndex: 2, direction: "ascending" },
          { sourceIndex: 5, direction: "ascending" },
        ],
        5,
        false,
      ),
    ).toEqual([{ sourceIndex: 5, direction: "descending" }]);
  });

  it("selects neutral, directional and prioritized header icons", () => {
    const sort = [
      { sourceIndex: 2, direction: "ascending" },
      { sourceIndex: 5, direction: "descending" },
    ] as const;

    expect(sortedColumnIcon(sort, 2)).toBe("viewda-sort-ascending-1");
    expect(sortedColumnIcon(sort, 5)).toBe("viewda-sort-descending-2");
    expect(sortedColumnIcon(sort, 7)).toBe("viewda-sort-neutral");
    expect(sortedColumnIcon([sort[0]], 2)).toBe("viewda-sort-ascending");
  });
});
