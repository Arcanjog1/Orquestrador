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
import {
  CodexAccountManager,
  extractDeviceCode,
  extractUrl,
  stripAnsi,
} from '../src/accounts/codex-account-manager.js';
import { ProcessManager as RealProcessManager } from '../src/process/process-manager.js';
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
  /** How often the whole manager was cancelled - which a sign-in must never do. */
  readonly cancelAllCalls: number;
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
  let cancelAllCalls = 0;
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
    async cancelAll(): Promise<void> {
      cancelAllCalls += 1;
    },
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
    get cancelAllCalls() {
      return cancelAllCalls;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Exactly what codex-cli 0.153.0 prints for `codex login --device-auth`
 * (login/src/device_code_auth.rs, `device_code_prompt`), colour codes and all.
 * The constants are unconditional in the CLI, so a pipe receives them too.
 */
const ANSI_BLUE = '\x1b[94m';
const ANSI_GRAY = '\x1b[90m';
const ANSI_RESET = '\x1b[0m';
const DEVICE_PROMPT =
  `\nWelcome to Codex [v${ANSI_GRAY}0.153.0${ANSI_RESET}]\n${ANSI_GRAY}OpenAI's command-line coding agent${ANSI_RESET}\n` +
  '\nFollow these steps to sign in with ChatGPT using device code authorization:\n' +
  `\n1. Open this link in your browser and sign in to your account\n   ${ANSI_BLUE}https://auth.openai.com/codex/device${ANSI_RESET}\n` +
  `\n2. Enter this one-time code ${ANSI_GRAY}(expires in 15 minutes)${ANSI_RESET}\n   ${ANSI_BLUE}ABCD-EFGH${ANSI_RESET}\n` +
  `\n${ANSI_GRAY}Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.${ANSI_RESET}\n`;

/** What the browser flow prints (cli/src/login.rs): the callback server first. */
const BROWSER_PROMPT =
  'Starting local login server on http://localhost:1455.\n' +
  'If your browser did not open, navigate to this URL to authenticate:\n\n' +
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s\n\n' +
  'On a remote or headless machine? Use `codex login --device-auth` instead.\n';

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

/* ------------------------------------------------------------------------ *
 * The Windows sign-in that never finished.
 *
 * Observed on the installed build: the browser opened, the person signed in,
 * and landed on the ChatGPT home page while the application kept waiting.
 * The CLI had printed the device-flow prompt with its colour codes, the URL
 * handed to the browser ended in the reset sequence, and the code the person
 * would have had to type was never found in the text at all. These tests use
 * the CLI's real prompt, byte for byte.
 * ------------------------------------------------------------------------ */

test('the real 0.153.0 device-auth prompt yields a clean URL and the code', () => {
  assert.equal(extractUrl(DEVICE_PROMPT), 'https://auth.openai.com/codex/device');
  assert.equal(extractDeviceCode(DEVICE_PROMPT), 'ABCD-EFGH');
  // Neither carries a trace of the colour codes that wrapped them.
  assert.doesNotMatch(extractUrl(DEVICE_PROMPT)!, /\x1b/);
  assert.equal(stripAnsi(`${ANSI_BLUE}x${ANSI_RESET}`), 'x');
  // A longer code shape, should the service ever issue one, is read too.
  assert.equal(extractDeviceCode(`code ${ANSI_BLUE}ABCDE-FGHIJ${ANSI_RESET}\n`), 'ABCDE-FGHIJ');
});

test('the browser flow prompt yields the sign-in address, not the local callback', () => {
  assert.equal(
    extractUrl(BROWSER_PROMPT),
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s',
  );
});

test('a real device-flow sign-in opens the right page, shows the code and completes under one CODEX_HOME', async () => {
  let signedIn = false;
  const f = fixture((options) => {
    const args = (options.args ?? []).join(' ');
    if (args === 'login --help') return { stdout: '  --device-auth\n' };
    if (args === 'login --device-auth') return { stdout: DEVICE_PROMPT };
    if (args === 'login status') {
      return signedIn ? { stdout: 'Logged in using ChatGPT\n' } : { stdout: 'Not logged in\n', exitCode: 1 };
    }
    return {};
  });

  try {
    f.manager.createAccount(ACCOUNT);
    const opened: string[] = [];
    const phases: string[] = [];
    let shownCode: string | undefined;

    // The person completes the browser step a moment after the page opens:
    // the CLI then writes the credential into this account's home.
    const result = await f.manager.connect(ACCOUNT, {
      openUrl: (url) => {
        opened.push(url);
        setTimeout(() => {
          writeFileSync(join(f.manager.profileDirectory(ACCOUNT.id), 'auth.json'), '{}', 'utf8');
          signedIn = true;
        }, 300);
      },
      onProgress: (p) => {
        phases.push(p.phase);
        if (p.code) shownCode = p.code;
      },
      urlTimeoutMs: 3000,
      completionTimeoutMs: 10_000,
    });

    assert.deepEqual(opened, ['https://auth.openai.com/codex/device'], 'exactly the page the CLI named');
    assert.equal(shownCode, 'ABCD-EFGH', 'the one-time code reaches the interface');
    assert.equal(result.state, 'connected');
    assert.deepEqual(phases, ['starting', 'awaiting-browser', 'waiting-for-completion', 'connected']);

    // Login and every status check ran under the same CODEX_HOME - the one the
    // account owns - so the credential written by one is what the other sees.
    const home = f.manager.profileDirectory(ACCOUNT.id);
    const codexCalls = f.calls.filter((c) => (c.args ?? [])[0] === 'login' && (c.args ?? [])[1] !== '--help');
    assert.ok(codexCalls.length >= 2);
    for (const call of codexCalls) assert.equal(call.env?.['CODEX_HOME'], home);
    assert.equal(f.cancelAllCalls, 0, 'a successful sign-in never touches other processes');
  } finally {
    f.cleanup();
  }
});

test('giving up on a sign-in stops only that sign-in, and the manager keeps working', async () => {
  // A real ProcessManager and a stand-in codex. The manager runs every codex
  // command with the application root as its working directory, so a script
  // named `login` there is what `node login ...` resolves to: `--help` offers
  // the device flow, `--device-auth` prints the real prompt and then waits as
  // the CLI does, and `status` says "Not logged in".
  const root = mkdtempSync(join(tmpdir(), 'lao-codex-real-pm-'));
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
  writeFileSync(
    join(root, 'login'),
    [
      "const args = process.argv.slice(2).join(' ');",
      "if (args === '--help') { console.log('  --device-auth'); process.exit(0); }",
      "if (args === 'status') { console.log('Not logged in'); process.exit(1); }",
      "if (args === '--device-auth') { console.log(" + JSON.stringify(DEVICE_PROMPT) + '); setTimeout(() => {}, 60_000); }',
    ].join('\n'),
    'utf8',
  );

  const processManager = new RealProcessManager();
  const runtimeManager = {
    async getExecutablePath() {
      return process.execPath;
    },
  } as unknown as RuntimeManager;
  const manager = new CodexAccountManager({ runtimeManager, paths, processManager });

  try {
    manager.createAccount(ACCOUNT);
    const opened: string[] = [];
    const result = await manager.connect(ACCOUNT, {
      openUrl: (url) => {
        opened.push(url);
      },
      urlTimeoutMs: 15_000,
      completionTimeoutMs: 2_500,
    });

    // The page was the right one, and nobody signed in, so the attempt failed.
    assert.deepEqual(opened, ['https://auth.openai.com/codex/device']);
    assert.equal(result.state, 'disconnected');

    // The sign-in process was stopped - it was still waiting - and nothing
    // else was: the manager accepts new work, and the next status check gets
    // a real answer rather than a refusal.
    assert.equal(processManager.liveCount, 0, 'the sign-in process did not outlive the attempt');
    assert.equal(processManager.isCancelled, false, 'giving up did not cancel the whole manager');
    const after = await manager.getStatus(ACCOUNT);
    assert.equal(after.state, 'disconnected');
    assert.equal(after.remedy, 'Conectar conta', 'the CLI answered; the check was not refused');
  } finally {
    await processManager.cancelAll(1000);
    rmSync(root, { recursive: true, force: true });
  }
});
