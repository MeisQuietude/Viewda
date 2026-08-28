import { describe, expect, it } from "vitest";

import { exportSelectionShape } from "./export-selection";
import { CompactSelection, type GridSelection } from "./grid-model";

describe("exportSelectionShape", () => {
  const paths = ["seven", "three", "five", "one", "four"].map((name) => [name]);

  it("exports the union of multi-rect rows by the union of their columns", () => {
    const selection: GridSelection = {
      columns: CompactSelection.empty(),
      rows: CompactSelection.empty(),
      current: {
        cell: { column: 2, row: 3 },
        range: { x: 2, y: 3, width: 3, height: 3 },
        rangeStack: [{ x: 0, y: 1, width: 2, height: 3 }],
      },
    };

    expect(exportSelectionShape(selection, paths, 100)).toEqual({
      fieldPaths: paths,
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

    const fieldPaths = [["two"], ["zero"], ["one"]];
    expect(exportSelectionShape(selection, fieldPaths, 1_200_000)).toEqual({
      fieldPaths,
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

    expect(exportSelectionShape(selection, paths.slice(1), 42)).toEqual({
      fieldPaths: [paths[2], paths[4]],
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
        [["zero"], ["one"]],
        10,
      ),
    ).toBeNull();
  });
});
