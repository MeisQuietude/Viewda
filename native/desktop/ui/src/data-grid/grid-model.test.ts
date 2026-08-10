import { describe, expect, it } from "vitest";

import {
  CompactSelection,
  GridCellKind,
  getCopyBufferContents,
  type GridCell,
} from "./grid-model";

describe("CompactSelection", () => {
  it("keeps large consecutive selections compact and iterable", () => {
    const selection = CompactSelection.fromSingleSelection([2, 1_000_002]);

    expect(selection.length).toBe(1_000_000);
    expect(selection.first()).toBe(2);
    expect(selection.last()).toBe(1_000_001);
    expect([...selection].slice(0, 3)).toEqual([2, 3, 4]);
  });

  it("normalizes additions and splits removals", () => {
    const selection = CompactSelection.empty().add(3).add(1).add(2).remove(2);

    expect([...selection]).toEqual([1, 3]);
    expect(selection.hasIndex(2)).toBe(false);
  });

  it("merges an added range with existing compact ranges", () => {
    const selection = CompactSelection.fromSingleSelection([4, 6]).add([0, 3]);

    expect([...selection]).toEqual([0, 1, 2, 4, 5]);
    expect(selection.length).toBe(5);
  });

  it("unions large selections without expanding their indices", () => {
    const selection = CompactSelection.fromSingleSelection([
      0, 1_000_000_000,
    ]).union(
      CompactSelection.fromSingleSelection([2_000_000_000, 2_000_000_010]),
    );

    expect(selection.length).toBe(1_000_000_010);
    expect(selection.last()).toBe(2_000_000_009);
  });
});

describe("getCopyBufferContents", () => {
  it("uses lossless copy data in requested column order", () => {
    const cell = (displayData: string, copyData: string): GridCell => ({
      kind: GridCellKind.Text,
      displayData,
      copyData,
      contentAlign: "left",
      style: "normal",
    });

    expect(
      getCopyBufferContents(
        [
          [cell("rounded", "12345678901234567890"), cell("🙂", "🙂")],
          [cell("null", ""), cell("line", "line")],
        ],
        [1, 0],
      ).textPlain,
    ).toBe("🙂\t12345678901234567890\nline\t");
  });

  it("quotes tabs, line breaks and quotes without changing the TSV shape", () => {
    const cell = (copyData: string): GridCell => ({
      kind: GridCellKind.Text,
      displayData: copyData,
      copyData,
      contentAlign: "left",
      style: "normal",
    });

    expect(
      getCopyBufferContents(
        [
          [cell("tab\tvalue"), cell("line\nbreak")],
          [cell('a "quote"'), cell("plain")],
        ],
        [0, 1],
      ).textPlain,
    ).toBe('"tab\tvalue"\t"line\nbreak"\n"a ""quote"""\tplain');
  });

  it("provides an HTML table without treating copied values as markup", () => {
    const cell = (copyData: string): GridCell => ({
      kind: GridCellKind.Text,
      displayData: copyData,
      copyData,
      contentAlign: "left",
      style: "normal",
    });

    expect(
      getCopyBufferContents([[cell("<value>\nnext"), cell("A & B")]], [1, 0])
        .textHtml,
    ).toBe(
      "<table><tbody><tr><td>A &amp; B</td><td>&lt;value&gt;<br>next</td></tr></tbody></table>",
    );
  });
});
