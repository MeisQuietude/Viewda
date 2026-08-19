import { describe, expect, it, vi } from "vitest";

import { createGridClipboard } from "./grid-clipboard";

const contents = {
  textPlain: "one\ttwo",
  textHtml: "<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>",
};

class TestClipboardItem {
  constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
}

describe("grid clipboard capability", () => {
  it("writes both formats after detecting rich clipboard support", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = createGridClipboard({
      clipboard: () => ({ write, writeText }),
      clipboardItem: () => TestClipboardItem as unknown as typeof ClipboardItem,
    });

    await expect(clipboard.write(contents)).resolves.toBe("rich");

    const item = write.mock.calls[0]?.[0]?.[0] as TestClipboardItem;
    expect(Object.keys(item.data).sort()).toEqual(["text/html", "text/plain"]);
    await expect(item.data["text/plain"]).resolves.toEqual(
      expect.objectContaining({ type: "text/plain" }),
    );
    await expect(item.data["text/html"]).resolves.toEqual(
      expect.objectContaining({ type: "text/html" }),
    );
    expect(writeText).not.toHaveBeenCalled();
  });

  it("starts rich clipboard access before unloaded contents resolve", async () => {
    let resolveContents!: (value: typeof contents) => void;
    const unloadedContents = new Promise<typeof contents>((resolve) => {
      resolveContents = resolve;
    });
    const write = vi.fn().mockResolvedValue(undefined);
    const clipboard = createGridClipboard({
      clipboard: () => ({ write, writeText: vi.fn() }),
      clipboardItem: () => TestClipboardItem as unknown as typeof ClipboardItem,
    });

    const result = clipboard.write(unloadedContents);
    expect(write).toHaveBeenCalledOnce();
    const item = write.mock.calls[0]?.[0]?.[0] as TestClipboardItem;
    resolveContents(contents);

    await expect(result).resolves.toBe("rich");
    await expect(item.data["text/html"]).resolves.toEqual(
      expect.objectContaining({ type: "text/html" }),
    );
  });

  it.each(["NotSupportedError", "DataError"])(
    "caches plain mode after a %s capability failure",
    async (name) => {
      const write = vi
        .fn()
        .mockRejectedValueOnce(new DOMException("unsupported", name));
      const writeText = vi.fn().mockResolvedValue(undefined);
      const clipboard = createGridClipboard({
        clipboard: () => ({ write, writeText }),
        clipboardItem: () =>
          TestClipboardItem as unknown as typeof ClipboardItem,
      });

      await expect(clipboard.write(contents)).resolves.toBe("plain");
      await expect(clipboard.write(contents)).resolves.toBe("plain");

      expect(write).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledTimes(2);
      expect(writeText).toHaveBeenNthCalledWith(1, contents.textPlain);
    },
  );

  it("does not downgrade rich mode after a transient permission failure", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("expired", "NotAllowedError"))
      .mockResolvedValueOnce(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = createGridClipboard({
      clipboard: () => ({ write, writeText }),
      clipboardItem: () => TestClipboardItem as unknown as typeof ClipboardItem,
    });

    await expect(clipboard.write(contents)).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    await expect(clipboard.write(contents)).resolves.toBe("rich");
    expect(write).toHaveBeenCalledTimes(2);
    expect(writeText).not.toHaveBeenCalled();
  });

  it("uses plain text consistently when rich APIs are absent", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = createGridClipboard({
      clipboard: () => ({ write: undefined, writeText }) as never,
      clipboardItem: () => undefined,
    });

    await expect(clipboard.write(contents)).resolves.toBe("plain");
    expect(writeText).toHaveBeenCalledWith(contents.textPlain);
  });
});
