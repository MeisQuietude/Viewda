import { describe, expect, it, vi } from "vitest";

import {
  BUNDLED_EMOJI_FONT_FAMILY,
  loadBundledEmojiFont,
  MONOSPACE_FONT_FAMILY,
  UI_FONT_FAMILY,
} from "./fonts";

describe("emoji font fallback", () => {
  it("keeps native emoji before the generic family and bundled fallback after it", () => {
    for (const [fontFamily, genericFamily] of [
      [UI_FONT_FAMILY, "sans-serif"],
      [MONOSPACE_FONT_FAMILY, "monospace"],
    ] as const) {
      const families = fontFamily.split(", ");
      expect(fontFamily).toContain('"Apple Color Emoji"');
      expect(fontFamily).toContain('"Segoe UI Emoji"');
      expect(fontFamily).toContain('"Noto Color Emoji"');
      expect(fontFamily).toContain(`"${BUNDLED_EMOJI_FONT_FAMILY}"`);
      expect(families.indexOf('"Apple Color Emoji"')).toBeLessThan(
        families.indexOf(genericFamily),
      );
      expect(families.indexOf(genericFamily)).toBeLessThan(
        families.indexOf(`"${BUNDLED_EMOJI_FONT_FAMILY}"`),
      );
    }
  });

  it("loads bundled emoji subsets without waiting for font events", async () => {
    const systemLoad = vi.fn(async () => undefined);
    const bundledLoad = vi.fn(async () => undefined);
    const failedBundledLoad = vi.fn(async () => {
      throw new Error("font unavailable");
    });

    await expect(
      loadBundledEmojiFont([
        { family: "Noto Color Emoji", load: systemLoad },
        {
          family: `"${BUNDLED_EMOJI_FONT_FAMILY}"`,
          load: bundledLoad,
        },
        {
          family: BUNDLED_EMOJI_FONT_FAMILY,
          load: failedBundledLoad,
        },
      ]),
    ).resolves.toBe(true);
    expect(systemLoad).not.toHaveBeenCalled();
    expect(bundledLoad).toHaveBeenCalledOnce();
    expect(failedBundledLoad).toHaveBeenCalledOnce();
  });

  it("reports when no bundled emoji subset can be loaded", async () => {
    await expect(
      loadBundledEmojiFont([
        {
          family: BUNDLED_EMOJI_FONT_FAMILY,
          load: () => Promise.reject(new Error("font unavailable")),
        },
      ]),
    ).resolves.toBe(false);
  });
});
