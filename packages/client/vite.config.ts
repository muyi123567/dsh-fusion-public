import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {rollupOptions:{input:{main:resolve(import.meta.dirname,"index.html"),gallery:resolve(import.meta.dirname,"design-gallery.html"),dive:resolve(import.meta.dirname,"whale-dive.html")}}},
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
