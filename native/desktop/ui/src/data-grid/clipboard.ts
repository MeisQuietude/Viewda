import type { CopyBufferContents } from "./grid-model";

export function writeClipboardContents(
  contents: Promise<CopyBufferContents | null>,
): Promise<void> {
  const clipboard = navigator.clipboard;
  const writeText = async () => {
    const resolved = await contents;
    if (resolved === null) {
      return;
    }
    if (clipboard?.writeText === undefined) {
      throw new Error("The system clipboard is unavailable.");
    }
    await clipboard.writeText(resolved.textPlain);
  };

  if (clipboard?.write === undefined || typeof ClipboardItem === "undefined") {
    return writeText();
  }

  try {
    const item = new ClipboardItem({
      "text/plain": contents.then((resolved) =>
        copyBlob(resolved, "textPlain", "text/plain"),
      ),
      "text/html": contents.then((resolved) =>
        copyBlob(resolved, "textHtml", "text/html"),
      ),
    });
    return clipboard.write([item]).catch(writeText);
  } catch {
    return writeText();
  }
}

function copyBlob(
  contents: CopyBufferContents | null,
  key: keyof CopyBufferContents,
  type: string,
): Blob {
  if (contents === null) {
    throw new DOMException("The copy operation was cancelled.", "AbortError");
  }
  return new Blob([contents[key]], { type });
}
