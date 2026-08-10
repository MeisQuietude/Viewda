import "./emoji-font.css";

export const BUNDLED_EMOJI_FONT_FAMILY = "Noto Emoji";

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
