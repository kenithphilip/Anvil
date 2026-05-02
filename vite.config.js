// Vite config for the v3-app rewrite (Phase 8 Sub-PR 1).
//
// Lives alongside the legacy `node src/scripts/build-v3.mjs` pipeline so we
// can ship the Vite build under public/v3-app/ without breaking the existing
// public/v3.html. Once Sub-PR 4 cuts over, the legacy pipeline goes away and
// this config takes over the canonical v3 entry.
//
// Source root is src/v3-app/ (kept disjoint from src/v3/ so the legacy
// concatenation script does not pick up ESM modules and so Vite does not try
// to bundle the babel-standalone scripts).

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "src/v3-app"),
  base: "/v3-app/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "public/v3-app"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2020",
    rollupOptions: {
      output: {
        // Stable chunk names so a route maps cleanly to a chunk in the
        // network panel. Vite still hashes for cache busting.
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    alias: {
      "@v3": path.resolve(__dirname, "src/v3-app"),
      "@v3-lib": path.resolve(__dirname, "src/v3-app/lib"),
      "@v3-screens": path.resolve(__dirname, "src/v3-app/screens"),
    },
  },
  server: {
    port: 5180,
    strictPort: true,
    open: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    // vite.config sets root to src/v3-app; vitest scans relative to root.
    include: ["**/*.{test,spec}.{js,jsx,ts,tsx}"],
    setupFiles: ["./test-setup.ts"],
  },
});
