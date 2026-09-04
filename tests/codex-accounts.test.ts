/**
 * Codex accounts.
 *
 * The same guarantees the Claude account manager makes, against a different
 * CLI: each account gets its own CODEX_HOME, an inherited token can never
 * satisfy an account, and removal cannot escape the profiles folder.
 *
 * Everything the manager knows about the CLI was read from a real
 * codex-cli 0.153.0: `codex login status` prints "Not logged in", `codex login
 * --device-auth` exists, and CODEX_HOME must exist before the CLI will start.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAccountManager, extractDeviceCode, extractUrl } from '../src/accounts/codex-account-manager.js';
import { ensureAppPaths, type AppPaths } from '../src/runtime/paths.js';
import type { RuntimeManager } from '../src/runtime/runtime-manager.js';
import type { ProcessManager, RunProcessOptions, ProcessResult } from '../src/process/process-manager.js';
import type { Account } from '../src/accounts/account-types.js';
import { SENSITIVE_ENV_KEYS } from '../src/security/secret-redactor.js';

const ACCOUNT: Account = {
  id: 'acc-codex-1',
  providerId: 'openai',
  displayName: 'Codex Trabalho',
  createdAt: '2026-09-04T00:00:00.000Z',
};

function fixture(responses: (options: RunProcessOptions) => Partial<ProcessResult>): {
  manager: CodexAccountManager;
  paths: AppPaths;
  calls: RunProcessOptions[];
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'lao-codex-acc-'));
  const paths = ensureAppPaths({
    root,
    runtimes: join(root, 'runtimes'),
    profiles: join(root, 'profiles'),
    data: join(root, 'data'),
    logs: join(root, 'logs'),
    artifacts: join(root, 'artifacts'),
    updates: join(root, 'updates'),
    staging: join(root, 'staging'),
  });

  const calls: RunProcessOptions[] = [];
  const processManager = {
    async run(options: RunProcessOptions): Promise<ProcessResult> {
      calls.push(options);
      const scripted = responses(options);
      // The real ProcessManager streams as the child writes, and `connect`
      // watches that stream for the sign-in URL. A fake that only returns at
      // the end would never show it one.
      if (scripted.stdout) options.onStdout?.(scripted.stdout);
      if (scripted.stderr) options.onStderr?.(scripted.stderr);
      return {
        outcome: 'completed',
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
        ...scripted,
      } as ProcessResult;
    },
    async cancelAll(): Promise<void> {},
    get liveCount(): number {
      return 0;
    },
  } as unknown as ProcessManager;

  const runtimeManager = {
    async getExecutablePath() {
      return '/managed/codex.exe';
    },
  } as unknown as RuntimeManager;

  return {
    manager: new CodexAccountManager({ runtimeManager, paths, processManager }),
    paths,
    calls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('each account gets its own CODEX_HOME inside the application folder', () => {
  const f = fixture(() => ({}));
  try {
    f.manager.createAccount(ACCOUNT);
    const other = f.manager.createAccount({ ...ACCOUNT, id: 'acc-codex-2', displayName: 'Pessoal' });

    const a = f.manager.profileDirectory(ACCOUNT.id);
    const b = f.manager.profileDirectory(other.id);
    assert.notEqual(a, b);
    assert.ok(a.startsWith(f.paths.profiles));
    assert.ok(existsSync(a) && existsSync(b));
    assert.equal(f.manager.buildEnvironment(ACCOUNT.id)['CODEX_HOME'], a);
    assert.deepEqual(f.manager.listProfileDirectories(), ['acc-codex-1', 'acc-codex-2']);
  } finally {
    f.cleanup();
  }
});

test('an inherited token is deleted, so it cannot satisfy every account at once', () => {
  const f = fixture(() => ({}));
  try {
    const env = f.manager.buildEnvironment(ACCOUNT.id);
    for (const key of SENSITIVE_ENV_KEYS) {
      assert.equal(env[key], undefined, `${key} must be deleted from the child environment`);
      assert.ok(key in env, `${key} must be explicitly unset, not merely absent`);
    }
    // The one that specifically defeats Codex isolation.
    assert.ok('CODEX_ACCESS_TOKEN' in env);
    assert.ok('OPENAI_API_KEY' in env);
  } finally {
    f.cleanup();
  }
});

test('"Not logged in" is reported as disconnected, with an action', async () => {
  const f = fixture((options) =>
    (options.args ?? []).join(' ') === 'login status' ? { stdout: 'Not logged in\n' } : {},
  );
  try {
    f.manager.createAccount(ACCOUNT);
    const status = await f.manager.getStatus(ACCOUNT);
    assert.equal(status.state, 'disconnected');
    assert.equal(status.remedy, 'Conectar conta');

    // And it was asked under this account's own home.
    const call = f.calls.find((c) => (c.args ?? []).join(' ') === 'login status')!;
    assert.equal(call.env?.['CODEX_HOME'], f.manager.profileDirectory(ACCOUNT.id));
  } finally {
    f.cleanup();
  }
});

test('logged in without a credential of its own is ambient, never connected', async () => {
  const f = fixture(() => ({ stdout: 'Logged in using ChatGPT\n' }));
  try {
    f.manager.createAccount(ACCOUNT);
    // No auth.json in the profile: something outside it satisfied the CLI.
    const status = await f.manager.getStatus(ACCOUNT);
    assert.equal(status.state, 'ambient-credential');
    assert.match(status.problem ?? '', /não é desta conta/i);
  } finally {
    f.cleanup();
  }
});

test('logged in with its own credential is connected', async () => {
  const f = fixture(() => ({ stdout: 'Logged in using ChatGPT\n' }));
  try {
    f.manager.createAccount(ACCOUNT);
    writeFileSync(join(f.manager.profileDirectory(ACCOUNT.id), 'auth.json'), '{}', 'utf8');
    const status = await f.manager.getStatus(ACCOUNT);
    assert.equal(status.state, 'connected');
  } finally {
    f.cleanup();
  }
});

test('a missing Codex runtime is reported as such, not as a failed login', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lao-codex-acc-'));
  const paths = ensureAppPaths({
    root,
    runtimes: join(root, 'runtimes'),
    profiles: join(root, 'profiles'),
    data: join(root, 'data'),
    logs: join(root, 'logs'),
    artifacts: join(root, 'artifacts'),
    updates: join(root, 'updates'),
    staging: join(root, 'staging'),
  });
  const runtimeManager = {
    async getExecutablePath() {
      throw Object.assign(new Error('not installed'), { userMessage: 'x' });
    },
  } as unknown as RuntimeManager;

  try {
    const manager = new CodexAccountManager({ runtimeManager, paths });
    const status = await manager.getStatus(ACCOUNT);
    assert.equal(status.state, 'runtime-missing');
    assert.equal(status.remedy, 'Configurar automaticamente');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the sign-in is device-code driven when the build offers it', async () => {
  const f = fixture((options) => {
    const args = (options.args ?? []).join(' ');
    if (args === 'login --help') return { stdout: '  --device-auth\n' };
    if (args === 'login --device-auth') {
      return { stdout: 'Open https://auth.openai.com/device and enter ABCD-EFGH\n' };
    }
    return { stdout: 'Not logged in\n' };
  });

  try {
    f.manager.createAccount(ACCOUNT);
    const opened: string[] = [];
    const progress: Array<{ phase: string; url?: string; code?: string }> = [];

    await f.manager.connect(ACCOUNT, {
      openUrl: (url) => {
        opened.push(url);
      },
      onProgress: (p) => progress.push({ phase: p.phase, ...(p.url ? { url: p.url } : {}), ...(p.code ? { code: p.code } : {}) }),
      urlTimeoutMs: 3000,
      completionTimeoutMs: 1500,
    });

    // The flag was detected, not assumed.
    assert.ok(f.calls.some((c) => (c.args ?? []).join(' ') === 'login --help'));
    assert.ok(f.calls.some((c) => (c.args ?? []).join(' ') === 'login --device-auth'));

    // The application opened the browser; the user copied nothing.
    assert.deepEqual(opened, ['https://auth.openai.com/device']);
    const awaiting = progress.find((p) => p.phase === 'awaiting-browser');
    assert.equal(awaiting?.url, 'https://auth.openai.com/device');
    assert.equal(awaiting?.code, 'ABCD-EFGH', 'the confirmation code is shown to the user');
  } finally {
    f.cleanup();
  }
});

test('a build without --device-auth falls back to the plain login', async () => {
  const f = fixture((options) => {
    const args = (options.args ?? []).join(' ');
    if (args === 'login --help') return { stdout: '  -h, --help\n' };
    return { stdout: 'Not logged in\n' };
  });
  try {
    f.manager.createAccount(ACCOUNT);
    await f.manager.connect(ACCOUNT, { urlTimeoutMs: 300, completionTimeoutMs: 600 });
    assert.ok(f.calls.some((c) => (c.args ?? []).join(' ') === 'login'));
    assert.ok(!f.calls.some((c) => (c.args ?? []).includes('--device-auth')));
  } finally {
    f.cleanup();
  }
});

test('removal refuses any path outside the profiles folder', () => {
  const f = fixture(() => ({}));
  try {
    assert.throws(() => f.manager.removeAccount('../../etc'), /não foi possível remover/i);
  } finally {
    f.cleanup();
  }
});

test('the URL and device code are pulled out of real-looking CLI output', () => {
  const output = 'To finish, open https://auth.openai.com/device?x=1 and enter WXYZ-1234.';
  assert.equal(extractUrl(output), 'https://auth.openai.com/device?x=1');
  assert.equal(extractDeviceCode(output), 'WXYZ-1234');
  assert.equal(extractUrl('nothing here'), null);
  assert.equal(extractDeviceCode('nothing here'), null);
});
