import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve("ui/src/styles.css"), "utf8");

describe("color theme", () => {
  it("keeps statistics errors readable in the dark sidebar", () => {
    const darkRoot = styles.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/s,
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
      /@media \(prefers-color-scheme:\s*dark\)[\s\S]*\.schema-type\s*\{\s*color:\s*#b6bbba;\s*\}/,
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
