import { describe, expect, it, vi } from "vitest";

import { createGridClipboard } from "./grid-clipboard";

const contents = {
  textPlain: "one\ttwo",
  textHtml: "<table><tbody><tr><td>one</td><td>two</td></tr></tbody></table>",
};

class TestClipboardItem {
  constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
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

  it("finishes a newer Peek write after an older rich grid write", async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    const write = vi.fn(() => {
      calls.push("grid");
      return first.promise;
    });
    const writeText = vi.fn(async () => {
      calls.push("peek");
    });
    const clipboard = createGridClipboard({
      clipboard: () => ({ write, writeText }),
      clipboardItem: () => TestClipboardItem as unknown as typeof ClipboardItem,
    });

    const grid = clipboard.write(contents);
    const peek = clipboard.writeText("newer JSON");
    expect(calls).toEqual(["grid"]);
    first.resolve();

    await expect(grid).resolves.toBe("rich");
    await expect(peek).resolves.toBe("plain");
    expect(calls).toEqual(["grid", "peek"]);
    expect(writeText).toHaveBeenCalledWith("newer JSON");
  });

  it("finishes a newer rich grid write after an older Peek write", async () => {
    const first = deferred<void>();
    const calls: string[] = [];
    const writeText = vi.fn(() => {
      calls.push("peek");
      return first.promise;
    });
    const write = vi.fn(async () => {
      calls.push("grid");
    });
    const clipboard = createGridClipboard({
      clipboard: () => ({ write, writeText }),
      clipboardItem: () => TestClipboardItem as unknown as typeof ClipboardItem,
    });

    const peek = clipboard.writeText("older JSON");
    const grid = clipboard.write(contents);
    expect(calls).toEqual(["peek"]);
    first.resolve();

    await expect(peek).resolves.toBe("plain");
    await expect(grid).resolves.toBe("rich");
    expect(calls).toEqual(["peek", "grid"]);
  });

  it("registers Peek intent before preparation so a newer grid copy stays last", async () => {
    const prepared = deferred<string>();
    const calls: string[] = [];
    const writeText = vi.fn(async (text: string) => {
      calls.push(text);
    });
    const clipboard = createGridClipboard({
      clipboard: () => ({ write: undefined, writeText }) as never,
      clipboardItem: () => undefined,
    });

    const peek = clipboard.writeText(prepared.promise);
    const grid = clipboard.write(contents);
    expect(calls).toEqual([]);
    prepared.resolve("older JSON");

    await expect(peek).resolves.toBe("plain");
    await expect(grid).resolves.toBe("plain");
    expect(calls).toEqual(["older JSON", contents.textPlain]);
  });

  it("continues the write tail after an older system write rejects", async () => {
    const first = deferred<void>();
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(undefined);
    const clipboard = createGridClipboard({
      clipboard: () => ({ write: undefined, writeText }) as never,
      clipboardItem: () => undefined,
    });

    const older = clipboard.writeText("older");
    const newer = clipboard.writeText("newer");
    const olderRejected = expect(older).rejects.toMatchObject({
      name: "NotAllowedError",
    });
    first.reject(new DOMException("denied", "NotAllowedError"));

    await olderRejected;
    await expect(newer).resolves.toBe("plain");
    expect(writeText).toHaveBeenNthCalledWith(2, "newer");
  });
});
