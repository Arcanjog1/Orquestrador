/**
 * The IPC boundary.
 *
 * These tests are the reason the boundary can be trusted: they assert that the
 * contract, the preload and the router describe the same closed set of
 * operations, that no generic escape hatch is exposed, and that a payload the
 * validator dislikes never reaches a service.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_CHANNELS,
  REQUEST_CHANNELS,
} from '../apps/desktop/src/shared/ipc-contract.js';
import {
  IpcValidationError,
  REQUEST_VALIDATORS,
  absolutePath,
  obj,
  repositoryUrl,
  str,
} from '../apps/desktop/src/shared/validation.js';
import { buildApi, type BridgeTransport } from '../apps/desktop/src/preload/bridge.js';
import { createDesktopFixture } from './helpers/desktop-fixture.js';

/* -------------------------------------------------------------- contract */

test('every request channel has a validator, and every validator a channel', () => {
  const validated = Object.keys(REQUEST_VALIDATORS).sort();
  assert.deepEqual(validated, [...REQUEST_CHANNELS].sort());
});

test('the router implements exactly the channels the contract declares', async () => {
  const fixture = createDesktopFixture();
  try {
    assert.deepEqual([...fixture.router.channels].sort(), [...REQUEST_CHANNELS].sort());
  } finally {
    await fixture.cleanup();
  }
});

/* --------------------------------------------------------------- preload */

function fakeTransport(): BridgeTransport & { calls: Array<{ channel: string; payload: unknown }> } {
  const calls: Array<{ channel: string; payload: unknown }> = [];
  return {
    calls,
    async invoke(channel, payload) {
      calls.push({ channel, payload });
      return { ok: true, value: `value-for-${channel}` };
    },
    on() {
      return () => {};
    },
  };
}

test('the preload exposes one function per channel and nothing else', () => {
  const api = buildApi(fakeTransport()) as unknown as Record<string, Record<string, unknown>>;

  const exposed: string[] = [];
  for (const [group, methods] of Object.entries(api)) {
    if (group === 'events') continue;
    for (const method of Object.keys(methods)) exposed.push(`${group}.${method}`);
  }
  assert.deepEqual(exposed.sort(), [...REQUEST_CHANNELS].sort());

  assert.deepEqual(
    Object.keys(api['events'] as object).sort(),
    EVENT_CHANNELS.map((c) => {
      const [group, rest] = c.split(':') as [string, string];
      return `${group}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
    }).sort(),
  );
});

test('the preload exposes no generic command escape hatch', () => {
  const api = buildApi(fakeTransport()) as unknown as Record<string, Record<string, unknown>>;
  const forbidden = ['invoke', 'send', 'exec', 'shell', 'runCommand', 'ipcRenderer', 'require'];

  const names: string[] = Object.keys(api);
  for (const [group, methods] of Object.entries(api)) {
    if (typeof methods === 'object') names.push(...Object.keys(methods).map((m) => `${group}.${m}`));
  }
  for (const name of names) {
    const leaf = name.split('.').pop()!;
    assert.ok(!forbidden.includes(leaf), `bridge must not expose "${name}"`);
  }
});

test('a bridge call cannot choose its own channel', async () => {
  const transport = fakeTransport();
  const api = buildApi(transport) as unknown as {
    runtime: { diagnose: (payload?: unknown) => Promise<unknown> };
  };
  // Whatever the caller passes is a payload, never a channel.
  await api.runtime.diagnose('accounts.remove');
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0]!.channel, 'runtime.diagnose');
  assert.equal(transport.calls[0]!.payload, 'accounts.remove');
});

test('a rejection from main becomes a thrown IpcError, not a silent undefined', async () => {
  const api = buildApi({
    async invoke() {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'gone' } };
    },
    on: () => () => {},
  }) as unknown as { runtime: { diagnose: () => Promise<unknown> } };

  await assert.rejects(() => api.runtime.diagnose(), /gone/);
});

/* ------------------------------------------------------------ validation */

test('unknown properties are refused rather than quietly dropped', () => {
  const validate = obj<{ name: string }>({ name: str() });
  assert.throws(() => validate({ name: 'ok', extra: 1 }, 'x'), IpcValidationError);
});

test('prototype-polluting keys are refused', () => {
  const validate = REQUEST_VALIDATORS['accounts.create'];
  const payload = JSON.parse('{"name":"a","__proto__":{"admin":true}}');
  assert.throws(() => validate(payload, 'accounts.create'), IpcValidationError);
});

test('strings are bounded, so a renderer cannot send unbounded text', () => {
  const validate = REQUEST_VALIDATORS['chat.sendMessage'];
  assert.throws(
    () => validate({ sessionId: 'chat-1', text: 'x'.repeat(20_001) }, 'chat.sendMessage'),
    IpcValidationError,
  );
  assert.doesNotThrow(() => validate({ sessionId: 'chat-1', text: 'ok' }, 'chat.sendMessage'));
});

test('ids may not carry path separators or NUL bytes', () => {
  const validate = REQUEST_VALIDATORS['accounts.remove'];
  for (const bad of ['../../etc', 'a/b', 'a\\b', 'a\0b', '']) {
    assert.throws(() => validate({ accountId: bad }, 'accounts.remove'), IpcValidationError, bad);
  }
  assert.doesNotThrow(() => validate({ accountId: 'acc-12ab' }, 'accounts.remove'));
});

test('a workspace path must be absolute', () => {
  const validate = absolutePath();
  assert.throws(() => validate('relative/path', 'p'), IpcValidationError);
  assert.doesNotThrow(() => validate('/home/user/project', 'p'));
  assert.doesNotThrow(() => validate('C:\\Users\\me\\project', 'p'));
});

test('a repository URL that could be read as a flag is refused', () => {
  assert.throws(() => repositoryUrl('--upload-pack=touch /tmp/pwned', 'u'), IpcValidationError);
  assert.throws(() => repositoryUrl('https://host/a b', 'u'), IpcValidationError);
  assert.doesNotThrow(() => repositoryUrl('https://github.com/owner/repo.git', 'u'));
  assert.doesNotThrow(() => repositoryUrl('git@github.com:owner/repo.git', 'u'));
});

test('a channel that does not exist is rejected as data, not as a throw', async () => {
  const fixture = createDesktopFixture();
  try {
    const result = await fixture.router.handle('exec', { command: 'rm -rf /' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'UNKNOWN_CHANNEL');
  } finally {
    await fixture.cleanup();
  }
});

test('an invalid payload is refused before any service runs', async () => {
  const fixture = createDesktopFixture();
  try {
    const result = await fixture.router.handle('runtime.install', { runtimeId: 'bash' });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.error.code, 'INVALID_ARGUMENT');
  } finally {
    await fixture.cleanup();
  }
});

test('app.info reports the runtime facts the footer shows', async () => {
  const fixture = createDesktopFixture();
  try {
    const result = await fixture.router.handle('app.info', null);
    assert.equal(result.ok, true);
    const info = result.ok ? (result.value as Record<string, unknown>) : {};
    assert.equal(info['sqliteAvailable'], true);
    assert.equal(info['nodeVersion'], process.versions.node);
  } finally {
    await fixture.cleanup();
  }
});
