/**
 * Bundles the two pieces that cannot be plain `tsc` output.
 *
 * The preload must be CommonJS: a sandboxed preload is not loaded as an ES
 * module. The renderer must be a single file with React inlined, because the
 * page runs under a CSP that allows `script-src 'self'` only and has no
 * node_modules to resolve from.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(root, 'dist-renderer');
mkdirSync(out, { recursive: true });

const shared = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

await build({
  ...shared,
  entryPoints: [join(root, 'src/preload/preload.ts')],
  outfile: join(out, 'preload.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Provided by Electron at load time; bundling it would be wrong and would fail.
  external: ['electron'],
});

await build({
  ...shared,
  entryPoints: [join(root, 'src/renderer/main.tsx')],
  outfile: join(out, 'renderer.js'),
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  loader: { '.css': 'text' },
});

copyFileSync(join(root, 'src/renderer/index.html'), join(out, 'index.html'));
console.log('renderer bundle written to', out);
