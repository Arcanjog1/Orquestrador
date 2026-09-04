/**
 * Launches the Electron integration suite.
 *
 * On Linux CI there is no display, so the suite runs under `xvfb-run` when one
 * is available: the tests open a real BrowserWindow and there is no honest way
 * to check a window's security posture without one.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// Passed as a path relative to `root`, never as an absolute one and never as a
// file:// URL. An absolute Windows path reaches Node's ESM loader as
// "protocol 'd:'" and is refused; a file:// URL is taken by Electron as a page
// to open rather than an app to run. A relative path resolves against cwd on
// every platform.
const suite = 'tests/electron-integration.mjs';

const electron = require('electron');
if (typeof electron !== 'string' || !existsSync(electron)) {
  console.error(
    'The Electron binary is missing. Run `node node_modules/electron/install.js` first.',
  );
  process.exit(1);
}

const args = [electron, '--no-sandbox', suite];
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const command = needsXvfb ? 'xvfb-run' : args.shift();
if (needsXvfb) args.unshift('-a');

// Printed before the spawn so a job that stops here says where it stopped.
console.log(`# launching: ${command} ${args.join(' ')}`);
console.log(`# platform=${process.platform} display=${process.env.DISPLAY ?? '(none)'}`);

const result = spawnSync(command, args, {
  stdio: 'inherit',
  cwd: root,
  // The suite bounds each of its own checks, but a failure before the suite
  // loads is outside its reach, so the launch is bounded too.
  timeout: 10 * 60_000,
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});

if (result.error) {
  console.error(`# electron did not run cleanly: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
