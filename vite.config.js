// Vite config. After Phase 8 Sub-PR 10, the Vite build IS the only
// frontend the deployed app serves. The legacy concatenated unified
// app is gone; `public/index.html` is now the Vite entry HTML and
// `public/assets/*` are the per-route hashed JS + CSS chunks Rollup
// emits. Vercel serves `/` and `/assets/*` directly with no shim,
// no redirect, no second build.
//
// `emptyOutDir: false` because outDir lives outside the project root
// (we point it at the repo's `public/`) and we share that folder with
// `public/auth/callback.html` (the magic-link return URL) which must
// not be wiped between builds. The package.json `build` script does
// `rm -rf public/assets public/index.html public/v3-app` first so
// Vite always writes a fresh tree without piling up stale chunks.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname, "src/v3-app"),
  base: "/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "public"),
    emptyOutDir: false,
    sourcemap: true,
    target: "es2020",
    rollupOptions: {
      output: {
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
    include: ["**/*.{test,spec}.{js,jsx,ts,tsx}"],
    setupFiles: ["./test-setup.ts"],
  },
});
