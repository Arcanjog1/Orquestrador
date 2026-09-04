/**
 * Runs the packaged application's self-check.
 *
 * Finds the binary electron-builder produced, launches it with
 * AI_ORCHESTRATOR_SMOKE=1 and reports what it says. This is the check that
 * proves `node:sqlite` survives packaging - the one blocker the previous phase
 * left open - rather than only working in a dev tree.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const release = resolve(here, '..', 'release');

function findBinary() {
  if (!existsSync(release)) return null;
  // Only ever a binary this machine can actually execute: a Linux box may hold
  // a win-unpacked payload from a cross-build, and running it would prove
  // nothing.
  const candidates =
    process.platform === 'win32'
      ? [join(release, 'win-unpacked', 'AI Orchestrator.exe')]
      : [
          join(release, 'linux-unpacked', 'ai-orchestrator'),
          join(release, 'linux-unpacked', 'AI Orchestrator'),
        ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;

  // Fall back to whatever single executable the unpacked directory holds.
  const wanted = process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked';
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name !== wanted) continue;
    const dir = join(release, entry.name);
    for (const file of readdirSync(dir)) {
      const executable = process.platform === 'win32' ? file.endsWith('.exe') : /^ai-orchestrator$/i.test(file);
      if (executable) {
        return join(dir, file);
      }
    }
  }
  return null;
}

const binary = findBinary();
if (!binary) {
  console.error(`No packaged build found under ${release}. Run "npm run package:dir" first.`);
  process.exit(1);
}
console.log(`# packaged binary: ${binary}`);

const args = [binary, '--no-sandbox'];
const needsXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const command = needsXvfb ? 'xvfb-run' : args.shift();
if (needsXvfb) args.unshift('-a');

const result = spawnSync(command, args, {
  stdio: 'inherit',
  env: { ...process.env, AI_ORCHESTRATOR_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
process.exit(result.status ?? 1);
