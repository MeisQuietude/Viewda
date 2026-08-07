import "@fontsource-variable/noto-emoji/wght.css";

export const BUNDLED_EMOJI_FONT_FAMILY = "Noto Emoji Variable";

const PLATFORM_EMOJI_FONT_FAMILIES =
  '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

export const UI_FONT_FAMILY = `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", ${PLATFORM_EMOJI_FONT_FAMILIES}, sans-serif, "${BUNDLED_EMOJI_FONT_FAMILY}"`;

export const MONOSPACE_FONT_FAMILY = `ui-monospace, "SFMono-Regular", Consolas, ${PLATFORM_EMOJI_FONT_FAMILIES}, monospace, "${BUNDLED_EMOJI_FONT_FAMILY}"`;

interface LoadableFontFace {
  readonly family: string;
  load(): Promise<unknown>;
}

export async function loadBundledEmojiFont(
  fonts: Iterable<LoadableFontFace>,
): Promise<boolean> {
  const emojiFonts = Array.from(fonts).filter(
    (font) => unquoteFontFamily(font.family) === BUNDLED_EMOJI_FONT_FAMILY,
  );
  const results = await Promise.allSettled(
    emojiFonts.map((font) => font.load()),
  );
  return results.some((result) => result.status === "fulfilled");
}

function unquoteFontFamily(family: string): string {
  return family.replace(/^(["'])(.*)\1$/, "$2");
}
