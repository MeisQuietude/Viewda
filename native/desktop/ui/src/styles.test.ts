import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("ui/src/styles.css"), "utf8");

describe("color theme", () => {
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
      /\.query-where,\s*\.query-order\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    );
    expect(styles).toMatch(
      /\.where-popup\s*\{[^}]*max-height:[^}]*overflow:\s*auto;[^}]*white-space:\s*normal;/s,
    );
    expect(styles).toMatch(
      /\.sort-popup\s*\{[^}]*max-height:[^}]*overflow:\s*auto;[^}]*color:\s*var\(--grid-text\);[^}]*background:\s*var\(--grid-header\);[^}]*white-space:\s*normal;/s,
    );
    expect(styles).toMatch(
      /\.query-expression\s*\{[^}]*font-family:\s*ui-monospace,/s,
    );
  });

  it("uses primary and muted theme tokens in both color schemes", () => {
    expect(styles).toMatch(
      /\.query-keyword,\s*\.query-empty-slot,\s*\.query-count\s*\{\s*color:\s*var\(--grid-text-faint\);/s,
    );
    expect(styles).toMatch(/\.query-slot\s*\{\s*color:\s*var\(--grid-text\);/s);
    const darkRoot = styles.match(
      /:root\[data-theme="dark"\] \{([^}]*)\}/s,
    )?.[1];
    expect(darkRoot).toBeDefined();
    expect(darkRoot).toMatch(/--grid-text:\s*#[0-9a-f]{6};/i);
    expect(darkRoot).toMatch(/--grid-text-faint:\s*#[0-9a-f]{6};/i);
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
