import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules", "ui/dist"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      "e2e/**/*.js",
      "ui/src/**/*.{ts,tsx}",
      "vite.config.ts",
      "vitest.setup.ts",
    ],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["ui/src/**/*.{ts,tsx}"],
    ignores: ["ui/src/desktop.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tauri-apps/*"],
              message: "Import Tauri APIs only from ui/src/desktop.ts.",
            },
          ],
        },
      ],
    },
  },
);
