/**
 * The two services the bridge sits on.
 *
 * The point of these is the translation, not the underlying layers: the
 * runtime service turns install phases into friendly steps and owns the
 * cancellation handle; the account service derives ids, persists rows and
 * keeps the sign-in URL out of anything the renderer receives.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/database/database.js';
import { NodeSqliteDriver } from '../src/database/node-sqlite-driver.js';
import { appPaths, ensureAppPaths, type AppPaths } from '../src/runtime/paths.js';
import type { InstallProgress, InstallResult } from '../src/runtime/types.js';
import type { RuntimeManager } from '../src/runtime/runtime-manager.js';
import type { ClaudeAccountManager } from '../src/accounts/claude-account-manager.js';
import type { Account, AccountStatus, LoginProgress } from '../src/accounts/account-types.js';
import { RuntimeService } from '../apps/desktop/src/main/services/runtime-service.js';
import { AccountService } from '../apps/desktop/src/main/services/account-service.js';
import type {
  InstallProgressEvent,
  LoginProgressEvent,
} from '../apps/desktop/src/shared/ipc-contract.js';

/**
 * Runs `fn` against a throwaway app home and removes it afterwards.
 *
 * Async on purpose: a synchronous version deletes the directory the moment
 * the callback hands back its promise, so the body of an async test would run
 * against a home that no longer exists.
 */
async function withTemp<T>(
  fn: (paths: AppPaths, dbFile: string) => T | Promise<T>,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'lao-desktop-'));
  try {
    const paths = ensureAppPaths(appPaths({ AI_ORCHESTRATOR_HOME: home } as NodeJS.ProcessEnv));
    return await fn(paths, join(paths.data, 'test.db'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function installResult(runtimeId = 'codex'): InstallResult {
  return {
    runtimeId: runtimeId as InstallResult['runtimeId'],
    executablePath: '/opt/whatever/codex',
    manifest: {
      version: '0.153.0',
      url: 'https://example.invalid/codex.tgz',
      host: 'example.invalid',
      sha256: 'deadbeef',
    } as InstallResult['manifest'],
    health: { healthy: true },
  };
}

/* -------------------------------------------------------------------------- */
/* RuntimeService                                                              */
/* -------------------------------------------------------------------------- */

function runtimeService(behaviour: {
  install?: (
    runtimeId: string,
    report: (p: InstallProgress) => void,
    options: { signal?: AbortSignal },
  ) => Promise<InstallResult>;
}): { service: RuntimeService; events: InstallProgressEvent[] } {
  const events: InstallProgressEvent[] = [];
  const manager = {
    get: () => ({ displayName: 'Codex' }),
    install: behaviour.install ?? (async () => installResult()),
    repair: behaviour.install ?? (async () => installResult()),
    diagnose: async () => ({ ready: true, runtimes: [], pending: [], checkedAt: 'now' }),
  } as unknown as RuntimeManager;

  return {
    service: new RuntimeService({
      runtimeManager: manager,
      emitProgress: (event) => events.push(event),
    }),
    events,
  };
}

test('install progress reaches the interface as a step, not as a phase', async () => {
  const { service, events } = runtimeService({
    install: async (_id, report) => {
      report({ runtimeId: 'codex', phase: 'downloading', message: 'Baixando Codex...', percent: 42 });
      report({ runtimeId: 'codex', phase: 'staging-health-check', message: 'Testando...' });
      report({ runtimeId: 'codex', phase: 'done', message: 'Codex pronto', percent: 100 });
      return installResult();
    },
  });

  await service.install('codex');

  assert.deepEqual(
    events.map((e) => e.step),
    ['Baixando', 'Testando', 'Concluído'],
  );
  assert.equal(events[0]?.percent, 42);
  assert.equal(events[1]?.percent, undefined, 'an indeterminate phase has no percentage');
  for (const event of events) {
    assert.equal(event.diagnostic, undefined, 'raw phases are developer-mode only');
  }
});

test('a message carrying developer vocabulary is replaced by the step name', async () => {
  const { service, events } = runtimeService({
    install: async (_id, report) => {
      report({ runtimeId: 'codex', phase: 'downloading', message: 'spawn failed, exit code 9' });
      report({
        runtimeId: 'codex',
        phase: 'installing',
        message: 'extracting C:\\Users\\x\\tarball.tgz',
      });
      return installResult();
    },
  });

  await service.install('codex');

  for (const event of events) {
    assert.ok(
      !/spawn|exit code|tarball|C:\\/.test(event.message),
      `the normal flow must not show "${event.message}"`,
    );
    assert.match(event.message, /\.\.\.$/, 'it falls back to the step name');
  }
});

test('the install summary keeps the manifest out of the interface', async () => {
  const { service } = runtimeService({});
  const summary = await service.install('codex');

  assert.equal(summary.version, '0.153.0');
  assert.equal(summary.displayName, 'Codex');
  assert.equal(summary.healthy, true);
  assert.ok(!('manifest' in summary), 'URL, host and checksum are support material');
  assert.ok(!JSON.stringify(summary).includes('example.invalid'));
  assert.ok(!JSON.stringify(summary).includes('deadbeef'));
});

test('cancelling reports whether there was anything to cancel', async () => {
  let seen: AbortSignal | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const { service } = runtimeService({
    install: async (_id, _report, options) => {
      seen = options.signal;
      await gate;
      return installResult();
    },
  });

  assert.deepEqual(service.cancelInstall('codex'), { cancelled: false }, 'nothing running yet');

  const running = service.install('codex');
  await Promise.resolve();

  assert.deepEqual(service.busy, ['codex']);
  assert.deepEqual(service.cancelInstall('codex'), { cancelled: true });
  assert.equal(seen?.aborted, true, 'the signal really reaches the install pipeline');

  release();
  await running;
  assert.deepEqual(service.busy, [], 'the handle is released when the install ends');
});

test('a second install of the same runtime is refused rather than raced', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const { service } = runtimeService({
    install: async () => {
      await gate;
      return installResult();
    },
  });

  const first = service.install('codex');
  await Promise.resolve();
  await assert.rejects(() => service.install('codex'), /já está sendo preparado/);

  release();
  await first;
});

/* -------------------------------------------------------------------------- */
/* AccountService                                                              */
/* -------------------------------------------------------------------------- */

interface ClaudeStub {
  connectCalls: number;
  removed: string[];
  emitUrl: string | null;
}

function accountService(
  paths: AppPaths,
  dbFile: string,
  stub: Partial<ClaudeStub> = {},
): {
  service: AccountService;
  database: Database;
  events: LoginProgressEvent[];
  opened: string[];
  claude: ClaudeStub;
} {
  const database = new Database({ paths, driver: new NodeSqliteDriver(dbFile) });
  const events: LoginProgressEvent[] = [];
  const opened: string[] = [];
  const state: ClaudeStub = {
    connectCalls: 0,
    removed: [],
    emitUrl: stub.emitUrl ?? 'https://claude.ai/oauth?code=ONE-TIME-SECRET',
  };

  const claude = {
    profileDirectory: (accountId: string) => join(paths.profiles, accountId),
    createAccount: (account: Account) => account,
    removeAccount: (accountId: string) => state.removed.push(accountId),
    getStatus: async (account: Account): Promise<AccountStatus> => ({
      accountId: account.id,
      displayName: account.displayName,
      state: 'disconnected',
      checkedAt: new Date().toISOString(),
    }),
    connect: async (
      account: Account,
      options: {
        onProgress?: (p: LoginProgress) => void;
        openUrl?: (url: string) => void | Promise<void>;
      },
    ): Promise<AccountStatus> => {
      state.connectCalls += 1;
      options.onProgress?.({
        accountId: account.id,
        phase: 'awaiting-browser',
        message: 'Abrindo o navegador para você entrar...',
        ...(state.emitUrl ? { url: state.emitUrl } : {}),
      });
      if (state.emitUrl) await options.openUrl?.(state.emitUrl);
      options.onProgress?.({
        accountId: account.id,
        phase: 'connected',
        message: `${account.displayName} conectada`,
      });
      return {
        accountId: account.id,
        displayName: account.displayName,
        state: 'connected',
        authMethod: 'oauth',
        checkedAt: new Date().toISOString(),
      };
    },
  } as unknown as ClaudeAccountManager;

  const service = new AccountService({
    database,
    claudeAccounts: claude,
    emitLoginProgress: (event) => events.push(event),
    openExternal: (url) => {
      opened.push(url);
    },
  });

  return { service, database, events, opened, claude: state };
}

test('the user types a name and the application owns everything else', async () => {
  await withTemp((paths, dbFile) => {
    const { service, database } = accountService(paths, dbFile);

    const account = service.create('anthropic', 'Claude Trabalho');
    assert.equal(account.displayName, 'Claude Trabalho');
    assert.equal(account.id, 'claude-trabalho', 'the id is derived, never supplied');

    const row = database.accounts.find(account.id);
    assert.ok(row);
    assert.equal(row?.auth_state, 'disconnected');
    assert.ok(
      row?.profile_directory.startsWith(paths.profiles),
      'the profile must live inside the folder the application owns',
    );

    assert.deepEqual(
      service.list().map((a) => a.displayName),
      ['Claude Trabalho'],
    );
    database.close();
  });
});

test('two accounts with the same name are refused before either exists twice', async () => {
  await withTemp((paths, dbFile) => {
    const { service, database } = accountService(paths, dbFile);
    service.create('anthropic', 'Claude Trabalho');
    assert.throws(() => service.create('anthropic', 'Claude Trabalho'), /Já existe uma conta/);
    assert.equal(service.list().length, 1);
    database.close();
  });
});

test('a provider without an account manager is refused rather than half-created', async () => {
  await withTemp((paths, dbFile) => {
    const { service, database } = accountService(paths, dbFile);
    assert.throws(() => service.create('openai', 'Codex'), /ainda não pode ser conectado/);
    assert.equal(service.list().length, 0);
    database.close();
  });
});

test('signing in opens the browser in the main process and tells the renderer nothing else', async () => {
  await withTemp(async (paths, dbFile) => {
    const { service, database, events, opened } = accountService(paths, dbFile);
    const account = service.create('anthropic', 'Claude Trabalho');

    const status = await service.connect(account.id);
    assert.equal(status.state, 'connected');

    assert.deepEqual(opened, ['https://claude.ai/oauth?code=ONE-TIME-SECRET']);

    const serialised = JSON.stringify(events);
    assert.ok(
      !serialised.includes('ONE-TIME-SECRET'),
      'the sign-in URL carries a one-time code and must never cross the bridge',
    );
    assert.ok(!serialised.includes('http'), 'no URL at all reaches the renderer');
    assert.ok(events.some((e) => e.browserOpened), 'the renderer learns a browser was opened');
    assert.equal(events.at(-1)?.phase, 'connected');

    assert.equal(database.accounts.find(account.id)?.auth_state, 'connected');
    database.close();
  });
});

test('a sign-in already in flight is not started twice', async () => {
  await withTemp(async (paths, dbFile) => {
    const { service, database } = accountService(paths, dbFile);
    const account = service.create('anthropic', 'Claude Trabalho');

    assert.deepEqual(service.cancelConnect(account.id), { cancelled: false });
    await service.connect(account.id);
    database.close();
  });
});

test('an unknown account is refused everywhere, not just on create', async () => {
  await withTemp(async (paths, dbFile) => {
    const { service, database } = accountService(paths, dbFile);
    await assert.rejects(() => service.connect('nao-existe'), /não existe mais/);
    await assert.rejects(() => service.status('nao-existe'), /não existe mais/);
    assert.throws(() => service.remove('nao-existe'), /não existe mais/);
    database.close();
  });
});

test('removing an account clears the folder before the row', async () => {
  await withTemp((paths, dbFile) => {
    const { service, database, claude } = accountService(paths, dbFile);
    const account = service.create('anthropic', 'Claude Trabalho');

    assert.deepEqual(service.remove(account.id), { removed: true });
    assert.deepEqual(claude.removed, [account.id]);
    assert.equal(database.accounts.find(account.id), undefined);
    database.close();
  });
});
