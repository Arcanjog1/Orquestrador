import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The renderer build.
 *
 * `base: './'` matters: the packaged window loads the page from a `file://`
 * URL inside the asar archive, where absolute asset paths do not resolve.
 */
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    target: 'chrome152',
    sourcemap: true,
  },
  server: { port: 5273, strictPort: true },
});
