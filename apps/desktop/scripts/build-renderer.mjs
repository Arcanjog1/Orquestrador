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
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(root, 'dist-renderer');
mkdirSync(out, { recursive: true });

/** Weights the design actually uses, in the one format Chromium needs. */
const FONT_FILES = [
  ['@fontsource/manrope', 'manrope-latin-400-normal.woff2'],
  ['@fontsource/manrope', 'manrope-latin-500-normal.woff2'],
  ['@fontsource/manrope', 'manrope-latin-600-normal.woff2'],
  ['@fontsource/manrope', 'manrope-latin-700-normal.woff2'],
  ['@fontsource/jetbrains-mono', 'jetbrains-mono-latin-400-normal.woff2'],
  ['@fontsource/jetbrains-mono', 'jetbrains-mono-latin-500-normal.woff2'],
];

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
  // The approved design imports itself as `@/…` and the contract as
  // `@shared/…`; the same two aliases the renderer tsconfig declares.
  alias: {
    '@': join(root, 'src/renderer'),
    '@shared': join(root, 'src/shared'),
  },
});

// The approved design is authored in Tailwind v4, whose tokens and utilities
// live in the stylesheet itself. esbuild has no Tailwind step, so the sheet is
// compiled first and linked from the page - the bundle stays a single script
// under `script-src 'self'`, exactly as before.
// Resolved rather than assumed: npm workspaces hoist to the repository root,
// so the package is not reliably under apps/desktop/node_modules.
// The package exposes no importable entry, only a bin, so resolve its
// package.json and take the directory. Works hoisted or not.
const tailwind = join(
  dirname(createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json')),
  'dist/index.mjs',
);
execFileSync(
  process.execPath,
  [tailwind, '--input', join(root, 'src/renderer/styles.css'), '--output', join(out, 'styles.css')],
  { stdio: 'inherit', cwd: root },
);

// The two typefaces the design specifies, copied next to the stylesheet.
// Bundled rather than fetched: a packaged desktop app cannot depend on Google
// Fonts being reachable, and the CSP forbids it anyway. Both are SIL OFL 1.1.
const fonts = join(out, 'fonts');
mkdirSync(fonts, { recursive: true });
for (const [pkg, file] of FONT_FILES) {
  const pkgJson = createRequire(import.meta.url).resolve(`${pkg}/package.json`);
  copyFileSync(join(dirname(pkgJson), 'files', file), join(fonts, file));
}

copyFileSync(join(root, 'src/renderer/index.html'), join(out, 'index.html'));
console.log('renderer bundle written to', out);
