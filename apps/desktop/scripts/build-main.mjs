/**
 * Bundles the main process and the preload.
 *
 * esbuild rather than `tsc` because the two privileged entry points should be
 * single files with no module resolution left to do at runtime: whatever
 * works in `npm run dev` then works identically inside the asar archive.
 *
 * `electron` and every `node:` builtin stay external - they are provided by
 * the runtime, and `node:sqlite` in particular must resolve to Electron's own
 * builtin rather than be inlined by anything.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  // Electron 44 embeds Node 24; targeting it keeps the output readable and
  // lets modern syntax through untouched.
  target: 'node24',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  packages: 'bundle',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

const targets = [
  { entry: join(root, 'src/electron/main.ts'), out: join(root, 'dist/electron/main.js') },
  { entry: join(root, 'src/electron/preload.ts'), out: join(root, 'dist/electron/preload.js') },
];

for (const target of targets) {
  const options = { ...common, entryPoints: [target.entry], outfile: target.out };
  if (watch) {
    const context = await (await import('esbuild')).context(options);
    await context.watch();
  } else {
    await build(options);
  }
}

if (!watch) console.log('main and preload bundled');
