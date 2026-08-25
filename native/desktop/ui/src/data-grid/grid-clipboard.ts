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
  writeText(text: string | Promise<string>): Promise<"plain">;
}

const browserClipboardEnvironment: ClipboardEnvironment = {
  clipboard: () => navigator.clipboard,
  clipboardItem: () => globalThis.ClipboardItem,
};

/**
 * Keeps clipboard capability stable and system writes ordered for the lifetime
 * of the webview. Browser clipboard calls cannot be canceled after acceptance,
 * so a newer intent waits and becomes the final write.
 */
export function createGridClipboard(
  environment: ClipboardEnvironment = browserClipboardEnvironment,
): GridClipboard {
  let mode: ClipboardMode | undefined;
  let tail: Promise<void> | null = null;

  const coordinate = <Result>(operation: () => Promise<Result>) => {
    const result =
      tail === null ? operation() : tail.then(operation, operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    tail = completion;
    void completion.then(() => {
      if (tail === completion) tail = null;
    });
    return result;
  };

  return {
    write(contents) {
      return coordinate(async () => {
        const clipboard = environment.clipboard();
        const ClipboardItemConstructor = environment.clipboardItem();
        const resolvedContents = Promise.resolve(contents);
        mode ??=
          clipboard?.write !== undefined &&
          ClipboardItemConstructor !== undefined
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
                ({ textPlain }) =>
                  new Blob([textPlain], { type: "text/plain" }),
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
        return "plain" as const;
      });
    },
    writeText(text) {
      return coordinate(async () => {
        const clipboard = environment.clipboard();
        if (clipboard?.writeText === undefined) {
          throw new Error("The system clipboard is unavailable.");
        }
        const resolvedText = typeof text === "string" ? text : await text;
        await clipboard.writeText(resolvedText);
        return "plain" as const;
      });
    },
  };
}

function isRichCapabilityFailure(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "NotSupportedError" || error.name === "DataError")
  );
}
