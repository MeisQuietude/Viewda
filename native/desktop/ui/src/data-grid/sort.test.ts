import { describe, expect, it } from "vitest";

import type { SortColumn } from "../desktop";
import { nextSort, sortedColumnIcon } from "./sort";

describe("grid sort order", () => {
  it("cycles a primary column through ascending, descending and file order", () => {
    const path = ["record", "value"];
    const ascending = nextSort([], path, false);
    const descending = nextSort(ascending, path, false);

    expect(ascending).toEqual([{ fieldPath: path, direction: "ascending" }]);
    expect(descending).toEqual([{ fieldPath: path, direction: "descending" }]);
    expect(nextSort(descending, path, false)).toEqual([]);
  });

  it("adds, cycles and removes secondary columns without changing their priority", () => {
    const primary: SortColumn[] = [
      { fieldPath: ["primary"], direction: "ascending" },
    ];
    const secondaryPath = ["record", "secondary"];
    const secondary = nextSort(primary, secondaryPath, true);

    expect(secondary).toEqual([
      { fieldPath: ["primary"], direction: "ascending" },
      { fieldPath: secondaryPath, direction: "ascending" },
    ]);
    expect(nextSort(secondary, secondaryPath, true)).toEqual([
      { fieldPath: ["primary"], direction: "ascending" },
      { fieldPath: secondaryPath, direction: "descending" },
    ]);
    expect(
      nextSort(nextSort(secondary, secondaryPath, true), secondaryPath, true),
    ).toEqual(primary);
  });

  it("makes a plain-clicked secondary column the only primary sort", () => {
    expect(
      nextSort(
        [
          { fieldPath: ["primary"], direction: "ascending" },
          { fieldPath: ["record", "secondary"], direction: "ascending" },
        ],
        ["record", "secondary"],
        false,
      ),
    ).toEqual([
      { fieldPath: ["record", "secondary"], direction: "descending" },
    ]);
  });

  it("selects neutral, directional and prioritized header icons", () => {
    const sort: SortColumn[] = [
      { fieldPath: ["primary"], direction: "ascending" },
      { fieldPath: ["record", "secondary"], direction: "descending" },
    ];

    expect(sortedColumnIcon(sort, ["primary"])).toBe("viewda-sort-ascending-1");
    expect(sortedColumnIcon(sort, ["record", "secondary"])).toBe(
      "viewda-sort-descending-2",
    );
    expect(sortedColumnIcon(sort, ["missing"])).toBe("viewda-sort-neutral");
    expect(sortedColumnIcon([sort[0]!], ["primary"])).toBe(
      "viewda-sort-ascending",
    );
  });
});
