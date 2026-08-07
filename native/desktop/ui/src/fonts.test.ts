import { describe, expect, it, vi } from "vitest";

import { BUNDLED_EMOJI_FONT_FAMILY, loadBundledEmojiFont } from "./fonts";

describe("emoji font fallback", () => {
  it("loads the bundled emoji font without waiting for font events", async () => {
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

  it("reports when the bundled emoji font cannot be loaded", async () => {
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
