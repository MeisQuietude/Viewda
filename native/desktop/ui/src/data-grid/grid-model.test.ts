import { describe, expect, it } from "vitest";

import {
  CompactSelection,
  copyBufferContents,
  type GridCell,
} from "./grid-model";

describe("CompactSelection", () => {
  it("keeps a billion-row range compact", () => {
    const selection = CompactSelection.fromSingleSelection([2, 1_000_000_002]);

    expect(selection.length).toBe(1_000_000_000);
    expect(selection.first()).toBe(2);
    expect(selection.last()).toBe(1_000_000_001);
    expect(selection.ranges()).toEqual([[2, 1_000_000_002]]);
  });

  it("normalizes additions and range removals", () => {
    const selection = CompactSelection.empty()
      .add([3, 8])
      .add([0, 4])
      .remove([2, 6]);

    expect(selection.ranges()).toEqual([
      [0, 2],
      [6, 8],
    ]);
    expect([...selection]).toEqual([0, 1, 6, 7]);
  });
});

describe("copyBufferContents", () => {
  const cell = (copyData: string): GridCell => ({
    kind: "text",
    displayData: copyData,
    copyData,
    alignment: "left",
    faded: false,
  });

  it("uses lossless values in requested column order", () => {
    expect(
      copyBufferContents(
        [
          [cell("12345678901234567890"), cell("🙂")],
          [cell(""), cell("line")],
        ],
        [1, 0],
      ).textPlain,
    ).toBe("🙂\t12345678901234567890\nline\t");
  });

  it("quotes TSV values without changing their shape", () => {
    expect(
      copyBufferContents([[cell("tab\tvalue"), cell('line\n"quoted"')]], [0, 1])
        .textPlain,
    ).toBe('"tab\tvalue"\t"line\n""quoted"""');
  });

  it("escapes HTML and preserves line breaks inside table cells", () => {
    expect(
      copyBufferContents([[cell("<value>\nnext"), cell("A & B")]], [1, 0])
        .textHtml,
    ).toBe(
      "<table><tbody><tr><td>A &amp; B</td><td>&lt;value&gt;<br>next</td></tr></tbody></table>",
    );
  });
});
