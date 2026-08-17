export interface GridFontStrings {
  header: string;
  cell: string;
  monospaceCell: string;
}

/** Resolves measurement fonts from the CSS variables used by rendered grid text. */
export function gridFontStrings(styles: CSSStyleDeclaration): GridFontStrings {
  const value = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const size = value("--grid-font-size", "12px");
  const headerWeight = value("--grid-header-font-weight", "600");
  const uiFamily = value("--font-ui", "sans-serif");
  const monospaceFamily = value("--font-mono", "monospace");
  return {
    header: `${headerWeight} ${size} ${uiFamily}`,
    cell: `${size} ${uiFamily}`,
    monospaceCell: `${size} ${monospaceFamily}`,
  };
}
