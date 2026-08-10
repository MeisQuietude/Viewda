import { afterEach, expect, it, vi } from "vitest";

import { writeClipboardContents } from "./clipboard";
import type { CopyBufferContents } from "./grid-model";

class TestClipboardItem {
  constructor(readonly data: Record<string, Promise<Blob>>) {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("falls back to plain text after a rejected rich clipboard write", async () => {
  const contents = deferred<CopyBufferContents>();
  const write = vi.fn().mockRejectedValue(new Error("rich write unavailable"));
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { write, writeText },
  });
  vi.stubGlobal("ClipboardItem", TestClipboardItem);

  const result = writeClipboardContents(contents.promise);
  expect(write).toHaveBeenCalledOnce();
  expect(writeText).not.toHaveBeenCalled();

  contents.resolve({ textPlain: "raw", textHtml: "<b>raw</b>" });
  await result;
  expect(writeText).toHaveBeenCalledWith("raw");
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
