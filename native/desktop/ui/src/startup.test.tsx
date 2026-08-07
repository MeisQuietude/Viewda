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
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

it("applies the saved theme before showing the rendered application", async () => {
  vi.spyOn(desktop, "getEngineStatus").mockReturnValue(new Promise(() => {}));
  vi.spyOn(desktop, "onOpenSourceRequested").mockReturnValue(
    new Promise(() => {}),
  );
  vi.spyOn(desktop, "syncSystemTheme").mockResolvedValue();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );

  const root = document.createElement("div");
  const showMainWindow = vi.fn(() => {
    expect(root.querySelector(".app-shell")).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe("dark");
    return Promise.resolve();
  });
  const getThemePreference = vi.fn(() => Promise.resolve("dark" as const));

  await act(async () => {
    application = await startApplication(
      root,
      showMainWindow,
      getThemePreference,
    );
  });

  expect(getThemePreference).toHaveBeenCalledOnce();
  expect(showMainWindow).toHaveBeenCalledOnce();
});
