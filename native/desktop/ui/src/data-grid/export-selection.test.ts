import { CompactSelection, type GridSelection } from "./grid-model";
import { describe, expect, it } from "vitest";

import { exportSelectionShape } from "./export-selection";

describe("exportSelectionShape", () => {
  it("exports the union of multi-rect rows by the union of their columns", () => {
    const selection: GridSelection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: [2, 3],
        range: { x: 2, y: 3, width: 3, height: 3 },
        rangeStack: [{ x: 0, y: 1, width: 2, height: 3 }],
      },
    };

    expect(exportSelectionShape(selection, [7, 3, 5, 1, 4], 100)).toEqual({
      columnIndices: [7, 3, 5, 1, 4],
      columnCount: 5,
      rowCount: 5,
      rowRanges: [{ start: 1, end: 6 }],
    });
  });

  it("keeps a million-row selection as one compact range", () => {
    const selection: GridSelection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.fromSingleSelection([0, 1_200_000]),
    };

    expect(exportSelectionShape(selection, [2, 0, 1], 1_200_000)).toEqual({
      columnIndices: [2, 0, 1],
      columnCount: 3,
      rowCount: 1_200_000,
      rowRanges: [{ start: 0, end: 1_200_000 }],
    });
  });

  it("exports selected columns across the current view in grid order", () => {
    const selection: GridSelection = {
      columns: CompactSelection.empty().add(3).add(1),
      rows: CompactSelection.empty(),
    };

    expect(exportSelectionShape(selection, [4, 3, 2, 1], 42)).toEqual({
      columnIndices: [3, 1],
      columnCount: 2,
      rowCount: 42,
      rowRanges: [{ start: 0, end: 42 }],
    });
  });

  it("omits the selection command when nothing is selected", () => {
    expect(
      exportSelectionShape(
        {
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        },
        [0, 1],
        10,
      ),
    ).toBeNull();
  });
});
