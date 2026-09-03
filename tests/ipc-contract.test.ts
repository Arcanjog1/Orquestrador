/**
 * The shape of the bridge.
 *
 * These tests are about what the renderer *cannot* reach as much as what it
 * can. A channel that lets a web page hand the main process a command to run
 * would undo the whole point of the architecture, so the absence is asserted
 * rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  PHASE_TO_STEP,
} from '../apps/desktop/src/shared/ipc-contract.js';
import { HANDLERS, missingHandlers } from '../apps/desktop/src/main/ipc/router.js';

const DESKTOP = join(process.cwd(), 'apps', 'desktop');

test('every declared channel has a handler', () => {
  assert.deepEqual(missingHandlers(), [], 'a channel with no handler is a hole in the contract');
  assert.equal(Object.keys(HANDLERS).length, INVOKE_CHANNELS.length);
});

test('no handler exists for a channel that was never declared', () => {
  for (const channel of Object.keys(HANDLERS)) {
    assert.ok(
      (INVOKE_CHANNELS as readonly string[]).includes(channel),
      `${channel} is handled but not declared, so it would never be reviewed`,
    );
  }
});

test('the bridge exposes no way to run an arbitrary command', () => {
  const forbidden = [
    'exec',
    'shell',
    'spawn',
    'runCommand',
    'run',
    'command',
    'invoke',
    'eval',
    'terminal',
    'powershell',
    'cmd',
    'readFile',
    'writeFile',
    'query',
    'sql',
  ];

  for (const channel of INVOKE_CHANNELS) {
    const operation = channel.split(':')[1] ?? '';
    assert.ok(
      !forbidden.includes(operation),
      `${channel} names a generic capability; channels must name one specific operation`,
    );
  }
});

test('channels are namespaced, so a new one cannot be added by accident', () => {
  for (const channel of [...INVOKE_CHANNELS, ...EVENT_CHANNELS]) {
    assert.match(channel, /^(app|runtime|accounts):[a-zA-Z]+$/, `${channel} is off-pattern`);
  }
});

test('every install phase maps to a friendly step', () => {
  const phases = [
    'resolving',
    'downloading',
    'verifying',
    'extracting',
    'staging-health-check',
    'installing',
    'health-check',
    'rolled-back',
    'done',
  ] as const;

  for (const phase of phases) {
    const step = PHASE_TO_STEP[phase];
    assert.ok(step, `${phase} has no user-facing step name`);
    // The interface shows the step; a raw phase name would leak the pipeline.
    assert.ok(!step.includes('-'), `${step} looks like a phase, not a label`);
  }
});

/* -------------------------------------------------------------------------- */
/* Source-level guarantees                                                     */
/*                                                                             */
/* The window options and the preload cannot be exercised without Electron,    */
/* so they are asserted against the source. A change that weakens them fails   */
/* here rather than in a review nobody ran.                                    */
/* -------------------------------------------------------------------------- */

function source(relative: string): string {
  return readFileSync(join(DESKTOP, relative), 'utf8');
}

test('the window is created with isolation on and node integration off', () => {
  const main = source('src/electron/main.ts');
  assert.match(main, /contextIsolation:\s*true/, 'contextIsolation must be true');
  assert.match(main, /nodeIntegration:\s*false/, 'nodeIntegration must be false');
  assert.match(main, /nodeIntegrationInWorker:\s*false/);
  assert.match(main, /nodeIntegrationInSubFrames:\s*false/);
  assert.match(main, /sandbox:\s*true/, 'the renderer must stay sandboxed');
  assert.match(main, /webSecurity:\s*true/);
  assert.match(main, /webviewTag:\s*false/);

  assert.doesNotMatch(main, /contextIsolation:\s*false/);
  assert.doesNotMatch(main, /nodeIntegration:\s*true/);
});

test('the main process refuses navigation and extra windows', () => {
  const main = source('src/electron/main.ts');
  assert.match(main, /setWindowOpenHandler/, 'a link must not become a privileged window');
  assert.match(main, /action:\s*'deny'/);
  assert.match(main, /will-navigate/, 'the renderer must not be able to navigate away');
  assert.match(main, /setPermissionRequestHandler/);
});

test('the preload hands the page named operations, not Electron itself', () => {
  const preload = source('src/electron/preload.ts');
  assert.match(preload, /contextBridge\.exposeInMainWorld/);

  // Exposing ipcRenderer, or a passthrough invoke, would recreate the generic
  // channel the contract is designed to prevent.
  assert.doesNotMatch(
    preload,
    /exposeInMainWorld\([^)]*ipcRenderer\s*\)/,
    'ipcRenderer must never be handed to the page',
  );
  for (const forbidden of ['child_process', 'node:fs', 'node:child_process', 'require(']) {
    assert.ok(!preload.includes(forbidden), `the preload must not reach for ${forbidden}`);
  }
});

test('the sign-in URL is not part of what the renderer receives', () => {
  const contract = source('src/shared/ipc-contract.ts');
  const loginEvent = contract.slice(
    contract.indexOf('export interface LoginProgressEvent'),
    contract.indexOf('/** Every failure crosses the bridge'),
  );
  assert.ok(loginEvent.length > 0, 'LoginProgressEvent should be in the contract');
  assert.ok(
    !/^\s*url[?]?:/m.test(loginEvent),
    'the sign-in URL can carry a one-time code and must stay in the main process',
  );
  assert.match(loginEvent, /browserOpened: boolean/);
});
