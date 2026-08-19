import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { gridFontStrings } from "./grid-typography";

describe("grid measurement typography", () => {
  it("uses the variables that define rendered header and cell fonts", () => {
    const root = document.documentElement;
    root.style.setProperty("--grid-font-size", "13px");
    root.style.setProperty("--grid-header-font-weight", "650");
    root.style.setProperty("--font-ui", "Viewda UI");
    root.style.setProperty("--font-mono", "Viewda Mono");

    expect(gridFontStrings(getComputedStyle(root))).toEqual({
      header: "650 13px Viewda UI",
      cell: "13px Viewda UI",
      monospaceCell: "13px Viewda Mono",
    });

    root.style.removeProperty("--grid-font-size");
    root.style.removeProperty("--grid-header-font-weight");
    root.style.removeProperty("--font-ui");
    root.style.removeProperty("--font-mono");
  });

  it("keeps the renderer styles on the measurement variables", () => {
    const styles = readFileSync("ui/src/styles.css", "utf8");

    expect(styles).toMatch(
      /\.viewda-grid \{[^}]*font-size: var\(--grid-font-size\);/s,
    );
    expect(styles).toMatch(
      /\.viewda-grid-column-header \{[^}]*font-weight: var\(--grid-header-font-weight\);/s,
    );
    expect(styles).toMatch(
      /\.mode-switch button \{[^}]*font-size: 12px;[^}]*font-weight: 600;/s,
    );
  });
});
