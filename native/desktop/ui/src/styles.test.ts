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
  it("shares name priority and type truncation across schema trees", () => {
    expect(styles).toMatch(
      /\.schema-field\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s,
    );
    expect(styles).toMatch(
      /\.schema-type\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.schema-tree \.schema-field\s*\{[^}]*grid-template-columns:\s*subgrid;/s,
    );
    expect(styles).toMatch(
      /\.sidebar-schema-tree \.schema-field\s*\{[^}]*min-height:\s*30px;[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\);/s,
    );
  });

  it("keeps field type colors in the light and dark themes", () => {
    expect(styles).toMatch(/\.schema-type\s*\{[^}]*color:\s*#777c7c;/s);
    expect(styles).toMatch(
      /:root\[data-theme="dark"\] \.schema-type\s*\{\s*color:\s*#b6bbba;\s*\}/,
    );
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
