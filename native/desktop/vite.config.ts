import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: "ui",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  clearScreen: false,
  server: {
    host: host ?? false,
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/native/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["../vitest.setup.ts"],
  },
});
