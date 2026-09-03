/**
 * The router, end to end, without Electron.
 *
 * `dispatch` is deliberately an ordinary async function, so the contract
 * between the bridge and the services can be tested for real: a request in, a
 * result out, and never an exception crossing the boundary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountError } from '../src/accounts/account-types.js';
import { RuntimeError } from '../src/runtime/types.js';
import { DatabaseUnavailableError } from '../src/database/driver.js';
import { dispatch } from '../apps/desktop/src/main/ipc/router.js';
import type { AppServices } from '../apps/desktop/src/main/app-services.js';

interface Recorded {
  calls: string[];
  logs: string[];
}

/**
 * A stand-in for the real services.
 *
 * Only the surface the router touches is implemented; anything else being
 * reached would be a bug the cast cannot hide, because the call would throw.
 */
function fakeServices(overrides: Record<string, unknown> = {}): AppServices & Recorded {
  const calls: string[] = [];
  const logs: string[] = [];

  const services = {
    calls,
    logs,
    log: (line: string) => logs.push(line),
    appInfo: () => {
      calls.push('appInfo');
      return { name: 'AI Orchestrator', version: '0.1.0' };
    },
    bootstrapState: () => {
      calls.push('bootstrapState');
      return { databaseReady: true, schemaVersion: 1 };
    },
    runtime: {
      diagnose: async () => {
        calls.push('diagnose');
        return { ready: true, runtimes: [], pending: [], checkedAt: 'now' };
      },
      install: async (runtimeId: string) => {
        calls.push(`install:${runtimeId}`);
        return { runtimeId, displayName: 'Codex', version: '1.0.0', healthy: true, rolledBack: false };
      },
      repair: async (runtimeId: string) => {
        calls.push(`repair:${runtimeId}`);
        return { runtimeId, displayName: 'Codex', version: '1.0.0', healthy: true, rolledBack: false };
      },
      cancelInstall: (runtimeId: string) => {
        calls.push(`cancel:${runtimeId}`);
        return { cancelled: true };
      },
    },
    accounts: {
      list: () => {
        calls.push('list');
        return [];
      },
      create: (providerId: string, displayName: string) => {
        calls.push(`create:${providerId}:${displayName}`);
        return { id: 'conta', providerId, displayName, createdAt: 'now' };
      },
      remove: (accountId: string) => {
        calls.push(`remove:${accountId}`);
        return { removed: true };
      },
      status: async (accountId: string) => {
        calls.push(`status:${accountId}`);
        return { accountId, displayName: 'x', state: 'disconnected', checkedAt: 'now' };
      },
      connect: async (accountId: string) => {
        calls.push(`connect:${accountId}`);
        return { accountId, displayName: 'x', state: 'connected', checkedAt: 'now' };
      },
      cancelConnect: (accountId: string) => {
        calls.push(`cancelConnect:${accountId}`);
        return { cancelled: true };
      },
    },
    ...overrides,
  };

  return services as unknown as AppServices & Recorded;
}

test('a valid request reaches its service and comes back wrapped', async () => {
  const services = fakeServices();

  const diagnosis = await dispatch(services, 'runtime:diagnose', undefined);
  assert.equal(diagnosis.ok, true);
  assert.deepEqual(services.calls, ['diagnose']);

  const install = await dispatch(services, 'runtime:install', { runtimeId: 'codex' });
  assert.equal(install.ok, true);
  assert.ok(services.calls.includes('install:codex'));
});

test('an unknown channel is refused without reaching anything', async () => {
  const services = fakeServices();
  const result = await dispatch(services, 'runtime:exec', { command: 'rm -rf /' });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'INVALID_REQUEST');
  assert.deepEqual(services.calls, [], 'no service may be touched by an unknown channel');
  assert.ok(services.logs.some((line) => line.includes('unknown channel')));
});

test('an invalid payload never reaches the service', async () => {
  const services = fakeServices();

  for (const payload of [
    { runtimeId: 'bash' },
    { runtimeId: '../../etc/passwd' },
    { runtimeId: null },
    {},
    null,
    'codex',
  ]) {
    const result = await dispatch(services, 'runtime:install', payload);
    assert.equal(result.ok, false, `${JSON.stringify(payload)} should be refused`);
    if (!result.ok) assert.equal(result.code, 'INVALID_REQUEST');
  }

  assert.deepEqual(services.calls, [], 'validation runs before the service, not after');
});

test('a channel that takes nothing refuses a payload', async () => {
  const services = fakeServices();
  const result = await dispatch(services, 'runtime:diagnose', { runtimeId: 'codex' });
  assert.equal(result.ok, false);
  assert.deepEqual(services.calls, []);
});

test('a runtime failure crosses as a sentence and a remedy, never a stack', async () => {
  const services = fakeServices({
    runtime: {
      install: async () => {
        throw new RuntimeError(
          'codex',
          'Codex ainda não está configurado.',
          'Configurar automaticamente',
          'spawn ENOENT at C:\\Users\\x\\AppData\\Local',
        );
      },
    },
  });

  const result = await dispatch(services, 'runtime:install', { runtimeId: 'codex' });
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.code, 'RUNTIME_ERROR');
  assert.equal(result.userMessage, 'Codex ainda não está configurado.');
  assert.equal(result.remedy, 'Configurar automaticamente');
  assert.ok(!JSON.stringify(result).includes('spawn'), 'the developer detail stays behind');
  assert.ok(!JSON.stringify(result).includes('AppData'));
});

test('an account failure keeps its own remedy', async () => {
  const services = fakeServices({
    accounts: {
      connect: async () => {
        throw new AccountError('conta', 'Esta conta não existe mais.', 'Atualizar', 'no row');
      },
    },
  });

  const result = await dispatch(services, 'accounts:connect', { accountId: 'conta' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'ACCOUNT_ERROR');
  assert.equal(result.remedy, 'Atualizar');
});

test('a database failure is named as one, so the screen can react to it', async () => {
  const services = fakeServices({
    accounts: {
      list: () => {
        throw new DatabaseUnavailableError('x', 'y', 'z');
      },
    },
  });

  const result = await dispatch(services, 'accounts:list', undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'DATABASE_ERROR');
});

test('an unexpected error is reported without its text', async () => {
  const services = fakeServices({
    runtime: {
      diagnose: async () => {
        throw new Error('ENOENT: no such file /home/user/.config/secret-token');
      },
    },
  });

  const result = await dispatch(services, 'runtime:diagnose', undefined);
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.code, 'INTERNAL');
  assert.ok(
    !JSON.stringify(result).includes('secret-token'),
    'an unexpected message is the likeliest place for a path or a secret to leak',
  );
  assert.ok(services.logs.some((line) => line.includes('secret-token')), 'the log still has it');
});

test('nothing thrown by a service escapes the bridge', async () => {
  const services = fakeServices({
    runtime: {
      diagnose: async () => {
        throw 'a bare string, not an Error';
      },
    },
  });

  const result = await dispatch(services, 'runtime:diagnose', undefined);
  assert.equal(result.ok, false);
});
