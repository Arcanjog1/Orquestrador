import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(root, "src/renderer"),
  // Relative, so the built page works from `file://` inside the packaged app.
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(root, "src/renderer"),
      "@shared": resolve(root, "src/shared"),
    },
  },
  build: {
    outDir: resolve(root, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome128",
    sourcemap: true,
  },
  server: { port: 5173, strictPort: true },
});
