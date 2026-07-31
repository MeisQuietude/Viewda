import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import * as desktop from "./desktop";
import { startApplication } from "./startup";

let application: Root | undefined;

afterEach(() => {
  if (application !== undefined) {
    act(() => application?.unmount());
    application = undefined;
  }
  vi.restoreAllMocks();
});

it("shows the native window only after the application is rendered", () => {
  vi.spyOn(desktop, "getEngineStatus").mockReturnValue(new Promise(() => {}));
  vi.spyOn(desktop, "onOpenSourceRequested").mockReturnValue(
    new Promise(() => {}),
  );

  const root = document.createElement("div");
  const showMainWindow = vi.fn(() => {
    expect(root.querySelector(".app-shell")).not.toBeNull();
    return Promise.resolve();
  });

  act(() => {
    application = startApplication(root, showMainWindow);
  });

  expect(showMainWindow).toHaveBeenCalledOnce();
});
