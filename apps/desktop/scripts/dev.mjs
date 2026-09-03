/**
 * Development loop: Vite for the renderer, esbuild in watch mode for the
 * privileged side, and one Electron process pointed at the dev server.
 *
 * The application still loads its preload from `dist/`, so what runs here is
 * the same bundle the packaged build ships.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const server = await createServer({ configFile: join(root, "vite.config.mts") });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) throw new Error('vite did not report a local URL');
server.printUrls();

const bundler = spawn(process.execPath, [join(here, 'build-main.mjs'), '--watch'], {
  cwd: root,
  stdio: 'inherit',
});

// Give the first bundle a moment to land before Electron looks for it.
await new Promise((resolve) => setTimeout(resolve, 1200));

const electron = spawn(
  join(root, 'node_modules', '.bin', 'electron'),
  [join(root, 'dist', 'electron', 'main.cjs')],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ORCHESTRATOR_DEV_SERVER_URL: url.replace(/\/$/, '') },
  },
);

const stop = async (code) => {
  bundler.kill();
  await server.close();
  process.exit(code ?? 0);
};

electron.on('exit', (code) => void stop(code ?? 0));
process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
