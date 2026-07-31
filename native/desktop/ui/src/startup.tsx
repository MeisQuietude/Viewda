import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { App } from "./App";

export function startApplication(
  root: HTMLElement,
  showMainWindow: () => Promise<void>,
): Root {
  const application = createRoot(root);

  flushSync(() => {
    application.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
  void showMainWindow();

  return application;
}
