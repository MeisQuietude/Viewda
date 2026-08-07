// @vitest-environment node

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

interface TauriConfig {
  app: {
    windows: Array<{
      label: string;
      backgroundColor?: string;
      visible?: boolean;
    }>;
  };
}

interface Capability {
  permissions: string[];
}

it("keeps the main window hidden until its styled UI is ready", () => {
  const config = JSON.parse(
    readFileSync(new URL("../../tauri.conf.json", import.meta.url), "utf8"),
  ) as TauriConfig;
  const mainWindow = config.app.windows.find(({ label }) => label === "main");

  expect(mainWindow?.visible).toBe(false);
  expect(mainWindow?.backgroundColor).toMatch(/^#[\da-f]{6}$/i);

  const document = readFileSync(
    new URL("../index.html", import.meta.url),
    "utf8",
  );
  expect(document).toContain(
    `--app-background: ${mainWindow?.backgroundColor};`,
  );
  expect(document).toMatch(
    /:root\[data-theme="dark"\][^{]*\{[^}]*--app-background:\s*#141617;/s,
  );
  expect(document).toMatch(
    /@media \(prefers-color-scheme: dark\)[^{]*\{\s*:root:not\(\[data-theme\]\)/s,
  );

  const capability = JSON.parse(
    readFileSync(
      new URL("../../capabilities/default.json", import.meta.url),
      "utf8",
    ),
  ) as Capability;
  expect(capability.permissions).toContain("core:window:allow-show");
});
