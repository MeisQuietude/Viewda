import { describe, expect, it } from "vitest";

import { CompactSelection } from "./grid-model";
import {
  boundedSelectionScope,
  cellIsSelected,
  emptyGridSelection,
  selectCell,
  selectColumn,
  selectRow,
} from "./grid-selection";

describe("grid selection", () => {
  it("grows a rectangle from its logical anchor", () => {
    const initial = selectCell(
      emptyGridSelection(),
      { row: 4, column: 3 },
      false,
      false,
    );
    const grown = selectCell(initial, { row: 1, column: 6 }, true, false);

    expect(grown.current?.range).toEqual({ x: 3, y: 1, width: 4, height: 4 });
    expect(cellIsSelected(grown, 2, 5)).toBe(true);
  });

  it("adds rectangles without expanding their cells", () => {
    const first = selectCell(
      emptyGridSelection(),
      { row: 1, column: 1 },
      false,
      false,
    );
    const second = selectCell(first, { row: 10, column: 10 }, false, true);

    expect(second.current?.rangeStack).toEqual([
      { x: 1, y: 1, width: 1, height: 1 },
    ]);
  });

  it("keeps the original anchor through orthogonal growth and contraction", () => {
    const anchor = selectCell(
      emptyGridSelection(),
      { row: 4, column: 3 },
      false,
      false,
    );
    const down = selectCell(anchor, { row: 5, column: 3 }, true, false);
    const right = selectCell(down, { row: 5, column: 4 }, true, false);
    const contracted = selectCell(right, { row: 4, column: 4 }, true, false);

    expect(right.current?.range).toEqual({ x: 3, y: 4, width: 2, height: 2 });
    expect(contracted.current?.range).toEqual({
      x: 3,
      y: 4,
      width: 2,
      height: 1,
    });
  });

  it("extends from the anchor to a non-adjacent keyboard destination", () => {
    const initial = selectCell(
      emptyGridSelection(),
      { row: 5, column: 3 },
      false,
      false,
    );

    const extended = selectCell(initial, { row: 999, column: 11 }, true, false);

    expect(extended.current).toEqual({
      cell: { row: 999, column: 11 },
      range: { x: 3, y: 5, width: 9, height: 995 },
      rangeStack: [],
    });
  });

  it("keeps full row and column ranges compact", () => {
    const rows = selectRow(emptyGridSelection(), 1_000_000_000, false, false);
    const columns = selectColumn(rows, 9_999, false, false);

    expect(rows.rows.ranges()).toEqual([[1_000_000_000, 1_000_000_001]]);
    expect(columns.columns.ranges()).toEqual([[9_999, 10_000]]);
    expect(columns.rows.length).toBe(0);
  });

  it.each([["rows", selectRow] as const, ["columns", selectColumn] as const])(
    "keeps the original %s anchor when a range reverses",
    (kind, select) => {
      const downward = select(emptyGridSelection(), 10, false, false);
      const pastAnchor = select(downward, 5, true, false);
      const reversed = select(pastAnchor, 8, true, false);
      const upward = select(emptyGridSelection(), 5, false, false);
      const pastUpperAnchor = select(upward, 10, true, false);
      const reverseUp = select(pastUpperAnchor, 8, true, false);

      const ranges = kind === "rows" ? reversed.rows : reversed.columns;
      const reverseRanges =
        kind === "rows" ? reverseUp.rows : reverseUp.columns;
      expect(ranges.ranges()).toEqual([[8, 11]]);
      expect(reverseRanges.ranges()).toEqual([[5, 9]]);
    },
  );

  it("updates full-axis anchors on additive clicks and clears foreign anchors", () => {
    const rows = selectRow(emptyGridSelection(), 10, false, false);
    const additive = selectRow(rows, 2, false, true);
    const extended = selectRow(additive, 4, true, false);
    const column = selectColumn(extended, 3, false, false);
    const cell = selectCell(column, { row: 1, column: 1 }, false, false);

    expect(extended.rowAnchor).toBe(2);
    expect(extended.rows.ranges()).toEqual([[2, 5]]);
    expect(column).toMatchObject({ columnAnchor: 3 });
    expect(column.rowAnchor).toBeUndefined();
    expect(cell.columnAnchor).toBeUndefined();
  });

  it.each([["rows", selectRow] as const, ["columns", selectColumn] as const])(
    "extends legacy %s selections from their first index",
    (kind, select) => {
      const initial = emptyGridSelection();
      const legacy = {
        ...initial,
        [kind]: CompactSelection.fromSingleSelection([10, 13]),
      };

      const extended = select(legacy, 5, true, false);

      const ranges = kind === "rows" ? extended.rows : extended.columns;
      expect(ranges.ranges()).toEqual([[5, 11]]);
    },
  );

  it("bounds and normalizes the Cartesian union selection scope", () => {
    expect(
      boundedSelectionScope(
        {
          columns: CompactSelection.empty(),
          rows: CompactSelection.fromSingleSelection([9, 20]),
          current: {
            cell: { row: 3, column: 2 },
            range: { x: 2, y: 3, width: 3, height: 3 },
            rangeStack: [{ x: 0, y: 1, width: 2, height: 3 }],
          },
        },
        10,
        5,
      ),
    ).toEqual({
      columnIndices: [0, 1, 2, 3, 4],
      rowCount: 6,
      rowRanges: [
        [1, 6],
        [9, 10],
      ],
    });
  });
});
