/**
 * Payload validation.
 *
 * A renderer can be compromised, and `ipcRenderer.invoke` will carry any
 * structured clone. TypeScript is a description of the contract, not an
 * enforcement of it, so everything crossing the bridge is re-checked. These
 * tests are the evidence that it is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ValidationError,
  deriveAccountId,
  expectNoPayload,
  isInvokeChannel,
  parseAccountId,
  parseCreateAccount,
  parseRuntimeId,
} from '../apps/desktop/src/shared/validation.js';

const CHANNEL = 'runtime:install';

function rejects(fn: () => unknown, why: string): void {
  assert.throws(fn, (err: unknown) => err instanceof ValidationError, why);
}

test('only declared channels are recognised', () => {
  assert.ok(isInvokeChannel('runtime:diagnose'));
  assert.ok(!isInvokeChannel('runtime:exec'));
  assert.ok(!isInvokeChannel('__proto__'));
  assert.ok(!isInvokeChannel(42));
  assert.ok(!isInvokeChannel(null));
});

test('a runtime id outside the known set is refused', () => {
  assert.deepEqual(parseRuntimeId({ runtimeId: 'codex' }, CHANNEL), { runtimeId: 'codex' });
  assert.deepEqual(parseRuntimeId({ runtimeId: 'claude-code' }, CHANNEL), {
    runtimeId: 'claude-code',
  });

  rejects(() => parseRuntimeId({ runtimeId: 'bash' }, CHANNEL), 'unknown runtime');
  rejects(() => parseRuntimeId({ runtimeId: '../../etc/passwd' }, CHANNEL), 'traversal');
  rejects(() => parseRuntimeId({ runtimeId: 42 }, CHANNEL), 'wrong type');
  rejects(() => parseRuntimeId({}, CHANNEL), 'missing');
  rejects(() => parseRuntimeId(null, CHANNEL), 'null payload');
  rejects(() => parseRuntimeId('codex', CHANNEL), 'a bare string is not a payload');
  rejects(() => parseRuntimeId(['codex'], CHANNEL), 'an array is not a payload');
});

test('an account id can never name a path outside the profiles folder', () => {
  assert.deepEqual(parseAccountId({ accountId: 'claude-trabalho' }, CHANNEL), {
    accountId: 'claude-trabalho',
  });

  for (const hostile of [
    '../escape',
    '..',
    '.',
    'a/b',
    'a\\b',
    'C:\\Windows',
    '/etc/passwd',
    'conta.',
    '-leading',
    'UPPER',
    'com espaco',
    '',
    'a'.repeat(65),
  ]) {
    rejects(
      () => parseAccountId({ accountId: hostile }, CHANNEL),
      `${JSON.stringify(hostile)} must be refused: it names a directory`,
    );
  }
});

test('a new account is refused unless the name is usable', () => {
  assert.deepEqual(parseCreateAccount({ providerId: 'anthropic', displayName: '  Claude Trabalho  ' }, CHANNEL), {
    providerId: 'anthropic',
    displayName: 'Claude Trabalho',
  });

  rejects(() => parseCreateAccount({ providerId: 'evil', displayName: 'x' }, CHANNEL), 'provider');
  rejects(() => parseCreateAccount({ providerId: 'anthropic', displayName: '   ' }, CHANNEL), 'blank');
  rejects(() => parseCreateAccount({ providerId: 'anthropic', displayName: 42 }, CHANNEL), 'type');
  rejects(
    () => parseCreateAccount({ providerId: 'anthropic', displayName: 'a'.repeat(65) }, CHANNEL),
    'too long',
  );
  rejects(
    () => parseCreateAccount({ providerId: 'anthropic', displayName: 'linha\nquebrada' }, CHANNEL),
    'control characters corrupt logs and layout alike',
  );
});

test('channels that take nothing are called with nothing', () => {
  assert.doesNotThrow(() => expectNoPayload(undefined, 'runtime:diagnose'));
  assert.doesNotThrow(() => expectNoPayload(null, 'runtime:diagnose'));
  rejects(() => expectNoPayload({ runtimeId: 'codex' }, 'runtime:diagnose'), 'unexpected payload');
});

test('a validation failure carries a sentence for the user and a detail for the log', () => {
  try {
    parseRuntimeId({ runtimeId: 'bash' }, CHANNEL);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    assert.ok(err.userMessage.length > 0);
    assert.ok(!/runtimeId|must be one of/.test(err.userMessage), 'the user sees no field names');
    assert.match(err.detail, /runtimeId must be one of/, 'the log keeps the real reason');
  }
});

test('account ids are derived by the application, never taken from the user', () => {
  assert.equal(deriveAccountId('Claude Trabalho'), 'claude-trabalho');
  assert.equal(deriveAccountId('Conta Pessoal'), 'conta-pessoal');

  // Accents, punctuation and separators all collapse to the closed charset.
  assert.equal(deriveAccountId('Conta Ação/Teste'), 'conta-acao-teste');
  assert.equal(deriveAccountId('../../etc/passwd'), 'etc-passwd');
  assert.equal(deriveAccountId('C:\\Windows\\System32'), 'c-windows-system32');
  assert.equal(deriveAccountId('...'), 'conta', 'a name with nothing usable falls back');
  assert.equal(deriveAccountId('   '), 'conta');

  // Whatever comes out must survive the validator that guards the bridge.
  for (const name of ['Claude Trabalho', '../../etc/passwd', '...', '🙂', 'A'.repeat(200)]) {
    const id = deriveAccountId(name);
    assert.doesNotThrow(
      () => parseAccountId({ accountId: id }, CHANNEL),
      `derived id ${JSON.stringify(id)} must itself be valid`,
    );
  }
});

test('a derived id never collides with one already in use', () => {
  assert.equal(deriveAccountId('Claude', ['claude']), 'claude-2');
  assert.equal(deriveAccountId('Claude', ['claude', 'claude-2']), 'claude-3');
});
