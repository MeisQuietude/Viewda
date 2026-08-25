import { describe, expect, it } from "vitest";

import {
  CompactSelection,
  CopyBufferLimitError,
  IncrementalCopyBuffer,
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

describe("IncrementalCopyBuffer", () => {
  const build = (
    rows: readonly (readonly string[])[],
    columnIndices: readonly number[],
    characterLimit?: number,
  ) => {
    const buffer = new IncrementalCopyBuffer(characterLimit);
    rows.forEach((row, rowIndex) => {
      columnIndices.forEach((column, columnIndex) => {
        buffer.beginCell(row[column] ?? "", columnIndex === 0, rowIndex === 0);
        while (!buffer.stepCell(Infinity, 1).done) {
          // One-unit steps assert that escaping can stop between large chunks.
        }
      });
      buffer.endRow();
    });
    return buffer.finish();
  };

  it("uses lossless values in requested column order", () => {
    expect(
      build(
        [
          ["12345678901234567890", "🙂"],
          ["", "line"],
        ],
        [1, 0],
      ),
    ).toMatchObject({
      textPlain: "🙂\t12345678901234567890\nline\t",
    });
  });

  it("quotes TSV values without changing their shape", () => {
    expect(build([["tab\tvalue", 'line\n"quoted"']], [0, 1])).toMatchObject({
      textPlain: '"tab\tvalue"\t"line\n""quoted"""',
    });
  });

  it("escapes HTML and preserves whitespace inside table cells", () => {
    expect(build([["<value>  one\nnext", "A & B"]], [1, 0])).toMatchObject({
      textHtml:
        '<table><tbody><tr><td style="white-space: pre-wrap">A &amp; B</td><td style="white-space: pre-wrap">&lt;value&gt;  one<br>next</td></tr></tbody></table>',
    });
  });

  it("caps aggregate plain and HTML output before final joins", () => {
    expect(build([["1234"]], [0], 87)).toBeDefined();
    expect(() => build([["12345"]], [0], 87)).toThrow(CopyBufferLimitError);
  });

  it("accounts for escaped expansion incrementally", () => {
    expect(() => build([["&".repeat(100)]], [0], 400)).toThrow(
      CopyBufferLimitError,
    );
  });
});
