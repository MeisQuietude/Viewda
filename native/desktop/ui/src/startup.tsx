import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./App";
import { applyDocumentTheme, type ThemePreference } from "./theme";

export async function startApplication(
  root: HTMLElement,
  showMainWindow: () => Promise<void>,
  getThemePreference: () => Promise<ThemePreference>,
): Promise<Root> {
  let themePreference: ThemePreference = "system";
  try {
    themePreference = await getThemePreference();
  } catch {
    // A damaged local preference must not prevent the application from opening.
  }
  applyDocumentTheme(themePreference);

  const application = createRoot(root);

  flushSync(() => {
    application.render(
      <StrictMode>
        <App initialTheme={themePreference} />
      </StrictMode>,
    );
  });
  void showMainWindow();

  return application;
}
