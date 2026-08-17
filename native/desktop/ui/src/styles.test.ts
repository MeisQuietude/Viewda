import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("ui/src/styles.css"), "utf8");

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
    expect(styles.match(/font-family:\s*var\(--font-mono\);/g)).toHaveLength(8);
    expect(styles).not.toMatch(/font-family:\s*ui-monospace/);
  });
});

describe("color theme", () => {
  it("does not let pinned positioning hide selection colors", () => {
    const pinnedRule = styles.match(
      /\.viewda-grid-cell\.is-pinned\s*\{([^}]*)\}/s,
    )?.[1];
    expect(pinnedRule).toBeDefined();
    expect(pinnedRule).not.toMatch(/background:/);
    expect(styles).toMatch(
      /\.viewda-grid-cell\.is-selected,[^{]*\{\s*background:\s*var\(--grid-selection\);/s,
    );
  });

  it("keeps row markers interactive without highlighting hovered data cells", () => {
    expect(styles).toMatch(
      /\.viewda-grid-row-marker:hover\s*\{\s*background:\s*var\(--grid-header-hover\);/s,
    );
    expect(styles).not.toMatch(/\.viewda-grid-cell:hover/);
  });

  it("reserves a visible cross-platform horizontal scrollbar lane", () => {
    expect(styles).toMatch(
      /\.viewda-grid-horizontal-scrollport\s*\{[^}]*height:\s*14px;[^}]*overflow-x:\s*scroll;[^}]*flex:\s*0 0 14px;/s,
    );
    expect(styles).toMatch(
      /\.viewda-grid-horizontal-scrollport::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--grid-text-faint\);/s,
    );
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
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(darkRoot).toBeDefined();
    if (darkRoot === undefined) {
      throw new Error("Dark theme variables are missing.");
    }
    const normal = readColorVariable(darkRoot, "grid-cell");
    const muted = readColorVariable(darkRoot, "grid-cell-muted");
    const header = readColorVariable(darkRoot, "grid-header");
    expect(muted).toBe("#191b1c");
    expect(muted).not.toBe(normal);
    expect(muted).not.toBe(header);
    expect(
      Math.abs(relativeLuminance(muted) - relativeLuminance(normal)),
    ).toBeLessThan(
      Math.abs(relativeLuminance(muted) - relativeLuminance(header)),
    );
    expect(styles).toMatch(
      /\.viewda-grid-cell\.is-faded\s*\{[^}]*color:\s*var\(--grid-text-faint\);[^}]*background:\s*var\(--grid-cell-muted\);[^}]*font-family:\s*var\(--font-ui\);/s,
    );
    expect(styles.indexOf(".viewda-grid-cell.is-faded")).toBeGreaterThan(
      styles.indexOf(".viewda-grid-cell.is-monospace"),
    );
  });
});

describe("grid layout containment", () => {
  it("gives the virtualized grid a bounded flex parent", () => {
    expect(styles).toMatch(
      /\.grid-container\s*\{[^}]*display:\s*flex;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden;/s,
    );
  });

  it("moves only the scrolling header outside native body layout", () => {
    const headerRule = styles.match(
      /\.viewda-grid-scrolling-headers\s*\{([^}]*)\}/s,
    )?.[1];
    const rowRule = styles.match(
      /\.viewda-grid-row-scrolling-cells\s*\{([^}]*)\}/s,
    )?.[1];
    expect(headerRule).toMatch(/will-change:\s*transform;/);
    expect(rowRule).toBeDefined();
    expect(rowRule).not.toMatch(/transform|will-change/);
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
  it("keeps inline clauses clipped and their popups complete", () => {
    expect(styles).toMatch(
      /\.query-where,\s*\.query-order,\s*\.query-select\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.where-popup\s*\{[^}]*position:\s*fixed;[^}]*max-height:[^}]*overflow:\s*auto;[^}]*white-space:\s*normal;/s,
    );
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
    expect(styles).toMatch(
      /\.query-fit-widths\s*\{[^}]*color:\s*var\(--grid-text-faint\);/s,
    );
    expect(styles).toMatch(
      /\.query-fit-widths:hover\s*\{\s*color:\s*var\(--grid-text-muted\);\s*background:\s*var\(--grid-selection\);/s,
    );
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
