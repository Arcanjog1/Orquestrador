import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { ClaudeAccountManager } from '../src/accounts/claude-account-manager.js';
import type { Account } from '../src/accounts/account-types.js';
import { appPaths, ensureAppPaths } from '../src/runtime/paths.js';
import { RuntimeManager } from '../src/runtime/runtime-manager.js';
import { RuntimeNotReadyError } from '../src/runtime/types.js';
import { ProcessManager } from '../src/process/process-manager.js';
import { makeFetch } from './helpers/fake-runtime-source.js';

const WORK: Account = {
  id: 'acc-work',
  providerId: 'anthropic',
  displayName: 'Claude Trabalho',
  createdAt: '2026-09-01T00:00:00.000Z',
};
const PERSONAL: Account = {
  id: 'acc-personal',
  providerId: 'anthropic',
  displayName: 'Claude Pessoal',
  createdAt: '2026-09-01T00:00:00.000Z',
};

/**
 * Builds the managers under test.
 *
 * `claudeExecutable` decides what the claude-code runtime resolves to:
 * `null` makes `getExecutablePath` throw, which is how a machine with no
 * runtime installed behaves. Stubbing it here keeps these tests independent of
 * whatever happens to be on the host's PATH.
 */
function makeManagers(home: string, claudeExecutable: string | null = process.execPath) {
  const paths = ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
  const runtimeManager = new RuntimeManager({ paths, fetchImpl: makeFetch({}) });

  const claude = runtimeManager.get('claude-code');
  Object.defineProperty(claude, 'getExecutablePath', {
    value: async () => {
      if (!claudeExecutable) throw new RuntimeNotReadyError('claude-code', 'Claude Code');
      return claudeExecutable;
    },
    writable: true,
  });

  const accounts = new ClaudeAccountManager({
    runtimeManager,
    paths,
    processManager: new ProcessManager(),
  });

  return { paths, runtimeManager, accounts };
}

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), 'lao-accounts-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('each account gets its own absolute configuration directory', () => {
  withHome((home) => {
    const { accounts, paths } = makeManagers(home);
    const workDir = accounts.profileDirectory(WORK.id);
    const personalDir = accounts.profileDirectory(PERSONAL.id);

    assert.ok(isAbsolute(workDir), 'the CLI rejects a relative CLAUDE_CONFIG_DIR');
    assert.ok(isAbsolute(personalDir));
    assert.notEqual(workDir, personalDir);
    assert.ok(workDir.startsWith(paths.profiles));
  });
});

test('the child environment sets the profile and strips ambient credentials', () => {
  withHome((home) => {
    const { accounts } = makeManagers(home);
    const env = accounts.buildEnvironment(WORK.id);

    assert.equal(env.CLAUDE_CONFIG_DIR, accounts.profileDirectory(WORK.id));
    // Deleted, not merely absent: an inherited key would override the profile.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      assert.ok(key in env, `${key} must be present as an explicit deletion`);
      assert.equal(env[key], undefined);
    }
  });
});

test('creating and removing an account only touches the app profiles folder', () => {
  withHome((home) => {
    const { accounts, paths } = makeManagers(home);
    accounts.createAccount(WORK);
    accounts.createAccount(PERSONAL);
    assert.deepEqual(accounts.listProfileDirectories(), ['acc-personal', 'acc-work']);

    accounts.removeAccount(WORK.id);
    assert.deepEqual(accounts.listProfileDirectories(), ['acc-personal']);
    assert.equal(existsSync(join(paths.profiles, 'acc-work')), false);
  });
});

test('credential presence is checked without reading the file', () => {
  withHome((home) => {
    const { accounts } = makeManagers(home);
    accounts.createAccount(WORK);
    assert.equal(accounts.hasOwnCredentials(WORK.id), false);

    writeFileSync(join(accounts.profileDirectory(WORK.id), '.credentials.json'), '{"secret":"x"}');
    assert.equal(accounts.hasOwnCredentials(WORK.id), true);
  });
});

test('two accounts never share a configuration home', () => {
  withHome((home) => {
    const { accounts } = makeManagers(home);
    accounts.createAccount(WORK);
    accounts.createAccount(PERSONAL);

    writeFileSync(join(accounts.profileDirectory(WORK.id), '.credentials.json'), '{}');

    // Signing one in leaves the other untouched.
    assert.equal(accounts.hasOwnCredentials(WORK.id), true);
    assert.equal(accounts.hasOwnCredentials(PERSONAL.id), false);

    const workEnv = accounts.buildEnvironment(WORK.id);
    const personalEnv = accounts.buildEnvironment(PERSONAL.id);
    assert.notEqual(workEnv.CLAUDE_CONFIG_DIR, personalEnv.CLAUDE_CONFIG_DIR);
  });
});

test('removing an account refuses paths outside the profiles folder', () => {
  withHome((home) => {
    const { accounts } = makeManagers(home);
    // Traversal in the id must not escape the profiles directory.
    assert.throws(
      () => accounts.removeAccount('../../etc'),
      /Não foi possível remover esta conta/,
    );
  });
});

test('a missing runtime is reported as such, not as a login problem', async () => {
  await withHome(async (home) => {
    const { accounts } = makeManagers(home, null);
    accounts.createAccount(WORK);

    const status = await accounts.getStatus(WORK);
    assert.equal(status.state, 'runtime-missing');
    assert.match(status.problem ?? '', /Claude Code ainda não está configurado/);
    assert.equal(status.remedy, 'Configurar automaticamente');
    assert.ok(!/PATH/i.test(status.problem ?? ''));
  });
});

test('an account whose CLI call fails is disconnected, with an action to take', async () => {
  await withHome(async (home) => {
    // Resolves to node, which does not understand `auth status`, so the check fails.
    const { accounts } = makeManagers(home);
    accounts.createAccount(WORK);

    const status = await accounts.getStatus(WORK);
    assert.equal(status.state, 'disconnected');
    assert.match(status.problem ?? '', /Claude Trabalho não está conectada/);
    assert.equal(status.remedy, 'Conectar');
  });
});

test('giving up on a sign-in stops only that sign-in, and the manager keeps working', async () => {
  // The same defect the Codex manager had: `connect` ended with a `cancelAll`
  // on the process manager shared by the whole application, which is sticky -
  // every later process, including the status check that would show the
  // account connected, was refused until restart. A real ProcessManager and a
  // stand-in claude: the manager runs `auth login` and `auth status --json`
  // with the application root as cwd, so a script named `auth` there is what
  // `node auth ...` resolves to.
  // Not `withHome`: that helper removes the folder as soon as the async body
  // has *started*, which would delete the stand-in before it is spawned.
  const home = mkdtempSync(join(tmpdir(), 'lao-accounts-giveup-'));
  try {
    const { accounts, paths } = makeManagers(home);
    writeFileSync(
      join(paths.root, 'auth'),
      [
        "const args = process.argv.slice(2).join(' ');",
        "if (args === 'status --json') { console.log(JSON.stringify({ loggedIn: false })); process.exit(0); }",
        "if (args === 'login') { console.log('Open https://claude.ai/login?code=abc to sign in'); setTimeout(() => {}, 60_000); }",
      ].join('\n'),
      'utf8',
    );
    accounts.createAccount(WORK);
    const opened: string[] = [];
    const manager = (accounts as unknown as { processManager: ProcessManager }).processManager;

    const result = await accounts.connect(WORK, {
      openUrl: (url) => {
        opened.push(url);
      },
      urlTimeoutMs: 15_000,
      completionTimeoutMs: 2_500,
    });
    assert.deepEqual(opened, ['https://claude.ai/login?code=abc']);
    assert.equal(result.state, 'disconnected');

    assert.equal(manager.liveCount, 0, 'the sign-in process did not outlive the attempt');
    assert.equal(manager.isCancelled, false, 'giving up did not cancel the whole manager');
    const after = await accounts.getStatus(WORK);
    assert.equal(after.state, 'disconnected', 'the CLI answered; the check was not refused');
    await manager.cancelAll(1000);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
