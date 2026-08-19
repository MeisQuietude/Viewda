import type { CopyBufferContents } from "./grid-model";

export type ClipboardMode = "rich" | "plain";

interface ClipboardEnvironment {
  clipboard(): Pick<Clipboard, "write" | "writeText"> | undefined;
  clipboardItem(): typeof ClipboardItem | undefined;
}

export interface GridClipboard {
  write(
    contents: CopyBufferContents | Promise<CopyBufferContents>,
  ): Promise<ClipboardMode>;
}

const browserClipboardEnvironment: ClipboardEnvironment = {
  clipboard: () => navigator.clipboard,
  clipboardItem: () => globalThis.ClipboardItem,
};

/** Keeps clipboard capability classification stable for the lifetime of its webview. */
export function createGridClipboard(
  environment: ClipboardEnvironment = browserClipboardEnvironment,
): GridClipboard {
  let mode: ClipboardMode | undefined;

  return {
    async write(contents) {
      const clipboard = environment.clipboard();
      const ClipboardItemConstructor = environment.clipboardItem();
      const resolvedContents = Promise.resolve(contents);
      mode ??=
        clipboard?.write !== undefined && ClipboardItemConstructor !== undefined
          ? "rich"
          : "plain";

      if (
        mode === "rich" &&
        clipboard?.write !== undefined &&
        ClipboardItemConstructor !== undefined
      ) {
        try {
          const item = new ClipboardItemConstructor({
            "text/plain": resolvedContents.then(
              ({ textPlain }) => new Blob([textPlain], { type: "text/plain" }),
            ),
            "text/html": resolvedContents.then(
              ({ textHtml }) => new Blob([textHtml], { type: "text/html" }),
            ),
          });
          await clipboard.write([item]);
          return mode;
        } catch (error) {
          if (!isRichCapabilityFailure(error)) {
            throw error;
          }
          mode = "plain";
        }
      }

      if (clipboard?.writeText === undefined) {
        throw new Error("The system clipboard is unavailable.");
      }
      await clipboard.writeText((await resolvedContents).textPlain);
      return "plain";
    },
  };
}

function isRichCapabilityFailure(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotSupportedError" || error.name === "DataError")
  );
}
