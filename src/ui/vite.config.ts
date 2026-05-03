import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The frontend lives at src/ui — Vite is rooted here so all asset paths
  // resolve naturally. The output goes to the repo's dist/ui so the runtime
  // UiServer can serve it from the standard `dist/` layout.
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, "..", "..", "dist", "ui"),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    // Dev server proxies /api and /ws to the local UiServer.
    proxy: {
      "/api": "http://127.0.0.1:4321",
      "/ws": { target: "ws://127.0.0.1:4321", ws: true },
    },
  },
});
