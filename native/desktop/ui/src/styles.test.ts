import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const styles = readFileSync(resolve("ui/src/styles.css"), "utf8");
const parsedStyleElement = document.createElement("style");
parsedStyleElement.textContent = styles;
document.head.append(parsedStyleElement);
afterAll(() => parsedStyleElement.remove());

function declaration(
  selector: string,
  property: string,
  mediaCondition?: string,
): string {
  const sheet = parsedStyleElement.sheet;
  if (sheet === null) {
    throw new Error("Stylesheet could not be parsed.");
  }
  const rules =
    mediaCondition === undefined
      ? Array.from(sheet.cssRules).filter(
          (rule) => rule.type === CSSRule.STYLE_RULE,
        )
      : Array.from(sheet.cssRules).flatMap((rule) =>
          rule.type === CSSRule.MEDIA_RULE &&
          (rule as CSSMediaRule).conditionText === mediaCondition
            ? Array.from((rule as CSSMediaRule).cssRules)
            : [],
        );
  const value = rules
    .filter(
      (candidate) =>
        candidate.type === CSSRule.STYLE_RULE &&
        (candidate as CSSStyleRule).selectorText
          .split(",")
          .map((part) => part.trim())
          .includes(selector),
    )
    .map((rule) =>
      (rule as CSSStyleRule).style.getPropertyValue(property).trim(),
    )
    .filter(Boolean)
    .at(-1);
  if (value === undefined || value === "") {
    throw new Error(`Missing ${property} for ${selector}.`);
  }
  return value;
}

function hasSelector(selector: string): boolean {
  const sheet = parsedStyleElement.sheet;
  if (sheet === null) return false;
  return Array.from(sheet.cssRules).some(
    (rule) =>
      rule.type === CSSRule.STYLE_RULE &&
      (rule as CSSStyleRule).selectorText
        .split(",")
        .map((part) => part.trim())
        .includes(selector),
  );
}

function expectDeclarations(
  selector: string,
  expected: Record<string, string>,
  mediaCondition?: string,
) {
  for (const [property, value] of Object.entries(expected)) {
    expect(declaration(selector, property, mediaCondition)).toBe(value);
  }
}

describe("font stacks", () => {
  it("keeps native emoji ahead of generic fonts and the bundled fallback last", () => {
    expect(styles).toMatch(
      /--font-ui:[^;]*"Apple Color Emoji"[^;]*sans-serif,[^;]*"Noto Emoji";/s,
    );
    expect(styles).toMatch(
      /--font-mono:[^;]*"Apple Color Emoji"[^;]*monospace,[^;]*"Noto Emoji";/s,
    );
  });

  it("reuses the monospace stack instead of copying its font list", () => {
    expect(declaration(".viewda-grid-cell.is-monospace", "font-family")).toBe(
      "var(--font-mono)",
    );
    expect(styles).not.toMatch(/font-family:\s*ui-monospace/);
  });
});

describe("grid performance status", () => {
  it("keeps the floating shell compact and bounded on narrow windows", () => {
    expectDeclarations(".grid-performance-recording-status", {
      right: "12px",
      bottom: "12px",
      "max-width": "calc(100% - 24px)",
      display: "flex",
      "flex-wrap": "wrap",
      gap: "6px",
      padding: "6px",
    });
    expectDeclarations(".grid-performance-recording-status.is-completed", {
      width: "max-content",
    });
    expectDeclarations(".grid-performance-copy-error", {
      flex: "1 0 100%",
      "max-width": "320px",
    });
  });

  it("uses equal icon hit targets and separates the final dismiss action", () => {
    expectDeclarations(".grid-performance-icon-button", {
      display: "grid",
      width: "28px",
      height: "28px",
    });
    expectDeclarations(".grid-performance-status-actions", {
      display: "flex",
      gap: "4px",
    });
    expectDeclarations(".grid-performance-dismiss", {
      "margin-left": "5px",
      color: "var(--grid-text-muted)",
      background: "transparent",
    });
    expectDeclarations(".grid-performance-dismiss::before", { left: "-5px" });
    expect(
      declaration(".grid-performance-dismiss::before", "border-left"),
    ).toContain("var(--grid-border)");
    expectDeclarations(".grid-performance-record-again", {
      color: "var(--grid-text-muted)",
      background: "transparent",
    });
  });

  it("swaps the copy glyph without changing its geometry", () => {
    expectDeclarations(".grid-performance-copy", {
      color: "var(--grid-header)",
      background: "var(--grid-text)",
    });
    expectDeclarations(".grid-performance-copy-icons svg", {
      "grid-area": "1 / 1",
    });
    expect(
      declaration(".grid-performance-copy-icons svg", "transition"),
    ).toMatch(/opacity 140ms ease,\s*transform 140ms ease/);
    expectDeclarations(".grid-performance-copy.is-copied", {
      color: "var(--success-text)",
    });
    expectDeclarations(
      ".grid-performance-copy.is-copied .grid-performance-copy-check",
      { opacity: "1", transform: "scale(1)" },
    );
    expectDeclarations(
      ".grid-performance-copy-icons svg",
      { transition: "none" },
      "(prefers-reduced-motion: reduce)",
    );
  });

  it("hides success text visually while leaving copy failures visible", () => {
    expectDeclarations(".grid-performance-live", {
      position: "absolute",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      clip: "rect(0px)",
    });
    expectDeclarations(".grid-performance-copy-error", {
      color: "var(--error-text)",
      "line-height": "1.3",
    });
  });
});

describe("color theme", () => {
  it("keeps plain header ellipsis and isolates the trailing path separator", () => {
    expectDeclarations(".viewda-grid-header-title", {
      flex: "1 1 auto",
      "min-width": "0px",
      overflow: "hidden",
    });
    expectDeclarations(".viewda-grid-header-title.is-plain", {
      display: "block",
      "text-overflow": "ellipsis",
    });
    expectDeclarations(".viewda-grid-header-prefix-text", {
      direction: "rtl",
      "text-overflow": "ellipsis",
    });
    expectDeclarations(".viewda-grid-header-prefix-content", {
      direction: "ltr",
      "unicode-bidi": "isolate",
    });
    expectDeclarations(".viewda-grid-header-bidi-control", {
      display: "none",
    });
    expectDeclarations(".viewda-grid-header-prefix-separator", {
      direction: "ltr",
      "unicode-bidi": "isolate",
      flex: "0 0 auto",
    });
    expect(() => declaration(".viewda-grid-header-leaf", "color")).toThrow(
      "Missing color",
    );
  });

  it("keeps flattened group rails continuous and visible in both themes", () => {
    expectDeclarations(".viewda-grid-group-rail", {
      right: "-1px",
      height: "2px",
      background: "var(--grid-selection-strong)",
      "pointer-events": "none",
    });
    expect(() => declaration(".viewda-grid-group-rail", "opacity")).toThrow(
      "Missing opacity",
    );
    expectDeclarations(
      ".viewda-grid-column-header.has-group-start .viewda-grid-group-rail",
      { left: "4px" },
    );
    expectDeclarations(
      ".viewda-grid-column-header.has-group-end .viewda-grid-group-rail",
      { right: "4px" },
    );

    const lightRoot = styles.match(/:root \{([^}]*)\}/s)?.[1];
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(lightRoot).toBeDefined();
    expect(darkRoot).toBeDefined();
    if (lightRoot === undefined || darkRoot === undefined) {
      throw new Error("Theme variables are missing.");
    }
    for (const root of [lightRoot, darkRoot]) {
      expect(
        contrastRatio(
          readColorVariable(root, "grid-selection-strong"),
          readColorVariable(root, "grid-header"),
        ),
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps picker path leaves visible and plain names tail-truncated", () => {
    expectDeclarations(".column-picker-name", {
      display: "flex",
      overflow: "hidden",
    });
    expectDeclarations(".column-picker-name.is-plain", {
      display: "block",
      "text-overflow": "ellipsis",
    });
  });

  it("does not let pinned positioning hide selection colors", () => {
    expect(() =>
      declaration(".viewda-grid-cell.is-pinned", "background"),
    ).toThrow("Missing background");
    expect(declaration(".viewda-grid-cell.is-selected", "background")).toBe(
      "var(--grid-selection)",
    );
  });

  it("keeps row markers interactive without highlighting hovered data cells", () => {
    expect(declaration(".viewda-grid-row-marker:hover", "background")).toBe(
      "var(--grid-header-hover)",
    );
    expect(hasSelector(".viewda-grid-cell:hover")).toBe(false);
  });

  it("keeps a persistent cross-platform horizontal scrollbar lane", () => {
    expectDeclarations(".viewda-grid-horizontal-scrollbar", {
      position: "relative",
      height: "14px",
      overflow: "hidden",
      flex: "0 0 14px",
      "touch-action": "none",
    });
    expectDeclarations(".viewda-grid-horizontal-scrollport", {
      position: "absolute",
      inset: "0px",
      overflow: "hidden",
      "pointer-events": "none",
    });
    expectDeclarations(".viewda-grid-horizontal-thumb", {
      top: "3px",
      height: "8px",
      background: "var(--grid-text-faint)",
      opacity: "1",
      "pointer-events": "none",
    });
  });

  it("keeps statistics errors readable in the dark sidebar", () => {
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(darkRoot).toBeDefined();
    if (darkRoot === undefined) {
      throw new Error("Dark theme variables are missing.");
    }

    const errorText = readColorVariable(darkRoot, "error-text");
    const sidebarBackground = readColorVariable(darkRoot, "grid-header");
    expect(contrastRatio(errorText, sidebarBackground)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(styles).toMatch(
      /\.statistics-error\s*\{\s*color: var\(--error-text\);\s*\}/,
    );
  });

  it("uses theme variables for export menus and progress states", () => {
    expect(styles).toMatch(
      /\.column-menu,\s*\.grid-menu\s*\{[^}]*color:\s*var\(--grid-text\);[^}]*background:\s*var\(--grid-header\);/s,
    );
    expect(styles).toMatch(
      /\.export-progress\s*\{[^}]*color:\s*var\(--grid-text-muted\);[^}]*background:\s*var\(--grid-header\);/s,
    );
    expect(styles).toMatch(
      /\.export-progress\.is-error\s*\{\s*color:\s*var\(--error-text\);\s*\}/,
    );
  });

  it("keeps null cells subtle and independent of column typography", () => {
    const root = ':root[data-theme="dark"]';
    const normal = declaration(root, "--grid-cell");
    const muted = declaration(root, "--grid-cell-muted");
    const header = declaration(root, "--grid-header");
    expect(muted).toBe("#191b1c");
    expect(muted).not.toBe(normal);
    expect(muted).not.toBe(header);
    expect(
      Math.abs(relativeLuminance(muted) - relativeLuminance(normal)),
    ).toBeLessThan(
      Math.abs(relativeLuminance(muted) - relativeLuminance(header)),
    );
    expectDeclarations(".viewda-grid-cell.is-faded", {
      color: "var(--grid-text-faint)",
      background: "var(--grid-cell-muted)",
      "font-family": "var(--font-ui)",
    });
    const fadedMonospaceCell = document.createElement("div");
    fadedMonospaceCell.className = "viewda-grid-cell is-monospace is-faded";
    document.body.append(fadedMonospaceCell);
    expect(getComputedStyle(fadedMonospaceCell).fontFamily).toBe(
      "var(--font-ui)",
    );
    fadedMonospaceCell.remove();
  });
});

describe("grid layout containment", () => {
  it("gives the virtualized grid a bounded flex parent", () => {
    expectDeclarations(".grid-container", {
      display: "flex",
      "min-height": "0px",
      overflow: "hidden",
    });
  });

  it("reserves a stable notice lane outside the interactive grid", () => {
    expectDeclarations(".data-grid-view::before", {
      "min-height": "32px",
      flex: "0 0 32px",
      order: "1",
    });
    expectDeclarations(
      ".data-grid-view > :not(.query-row):not(.grid-controls)",
      { order: "2" },
    );
    expectDeclarations(".grid-controls", {
      position: "absolute",
      top: "34px",
      right: "0px",
      left: "0px",
      height: "32px",
      "min-height": "32px",
    });
    expectDeclarations(".query-row", { flex: "0 0 34px" });
  });

  it("lets tiny viewport placement override Peek's normal resize floor", () => {
    expectDeclarations(".value-peek", {
      "min-width": "0px",
      "min-height": "0px",
    });
    expect(styles).not.toMatch(/\.value-peek\s*\{[^}]*resize:/s);
    expectDeclarations(".value-peek-resize-hint", {
      width: "14px",
      height: "14px",
      cursor: "nwse-resize",
      "touch-action": "none",
    });
  });

  it("reserves default-width space for ordinary Peek leaf types", () => {
    expect(styles).toMatch(
      /\.value-tree-row\s*\{[^}]*grid-template-columns:\s*16px minmax\(36px,\s*0\.7fr\) minmax\(40px,\s*1\.3fr\) minmax\(\s*14ch,\s*1fr\s*\);/s,
    );
    expectDeclarations(".value-tree-preview", {
      overflow: "hidden",
      "text-overflow": "ellipsis",
    });
    expectDeclarations(".value-tree-type", {
      overflow: "hidden",
      "text-overflow": "ellipsis",
    });
  });

  it("aligns the compact binary legend and rows without a content floor", () => {
    expect(styles).toMatch(
      /\.value-peek-binary-head,\s*\.value-peek-binary-row\s*\{[^}]*grid-template-columns:\s*8ch minmax\(0,\s*23ch\) 8ch;/s,
    );
    expectDeclarations(".value-peek-binary-spacer", {
      position: "relative",
      "min-width": "100%",
    });
  });

  it("places scalar and binary detail directly below the root row", () => {
    expectDeclarations(".value-tree-wrap.has-detail .value-tree", {
      "min-height": "28px",
      overflow: "hidden",
      flex: "0 0 28px",
    });
    expectDeclarations(".value-tree-wrap.has-detail .value-peek-detail", {
      "min-height": "0px",
      "max-height": "none",
      flex: "1 1 0%",
    });
  });

  it("moves only the scrolling header outside native body layout", () => {
    expect(declaration(".viewda-grid-scrolling-headers", "will-change")).toBe(
      "transform",
    );
    expect(() =>
      declaration(".viewda-grid-row-scrolling-cells", "transform"),
    ).toThrow("Missing transform");
    expect(() =>
      declaration(".viewda-grid-row-scrolling-cells", "will-change"),
    ).toThrow("Missing will-change");
    expect(styles).not.toContain("--viewda-grid-scroll-left");
  });
});

describe("schema field layout", () => {
  it("keeps name priority and type truncation in the Data schema tree", () => {
    expect(styles).toMatch(
      /\.schema-field\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.schema-type\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.sidebar-schema-tree \.schema-field\s*\{[^}]*min-height:\s*30px;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s,
    );
  });

  it("keeps field type colors in the light and dark themes", () => {
    expect(styles).toMatch(
      /\.schema-type\s*\{[^}]*color:\s*var\(--grid-text-muted\);/s,
    );
    expect(styles).toMatch(
      /:root\[data-theme="dark"\] \.schema-type\s*\{\s*color:\s*#b6bbba;\s*\}/,
    );
  });

  it("keeps selectable schema fields readable on dark surfaces", () => {
    const darkVariables = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(darkVariables).toBeDefined();
    if (darkVariables === undefined) {
      throw new Error("Dark theme variables are missing.");
    }
    expect(declaration(".schema-field", "color")).toBe("inherit");
    expect(
      contrastRatio(
        readColorVariable(darkVariables, "grid-text"),
        readColorVariable(darkVariables, "grid-cell"),
      ),
    ).toBeGreaterThanOrEqual(4.5);

    expect(
      declaration(
        ".sidebar-schema-tree button.schema-field:hover:not(:disabled)",
        "background",
      ),
    ).toBe("var(--grid-selection)");
    expect(
      declaration(
        '.sidebar-schema-tree button.schema-field[aria-pressed="true"]:not(:disabled)',
        "background",
      ),
    ).toBe("var(--grid-selection)");
    expect(
      declaration(
        ".sidebar-schema-tree button.schema-field:focus-visible",
        "outline",
      ),
    ).toBe("2px solid var(--grid-selection-strong)");
    expectDeclarations(".sidebar-schema-tree button.schema-field:disabled", {
      color: "var(--grid-text-faint)",
      cursor: "default",
    });
    expect(
      declaration(
        ".sidebar-schema-tree button.schema-field:disabled .schema-type",
        "color",
      ),
    ).toBe("inherit");
    expectDeclarations(".sidebar-schema-tree .schema-flatten-action:disabled", {
      color: "var(--grid-text-faint)",
      cursor: "default",
    });
    expectDeclarations(".sidebar-schema-tree .schema-flatten-action", {
      display: "grid",
      "justify-items": "start",
      "line-height": "1.2",
    });
    expectDeclarations(
      ".sidebar-schema-tree .schema-flatten-action .menu-shortcut",
      { "font-size": "9px" },
    );
    expect(
      declaration(
        ".sidebar-schema-tree .schema-flatten-action:hover:not(:disabled)",
        "background",
      ),
    ).toBe("var(--grid-selection)");
  });
});

describe("structure workspace hierarchy", () => {
  it("keeps the quiet action header clear of section anchors", () => {
    expectDeclarations(".mode-panel.structure-mode-panel", {
      position: "relative",
      display: "block",
      overflow: "auto",
      isolation: "isolate",
    });
    expectDeclarations(".titlebar", {
      position: "relative",
      "z-index": "10",
      background: "var(--app-background)",
    });
    expectDeclarations(".source-heading", {
      position: "sticky",
      top: "0px",
      "min-height": "46px",
      background: "var(--app-background)",
    });
    expect(declaration(".structure-mode-panel", "scroll-padding-top")).toBe(
      "58px",
    );
    expect(declaration(".structure-card", "scroll-margin-top")).toBe("58px");
    expectDeclarations(".source-heading .open-button", {
      "min-height": "32px",
      color: "var(--grid-text-muted)",
      background: "var(--grid-cell-muted)",
    });
  });

  it("uses open facts and dividers instead of nested cards", () => {
    expect(declaration(".source-view", "width")).toContain("1180px");
    expectDeclarations(".source-summary-row", {
      display: "grid",
      "border-top": "1px solid var(--grid-border-soft)",
    });
    expectDeclarations(".structure-card", {
      "border-top": "1px solid var(--grid-border)",
      "border-radius": "0px",
      background: "transparent",
    });
    expectDeclarations(".chunk-map-details", {
      "padding-top": "10px",
      "border-top": "1px solid var(--grid-border-soft)",
    });
  });

  it("wraps primary facts and reserves monospace for technical values", () => {
    expect(declaration(".source-summary-fact strong", "overflow-wrap")).toBe(
      "anywhere",
    );
    expect(declaration(".source-summary .is-technical", "font-family")).toBe(
      "var(--font-mono)",
    );
    expectDeclarations(".structure-help-info", {
      width: "15px",
      height: "15px",
      cursor: "help",
    });
  });

  it("keeps Structure actions and chunk text readable in both themes", () => {
    expect(declaration(".copy-structure-report button", "color")).toBe(
      "var(--grid-text-muted)",
    );
    for (const selector of [
      ".chunk-panel-heading span",
      ".chunk-panel-heading button",
      ".chunk-section p",
      ".probe-results",
    ]) {
      expect(declaration(selector, "color")).toBe("var(--grid-text-muted)");
    }
    expect(declaration(".chunk-facts dt", "color")).toBe(
      "var(--grid-text-muted)",
    );
    for (const selector of [".chunk-panel-heading h3", ".chunk-section h4"]) {
      expect(declaration(selector, "color")).toBe("var(--grid-text)");
    }

    const lightRoot = styles.match(/:root \{([^}]*)\}/s)?.[1];
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(lightRoot).toBeDefined();
    expect(darkRoot).toBeDefined();
    if (lightRoot === undefined || darkRoot === undefined) {
      throw new Error("Theme variables are missing.");
    }
    for (const root of [lightRoot, darkRoot]) {
      const background = readColorVariable(root, "grid-cell");
      expect(
        contrastRatio(readColorVariable(root, "grid-text-muted"), background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(readColorVariable(root, "grid-text-faint"), background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(readColorVariable(root, "grid-text"), background),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(readColorVariable(root, "bloom-marker"), background),
      ).toBeGreaterThanOrEqual(3);
    }
    expect(styles).not.toContain("color: #777c7c");
    expectDeclarations(".bloom-probe input", {
      border: "1px solid var(--grid-selection-strong)",
    });
    expectDeclarations(".bloom-probe input:focus-visible", {
      outline: "2px solid var(--grid-text)",
    });
  });

  it("keeps structure tables dense and visually continuous in both themes", () => {
    expectDeclarations(".structure-grid", {
      height: "var(--structure-grid-height, 320px)",
      "--grid-header": "transparent",
      "--grid-cell": "transparent",
    });
    expectDeclarations(':root[data-theme="dark"] .structure-grid', {
      "--grid-header": "transparent",
      "--grid-cell": "transparent",
    });
  });

  it("fits equal layout cells in the canvas and leaves rows in document flow", () => {
    expectDeclarations(".layout-axis-items", {
      display: "grid",
      "min-width": "0px",
      overflow: "hidden",
    });
    expectDeclarations(".layout-row-track", {
      display: "grid",
      width: "100%",
      "min-width": "0px",
      overflow: "hidden",
    });
    expectDeclarations(".layout-tail:focus-visible", {
      outline: "2px solid var(--grid-selection-strong)",
      "outline-offset": "-2px",
    });
    const rows = styles.match(/\.layout-rows\s*\{([^}]*)\}/s)?.[1];
    expect(rows).toBeDefined();
    expect(rows).not.toMatch(/max-height|overflow-y/);
  });
});

describe("query row", () => {
  it("keeps its popups above the grid column headers", () => {
    expect(Number(declaration(".query-row", "z-index"))).toBeGreaterThan(
      Number(declaration(".viewda-grid-header", "z-index")),
    );
  });

  it("keeps inline clauses clipped and their popups complete", () => {
    expect(styles).toMatch(
      /\.query-where,\s*\.query-order,\s*\.query-select\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.where-popup\s*\{[^}]*position:\s*fixed;[^}]*max-height:[^}]*overflow:\s*auto;[^}]*white-space:\s*normal;/s,
    );
    expect(styles).toMatch(
      /\.where-popup\.is-empty\s*\{[^}]*width:\s*min\(140px,\s*calc\(100vw - 32px\)\);/s,
    );
    expect(styles).toMatch(/\.where-popup p\s*\{[^}]*font-size:\s*11px;/s);
    expect(styles).toMatch(
      /\.sort-popup\s*\{[^}]*max-height:[^}]*overflow:\s*auto;[^}]*color:\s*var\(--grid-text\);[^}]*background:\s*var\(--grid-header\);[^}]*white-space:\s*normal;/s,
    );
    expect(styles).toMatch(
      /\.query-expression\s*\{[^}]*font-family:\s*var\(--font-mono\);/s,
    );
  });

  it("uses primary and muted theme tokens in both color schemes", () => {
    expect(styles).toMatch(
      /\.query-keyword,\s*\.query-empty-slot,\s*\.query-count\s*\{\s*color:\s*var\(--grid-text-faint\);/s,
    );
    expect(styles).toMatch(
      /\.query-where,\s*\.query-order,\s*\.query-select\s*\{[^}]*color:\s*var\(--grid-text\);/s,
    );
    expect(styles).toMatch(
      /\.column-picker-type,\s*\.column-picker-count\s*\{\s*color:\s*var\(--grid-text-faint\);/s,
    );
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(darkRoot).toBeDefined();
    expect(darkRoot).toMatch(/--grid-text:\s*#[0-9a-f]{6};/i);
    expect(darkRoot).toMatch(/--grid-text-faint:\s*#[0-9a-f]{6};/i);
  });

  it("keeps the fit-width action faint with a restrained hover", () => {
    expectDeclarations(".query-fit-widths", {
      color: "var(--grid-text-faint)",
    });
    expectDeclarations(".query-fit-widths:hover", {
      color: "var(--grid-text-muted)",
      background: "var(--grid-selection)",
    });
  });

  it("distinguishes selected columns and sizes their types by content", () => {
    expect(styles).toMatch(
      /\.column-picker\s*\{[^}]*width:\s*min\(520px,\s*calc\(100vw - 32px\)\);/s,
    );
    expect(styles).toMatch(
      /\.column-picker-row\s*\{[^}]*grid-template-columns:\s*auto auto minmax\(0,\s*1fr\) fit-content\(50%\);/s,
    );
    expect(styles).toMatch(
      /\.column-picker-row input\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*accent-color:\s*var\(--update-accent\);/s,
    );
    expect(styles).toMatch(
      /\.column-picker-type\s*\{[^}]*overflow:\s*hidden;[^}]*text-align:\s*left;[^}]*text-overflow:\s*ellipsis;/s,
    );
    expect(styles).toMatch(
      /\.column-picker-pin\[aria-pressed="true"\]\s*\{\s*color:\s*var\(--update-accent\);/s,
    );
  });
});

describe("filter editor actions", () => {
  it("keeps suggestion matches readable in both themes", () => {
    const lightRoot = styles.match(/:root \{([^}]*)\}/s)?.[1];
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(lightRoot).toBeDefined();
    expect(darkRoot).toBeDefined();
    if (lightRoot === undefined || darkRoot === undefined) {
      throw new Error("Theme variables are missing.");
    }

    for (const root of [lightRoot, darkRoot]) {
      const text = readColorVariable(root, "suggestion-match-text");
      const background = readColorVariable(root, "suggestion-match");
      expect(contrastRatio(text, background)).toBeGreaterThanOrEqual(4.5);
    }

    expect(styles).toMatch(
      /button mark\s*\{\s*color:\s*var\(--suggestion-match-text\);\s*background:\s*var\(--suggestion-match\);\s*\}/,
    );
    expect(styles).toMatch(
      /button\[data-overflow-start\]\[data-overflow-end\]\s*\{[^}]*-webkit-mask-image:\s*linear-gradient\([^}]*mask-image:\s*linear-gradient\(/s,
    );
  });

  it("keeps the primary action readable on hover in both themes", () => {
    const lightRoot = styles.match(/:root \{([^}]*)\}/s)?.[1];
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(lightRoot).toBeDefined();
    expect(darkRoot).toBeDefined();
    if (lightRoot === undefined || darkRoot === undefined) {
      throw new Error("Theme variables are missing.");
    }

    for (const root of [lightRoot, darkRoot]) {
      const text = readColorVariable(root, "grid-selection-text");
      const background = readColorVariable(root, "grid-selection-strong");
      const hoverBackground = mixColors(
        background,
        readColorVariable(root, "grid-text"),
        0.88,
      );
      expect(contrastRatio(text, hoverBackground)).toBeGreaterThan(
        contrastRatio(text, background),
      );
    }

    expect(styles).toMatch(
      /\.filter-editor-actions button:not\(:last-child\):hover:not\(:disabled\)\s*\{\s*background:\s*var\(--grid-selection\);/s,
    );
    expect(styles).toMatch(
      /\.filter-editor-actions button:last-child:hover:not\(:disabled\)\s*\{\s*background:\s*color-mix\(\s*in srgb,\s*var\(--grid-selection-strong\) 88%,\s*var\(--grid-text\)\s*\);/s,
    );
  });
});

function readColorVariable(block: string, name: string): string {
  const value = block.match(
    new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`, "i"),
  )?.[1];
  expect(value).toBeDefined();
  if (value === undefined) {
    throw new Error(`Color variable --${name} is missing.`);
  }
  return value;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixColors(first: string, second: string, firstWeight: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const firstChannel = Number.parseInt(first.slice(offset, offset + 2), 16);
    const secondChannel = Number.parseInt(second.slice(offset, offset + 2), 16);
    return Math.round(
      firstChannel * firstWeight + secondChannel * (1 - firstWeight),
    )
      .toString(16)
      .padStart(2, "0");
  });
  return `#${channels.join("")}`;
}

function relativeLuminance(color: string): number {
  const channels = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  const [red, green, blue] = channels;
  if (red === undefined || green === undefined || blue === undefined) {
    throw new Error(`Invalid color: ${color}`);
  }
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
